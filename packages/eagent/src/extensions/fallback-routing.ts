/**
 * fallback-routing — survive a provider outage by failing over a chain.
 *
 * EAgent runs ONE provider per run: the agent loop does
 * `this.providers.get(this.providerName)` at the top of every `streamTurn`, and a
 * provider whose stream throws (auth 401, rate-limit-exhausted 429, a 5xx after
 * retries, a DNS/connection failure) propagates straight out of `run()` and ends
 * the session with `reason: "error"`. (The kernel's `onProviderError` filter is now
 * the in-loop retry/downshift seam for the SAME provider — the `reliability`
 * extension rides it — but cross-provider failover still has no dedicated seam: the
 * kernel knows a provider only as "request → a stream of events", so a failover
 * chain is itself just a `Provider`.) This extension registers a **composite provider** named `"fallback"`
 * and rides the public, mutable `Agent.providerName` field exactly as `routing`
 * rides `Agent.model`: on `agent_start` it captures the configured provider as the
 * chain head and (when enabled) points `agent.providerName` at the wrapper; on
 * `agent_end` it restores the baseline.
 *
 * The wrapper streams the head provider first and, **only if that attempt fails
 * before emitting its first event**, transparently advances to the next chain
 * entry — rewriting `req.model` per entry, since a model id is provider-specific
 * (a `claude-*` id 400s on OpenAI). The `committed` commit point is the central
 * correctness invariant: the kernel contract is "a stream ending in exactly one
 * `done`", and the loop renders `text_delta`s as they arrive, so failing over
 * after any event has been yielded would double-emit text and produce two `done`s.
 * Once `committed` is set a failure is therefore fatal; failover happens only on a
 * clean (zero-event) failure, which covers the dominant outage class (auth /
 * rate-limit / connection / immediate-5xx all fail before the first byte).
 *
 * It routes the provider only — it never reads, grants, or gates a capability, and
 * declares none (providers are not capability-gated in EAgent; the underlying
 * vendors' network access is the host's established trust boundary). It adds no
 * tool. Ships OFF (opt-in): the wrapper is registered passively but unreferenced
 * until `/fallback-routing on` flips the store flag. `EAGENT_FALLBACK_ROUTING=off`
 * makes activation a total no-op. Configure with `/fallback-routing`.
 */

import { type Agent } from "../kernel/agent.ts";
import type { ExtensionAPI } from "../kernel/extension.ts";
import type { CompletionRequest, Provider, StreamEvent } from "../kernel/types.ts";

/** The wrapper's registered provider name; also the recursion-guard sentinel. */
export const FALLBACK_PROVIDER_NAME = "fallback";

/**
 * Consecutive in-run failures of a single provider before it is tripped open and
 * skipped for the rest of that run (the `circuit-breaker` per-run-bucket pattern,
 * so a known-down provider isn't re-hammered every turn). Store-overridable.
 */
export const DEFAULT_TRIP_AFTER = 2;

/** A resolved chain entry: a provider name plus the model id to send it. */
export interface ChainEntry {
  name: string;
  model: string;
}

/** An operator-configured fallback entry (the persisted shape). */
export interface FallbackEntry {
  provider: string;
  model: string;
}

/**
 * Assemble the ordered chain: the head (the captured/baseline provider, carrying
 * whatever model the request holds — so this composes with `routing`'s per-turn
 * model override) followed by the operator-configured fallback list. Pure.
 */
export function buildChain(
  head: ChainEntry | undefined,
  fallbacks: readonly FallbackEntry[],
): ChainEntry[] {
  const out: ChainEntry[] = [];
  if (head) out.push(head);
  for (const f of fallbacks) out.push({ name: f.provider, model: f.model });
  return out;
}

/**
 * Normalize a chain for streaming: drop the wrapper itself (the **recursion
 * guard** — without it the wrapper resolves to itself and infinite-recurses),
 * drop providers that are not currently registered (graceful degradation —
 * offline only `mock` exists, so an all-unregistered fallback list collapses the
 * chain to head-only and the wrapper becomes a transparent pass-through), drop
 * providers tripped open by the per-run circuit map, and de-duplicate by name
 * (first surviving occurrence wins). Pure and exported so the guard rules are
 * directly unit-testable.
 */
