/**
 * Gate delivery, and the escalation chain.
 *
 * Raising a gate makes the decision durable. DELIVERING it is what makes the decision
 * happen — a gate nobody was told about is an outage with extra steps, and a queue you
 * have to remember to check is not oversight.
 *
 * The rule the whole file is arranged around:
 *
 * > **DELIVERY FAILURE NEVER AUTO-APPROVES.**
 *
 * Every channel failing is a *notification* problem, not an authorization one. The gate
 * stays open, the failure is journaled, and the only ways out remain a human decision or
 * the declared timeout policy. Anything else would make an unreachable Slack workspace
 * into a way to approve a production restart.
 *
 * Channels are injected and the built-ins use only `fetch` and a callback, so this stays
 * zero-dependency. A real Slack or PagerDuty integration is a `DeliveryChannel` living
 * outside `@loom/core`, which is where a vendor SDK belongs.
 *
 * See design/loom/04-OVERSIGHT.md D7.3.
 */

import { CODES, err, toLoomError, type LoomError } from "../errors.ts";
import type { GateId } from "../ids.ts";
import { SYSTEM_ACTOR } from "../journal/events.ts";
import { redactPayload } from "../security/redact.ts";
import type { Classification } from "../vocab.ts";
import type { GateSummary } from "./gates.ts";
import type { RunLog } from "./log.ts";

/** Who a gate is routed to. Resolved by the channel, not by the broker. */
export interface Recipient {
  readonly kind: "user" | "role" | "group";
  readonly id: string;
}

export interface DeliveryTarget {
  readonly gate: GateSummary;
  readonly recipients: readonly Recipient[];
  /** Already redacted. A channel never sees what the classification said to hide. */
  readonly payload: unknown;
  /** Which escalation tier this is. 0 is the original delivery. */
  readonly tier: number;
}

export interface DeliveryChannel {
  readonly name: string;
  /**
   * Deliver, returning a RECEIPT — an id the channel can be asked about later.
   *
   * Throwing means "not delivered". A channel that swallows its own errors and returns
   * a receipt anyway is worse than no channel: it converts a silent non-delivery into a
   * recorded delivery, and the SLA sweep will then blame the human.
   */
  deliver(target: DeliveryTarget, signal: AbortSignal): Promise<string>;
}

/** One escalation tier: after this long, tell these people instead. */
export interface EscalationTier {
  readonly afterMs: number;
  readonly to?: readonly Recipient[];
  /** Channels for this tier. Absent ⇒ reuse the gate's channels. */
  readonly channels?: readonly string[];
  /** Terminal tier: the chain is exhausted and the gate expires. */
  readonly action?: "fail";
}

export interface DeliverySpec {
  readonly channels: readonly string[];
  readonly recipients?: readonly Recipient[];
  /**
   * Field names to redact before delivery, matched recursively by key.
   *
   * DEVIATION from D7.2's `redact: [pii]`. A classification tokenises the WHOLE payload,
   * which defeats the point of a gate: a human cannot approve what they cannot see. So
   * the knob is the field set, and everything outside it stays legible — the approver
   * reads the command and the blast radius, and never reads the email address.
   *
   * Applied here, before any channel is called. A channel is outside the trust boundary,
   * and redacting in the UI would already be too late.
   */
  readonly redact?: readonly string[];
  /** How redacted fields are rendered. Default `pii`, which tokenises reversibly. */
  readonly redactAs?: Classification;
  readonly escalation?: readonly EscalationTier[];
}

// ---------------------------------------------------------------------------
// Built-in channels
// ---------------------------------------------------------------------------

export interface ConsoleChannelOptions {
  /** Where a queued gate goes. Defaults to collecting in memory. */
  readonly sink?: (line: string, target: DeliveryTarget) => void;
}

/**
 * The always-available fallback.
 *
 * It cannot fail, which is what makes it the fallback: the console queue is where a gate
 * lands when every other channel is down, so that "nobody was told" is never the outcome.
 */
export class ConsoleChannel implements DeliveryChannel {
  readonly name = "console";
  readonly queued: DeliveryTarget[] = [];
  readonly #sink: ConsoleChannelOptions["sink"];