export function normalizeChain(
  chain: readonly ChainEntry[],
  opts: {
    isRegistered: (name: string) => boolean;
    isTripped: (name: string) => boolean;
  },
): ChainEntry[] {
  const out: ChainEntry[] = [];
  const seen = new Set<string>();
  for (const entry of chain) {
    if (!entry.name) continue;
    if (entry.name === FALLBACK_PROVIDER_NAME) continue; // recursion guard
    if (seen.has(entry.name)) continue; // de-dup by name
    if (!opts.isRegistered(entry.name)) continue; // degrade gracefully
    if (opts.isTripped(entry.name)) continue; // per-run circuit
    seen.add(entry.name);
    out.push(entry);
  }
  return out;
}

/**
 * Parse the `chain <provider> <model> [<provider> <model> …]` command arguments
 * into a fallback list, or an error string. Requires an even, non-zero token
 * count, non-empty names, and rejects `fallback` as a provider name (pre-empting
 * the recursion the normalizer would otherwise silently drop). Pure.
 */
export function parseChainArgs(
  tokens: readonly string[],
):
  | { ok: true; chain: FallbackEntry[] }
  | { ok: false; error: string } {
  if (tokens.length === 0) {
    return {
      ok: false,
      error: "fallback-routing: usage — /fallback-routing chain <provider> <model> [<provider> <model> …]",
    };
  }
  if (tokens.length % 2 !== 0) {
    return {
      ok: false,
      error: "fallback-routing: chain needs an even number of arguments (<provider> <model> pairs)",
    };
  }
  const chain: FallbackEntry[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const provider = tokens[i]!;
    const model = tokens[i + 1]!;
    if (provider.length === 0 || model.length === 0) {
      return { ok: false, error: "fallback-routing: provider and model must be non-empty" };
    }
    if (provider === FALLBACK_PROVIDER_NAME) {
      return {
        ok: false,
        error: `fallback-routing: "${FALLBACK_PROVIDER_NAME}" is not a valid provider name (it would recurse)`,
      };
    }
    chain.push({ provider, model });
  }
  return { ok: true, chain };
}

/** Read a positive integer from a raw store value, falling back for missing/NaN/<=0. */
function asPositiveInt(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (typeof n === "number" && Number.isFinite(n) && n > 0) return Math.floor(n);
  return fallback;
}

export default function activate(e: ExtensionAPI): () => void {
  // Kill switch: the env var makes activation a total no-op — no provider, no
  // listeners, no command, `Agent.providerName` never touched (routing /
  // circuit-breaker / recovery pattern).
  if (!e.config.enabled("fallback-routing", { default: true })) return () => {};

  // Per-run-tree state, keyed on the run-tree ROOT (`e.rootAgent`) so it is
  // isolated BETWEEN sessions (each on its own Agent) and race-free under
  // concurrency — the `baselineProvider` was a shared closure singleton that
  // would otherwise race one session's capture over another's.
  //
  //   - `baselineProvider`: the configured provider captured at run start (the
  //     restore baseline). `undefined` correctly restores "use the registry
  //     default". Seeded eagerly (below) so a `/fallback-routing off` before any
  //     run still restores to a sane value.
  //   - `circuit`: per-run provider name -> consecutive in-run failure count.
  //     Reset on `agent_start`; a provider whose count reaches `tripAfter` is
  //     skipped for the rest of that run. In-memory only.
  interface RouteState {
    baselineProvider: string | undefined;
    circuit: Map<string, number>;
  }
  const byRoot = new WeakMap<Agent, RouteState>();
  const stateFor = (agent: Agent): RouteState => {
    let s = byRoot.get(agent);
    if (!s) byRoot.set(agent, (s = { baselineProvider: agent.providerName, circuit: new Map() }));
    return s;
  };
  // Eager seed so a `/fallback-routing off` before this session's first run
  // restores the configured provider (captured before anything flips it to the
  // wrapper).
  stateFor(e.rootAgent);

  const cfg = (): { enabled: boolean; chain: FallbackEntry[]; tripAfter: number } => ({
    enabled: e.store.get<boolean>("enabled", false) ?? false,
    chain: e.store.get<FallbackEntry[]>("chain", []) ?? [],
    tripAfter: asPositiveInt(e.store.get<unknown>("tripAfter"), DEFAULT_TRIP_AFTER),
  });

  /**
   * The composite provider. Builds and normalizes the chain lazily AT STREAM TIME
   * (so late-registered providers are honored), then streams each entry with a
   * `committed` commit point: a failure is fatal once any event has been yielded
   * (would double-emit), and an abort is never treated as a failover trigger.
   */
  const wrapper: Provider = {
    name: FALLBACK_PROVIDER_NAME,
    async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
      const st = stateFor(e.rootAgent);
      const { chain: fallbacks, tripAfter } = cfg();
      const headName = st.baselineProvider ?? e.agent.providers.get()?.name;
      const head: ChainEntry | undefined =
        headName !== undefined ? { name: headName, model: req.model } : undefined;
      const chain = normalizeChain(buildChain(head, fallbacks), {
        isRegistered: (n) => e.agent.providers.get(n) !== undefined,
        isTripped: (n) => (st.circuit.get(n) ?? 0) >= tripAfter,
      });

      let lastErr: unknown;
      for (const entry of chain) {
        const provider = e.agent.providers.get(entry.name);
        if (!provider) continue; // belt-and-suspenders; normalize already dropped these
        const subReq: CompletionRequest = { ...req, model: entry.model };
        let committed = false;
        try {
          for await (const ev of provider.stream(subReq)) {
            committed = true;
            yield ev;
          }
          st.circuit.set(entry.name, 0); // a clean run resets this provider's failure streak
          return; // exactly one `done` was forwarded; stop the chain
        } catch (err) {
          // A user abort is not a provider fault: never fail over, and don't
          // count it against the per-run circuit (checked before the trip bump).
          if (req.signal.aborted) throw err;
          st.circuit.set(entry.name, (st.circuit.get(entry.name) ?? 0) + 1);
          if (committed) throw err; // already emitted events — failing over would double-emit
          lastErr = err; // failed before the first event — advance to the next entry
        }
      }
      throw lastErr ?? new Error("fallback-routing: no provider in the chain succeeded");
    },
  };

  const disposers = [
    // The load-bearing seam. `{ default: false }` is mandatory so it never becomes
    // the registry default; it is reached only when `agent.providerName ===
    // "fallback"`. Registered even while disabled (harmless — unreferenced).
    e.registerProvider(wrapper, { default: false }),

    // Capture the configured provider as the restore baseline (read BEFORE any
    // overwrite), clear the per-run circuit, then point at the wrapper if enabled.
    // `run()` awaits all `agent_start` handlers before turn 1, so this lands
    // before the first `streamTurn`.
    e.on("agent_start", () => {
      const st = stateFor(e.rootAgent);
      st.baselineProvider = e.agent.providerName;
      st.circuit.clear();
      if (cfg().enabled) e.agent.providerName = FALLBACK_PROVIDER_NAME;
    }),

    // Restore the configured provider when the run ends (fires in the loop's
    // `finally`, so it also restores after an errored/aborted run — no residue).
    e.on("agent_end", () => {
      e.agent.providerName = stateFor(e.rootAgent).baselineProvider;
    }),
  ];

  const offCommand = e.registerCommand({
    name: "fallback-routing",
    description:
      "Provider failover chain. Usage: /fallback-routing [on|off|status|reset] " +
      "or /fallback-routing chain <provider> <model> [<provider> <model> …].",
    run: (ctx) => {
      const args = ctx.args.trim();
      const [head, ...rest] = args.split(/\s+/).filter((s) => s.length > 0);
      const st = stateFor(e.rootAgent);
      switch (head) {
        case "on":
          e.store.set("enabled", true);
          ctx.print("fallback-routing on");
          break;
        case "off":
          e.store.set("enabled", false);
          // Soft switch: immediately restore the configured baseline.
          e.agent.providerName = st.baselineProvider;
          ctx.print("fallback-routing off");
          break;
        case "chain": {
          const parsed = parseChainArgs(rest);
          if (!parsed.ok) {
            ctx.print(parsed.error);
            break;
          }
          e.store.set("chain", parsed.chain);
          ctx.print(
            `fallback-routing: chain = ${parsed.chain.map((c) => `${c.provider}:${c.model}`).join(" -> ") || "(empty)"}`,
          );
          break;
        }
        case "reset":
          st.circuit.clear();
          ctx.print("fallback-routing: per-run circuit cleared");
          break;
        case "status":
        case undefined:
        default: {
          const c = cfg();
          const headName = st.baselineProvider ?? e.agent.providers.get()?.name;
          const headEntry: ChainEntry | undefined =
            headName !== undefined ? { name: headName, model: e.agent.model } : undefined;
          const resolved = buildChain(headEntry, c.chain).map((x) => `${x.name}:${x.model}`);
          const trippedCount = [...st.circuit.values()].filter((n) => n >= c.tripAfter).length;
          ctx.print(`enabled=${c.enabled}`);
          ctx.print(`chain=${resolved.join(" -> ") || "(head only)"}`);
          ctx.print(`tripAfter=${c.tripAfter}`);
          ctx.print(`tripped=${trippedCount}`);
        }
      }
    },
  });

  return () => {
    for (const d of [offCommand, ...disposers]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