  constructor(opts: ConsoleChannelOptions = {}) {
    this.#sink = opts.sink;
  }

  deliver(target: DeliveryTarget): Promise<string> {
    this.queued.push(target);
    const to = target.recipients.map((r) => `${r.kind}:${r.id}`).join(", ") || "anyone";
    this.#sink?.(`gate ${target.gate.gateId} on node ${target.gate.nodeId} awaits ${to}`, target);
    return Promise.resolve(`console:${target.gate.gateId}:${target.tier}`);
  }
}

export interface WebhookChannelOptions {
  readonly name?: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** Injected for tests; defaults to the global. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * An HTTP webhook — the one real channel that costs no dependency.
 *
 * A Slack incoming webhook, a PagerDuty Events endpoint, and an internal approvals
 * service are all this shape, so one implementation covers the realistic cases without
 * `@loom/core` learning any vendor's API.
 */
export class WebhookChannel implements DeliveryChannel {
  readonly name: string;
  readonly #opts: WebhookChannelOptions;

  constructor(opts: WebhookChannelOptions) {
    this.name = opts.name ?? "webhook";
    this.#opts = opts;
  }

  async deliver(target: DeliveryTarget, signal: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(this.#opts.timeoutMs ?? 10_000);
    const res = await (this.#opts.fetch ?? globalThis.fetch)(this.#opts.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.#opts.headers },
      body: JSON.stringify({
        gateId: target.gate.gateId,
        runId: target.gate.runId,
        nodeId: target.gate.nodeId,
        tier: target.tier,
        recipients: target.recipients,
        deadline: target.gate.deadline,
        payload: target.payload,
      }),
      signal: AbortSignal.any([signal, timeout]),
    });
    if (!res.ok) {
      throw err.unavailable(
        CODES.E_GATE_DELIVERY_FAILED,
        `${this.name} returned ${res.status} for gate ${target.gate.gateId}`,
        { details: { status: res.status } },
      );
    }
    // Prefer the service's own id — a receipt you cannot look up is a receipt in name only.
    const text = await res.text().catch(() => "");
    return text.trim() === "" ? `${this.name}:${target.gate.gateId}:${target.tier}` : text.trim().slice(0, 200);
  }
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

export interface DeliveryOutcome {
  readonly delivered: readonly { readonly channel: string; readonly receipt: string }[];
  readonly failed: readonly { readonly channel: string; readonly error: LoomError }[];
  /** True when NOT ONE channel succeeded — the gate stays open regardless. */
  readonly fellBack: boolean;
}

export interface DispatcherOptions {
  readonly channels: readonly DeliveryChannel[];
  /**
   * Where a gate goes when every declared channel fails. Must not itself be able to
   * fail; the built-in `ConsoleChannel` is the intended value.
   */
  readonly fallback?: DeliveryChannel;
  readonly now?: () => number;
}

/**
 * Delivers a gate over its declared channels, in parallel, and journals what happened.
 *
 * Parallel and not sequential because delivery is a notification: telling Slack should
 * not wait on a webhook that is timing out. Every outcome — success and failure — is
 * journaled, so "why did nobody see this?" is answerable after the fact.
 */
export class GateDispatcher {
  readonly #channels: Map<string, DeliveryChannel>;
  readonly #fallback: DeliveryChannel | undefined;

  constructor(opts: DispatcherOptions) {
    this.#channels = new Map(opts.channels.map((c) => [c.name, c]));
    this.#fallback = opts.fallback;
  }

  channel(name: string): DeliveryChannel | undefined {
    return this.#channels.get(name);
  }

  async deliver(
    log: RunLog,
    gate: GateSummary,
    spec: DeliverySpec,
    opts: { tier?: number; signal?: AbortSignal } = {},
  ): Promise<DeliveryOutcome> {
    const tier = opts.tier ?? 0;
    const signal = opts.signal ?? new AbortController().signal;
    const names = tierChannels(spec, tier);
    const recipients = tierRecipients(spec, tier);

    const payload = redactFields(gate.payload, spec.redact ?? [], spec.redactAs ?? "pii");
    const target: DeliveryTarget = { gate, recipients, payload, tier };

    const results = await Promise.all(
      names.map(async (name) => {
        const channel = this.#channels.get(name);
        if (channel === undefined) {
          return {
            channel: name,
            error: err.notFound(CODES.E_GATE_DELIVERY_FAILED, `no delivery channel named "${name}"`),
          };
        }
        try {
          return { channel: name, receipt: await channel.deliver(target, signal) };
        } catch (e) {
          return { channel: name, error: toLoomError(e) };
        }
      }),
    );

    const delivered = results.filter((r): r is { channel: string; receipt: string } => "receipt" in r);
    const failed = results.filter((r): r is { channel: string; error: LoomError } => "error" in r);

    let fellBack = false;
    if (delivered.length === 0 && this.#fallback !== undefined) {
      // EVERY channel failed. The gate does not open, close, or approve — it queues
      // where a human will find it, and the failure is on the record.
      fellBack = true;
      const receipt = await this.#fallback.deliver(target, signal);
      delivered.push({ channel: this.#fallback.name, receipt });
    }

    await log.append([
      ...delivered.map((d) => ({
        type: "gate.delivered" as const,
        payload: { gateId: gate.gateId, channel: d.channel, receipt: d.receipt },
        actor: SYSTEM_ACTOR("gate-delivery"),
      })),
      ...failed.map((f) => ({
        type: "gate.delivery_failed" as const,
        payload: {
          gateId: gate.gateId,
          channel: f.channel,
          error: f.error.message,
          tier,
          fellBack,
        },
        actor: SYSTEM_ACTOR("gate-delivery"),
      })),
    ]);

    return { delivered, failed, fellBack };
  }
}

/**
 * Replace the named fields, wherever they appear, and leave everything else alone.
 *
 * Recursive by KEY NAME rather than by path: `email` is `email` whether it sits at the
 * top level or three objects down, and a path list would silently miss the nested one.
 */
export function redactFields(value: unknown, fields: readonly string[], as: Classification): unknown {
  if (fields.length === 0) return value;
  const names = new Set(fields);

  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = names.has(k) ? redactPayload(val, as) : walk(val);
    }
    return out;
  };
  return walk(value);
}

/** Channels for a tier: the tier's own if it names any, otherwise the gate's. */
export function tierChannels(spec: DeliverySpec, tier: number): readonly string[] {
  if (tier === 0) return spec.channels;
  return spec.escalation?.[tier - 1]?.channels ?? spec.channels;
}

/** Recipients for a tier. Escalating means telling someone ELSE, not shouting louder. */
export function tierRecipients(spec: DeliverySpec, tier: number): readonly Recipient[] {
  if (tier === 0) return spec.recipients ?? [];
  return spec.escalation?.[tier - 1]?.to ?? spec.recipients ?? [];
}

/**
 * The next escalation tier and its new deadline, or `undefined` when exhausted.
 *
 * THE CLOCK RESETS on escalation. A tier that inherited the original deadline would
 * breach the instant it was reached, walking the whole chain in one sweep and paging
 * the director about something the on-call had not yet had a chance to see.
 */
export function nextTier(
  spec: DeliverySpec,
  currentTier: number,
  now: number,
): { readonly tier: number; readonly deadline: number } | undefined {
  const next = spec.escalation?.[currentTier];
  if (next === undefined || next.action === "fail") return undefined;
  return { tier: currentTier + 1, deadline: now + next.afterMs };
}

export function isChainExhausted(spec: DeliverySpec, currentTier: number): boolean {
  const next = spec.escalation?.[currentTier];
  return next === undefined || next.action === "fail";
}

/** A recipient list, for a channel that wants one string. */
export function formatRecipients(recipients: readonly Recipient[]): string {
  return recipients.map((r) => `${r.kind}:${r.id}`).join(", ");
}

export function gateDeliveryError(gateId: GateId, reason: string): LoomError {
  return err.unavailable(CODES.E_GATE_DELIVERY_FAILED, `gate "${gateId}" was not delivered: ${reason}`);
}
