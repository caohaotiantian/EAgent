/**
 * The resource layer, and the pinning rule.
 *
 * THE PINNING RULE, stated once: **a Run reads only what its resolution manifest
 * names.** `resolve` turns a floating selector (`@stable`) into a digest and runs at
 * COMPILE time; `fetch` demands a digest and runs at RUN time. Because the compiled
 * `RunGraph` carries the manifest, a Resource published, promoted, or deprecated
 * mid-run cannot affect that Run.
 *
 * That split is also why cache invalidation is not a problem here: every cache is
 * keyed by content digest, and digests are immutable, so entries are never stale —
 * only evictable. The single mutable mapping is `selector → digest`, and it is read
 * exactly once per run, at compile.
 *
 * Promotion moves a SELECTOR. It never mutates content. So a rollback is a pointer
 * move — always safe, always instantaneous, and invisible to anything in flight.
 *
 * See design/loom/05-RESOURCES-OBSERVABILITY.md D8.
 */

import { digest, type Digest } from "../canonical.ts";
import { CODES, err } from "../errors.ts";
import type { GraphSpec, ResolvedRef, ResourceRef } from "../graph/spec.ts";
import type { ResourceResolver } from "../graph/validate.ts";
import { EVOLUTION_ACTOR, type PolicyActor } from "../run/policy.ts";

export type ResourceKind =
  | "prompt"
  | "agent_profile"
  | "graph"
  | "subgraph"
  | "function"
  | "skill"
  | "tool_manifest"
  | "oversight"
  | "mcp_server"
  | "knowledge_base"
  | "eval_suite"
  | "hook";

export type Channel = "draft" | "canary" | "stable" | "deprecated";

export interface ResourceVersion<T = unknown> {
  readonly kind: ResourceKind;
  readonly name: string;
  readonly version: number;
  readonly digest: Digest;
  readonly content: T;
  readonly createdAt: number;
  readonly createdBy: string;
  /** Security removal. Breaks NEW compiles on purpose; in-flight runs are untouched. */
  readonly yanked: boolean;
  readonly yankReason?: string;
}

export interface PublishInput<T = unknown> {
  readonly kind: ResourceKind;
  readonly name: string;
  readonly content: T;
  readonly actor: PolicyActor;
  readonly idempotencyKey?: string;
}

export interface ResourceFilter {
  readonly kind?: ResourceKind;
  readonly name?: string;
  readonly channel?: Channel;
}

/** Legal promotions. Anything not listed here is refused. */
const TRANSITIONS: Readonly<Record<Channel, readonly Channel[]>> = {
  draft: ["canary", "deprecated"],
  canary: ["stable", "draft", "deprecated"],
  stable: ["deprecated"],
  deprecated: ["stable"],
};

export interface ResourceStoreOptions {
  readonly now?: () => number;
  /**
   * Deny-lists the STORE holds, keyed by actor id.
   *
   * `PolicyActor.denied` rides on the object being authorized, which makes it an assertion
   * the SUBJECT gets to make about itself. Both doors onto `@stable` used to ask exactly
   * that field, so an identity that named itself `evolution-engine` and simply left the
   * field off was on no deny-list at all — and the guard whose whole job is to stop the
   * evolution engine pointing `@stable` at its own un-gated draft was satisfiable by the
   * evolution engine. `PolicyEngine.deescalate` was fixed the same way and this is the same
   * shape; see `PolicyEngineOptions.deniedActors`.
   *
   * Entries here are UNIONED with `EVOLUTION_ACTOR`'s own list and with whatever the actor
   * object carries. Deny beats allow in every direction, so supplying this map can only ever
   * add denials; passing `{"evolution-engine": []}` does not un-deny it.
   */
  readonly deniedActors?: Readonly<Record<string, readonly string[]>>;
  /**
   * The store's INITIAL CONTENTS, at `@stable`, placed by whoever started the process.
   *
   * NOT A PROMOTION, and the distinction is the reason this door exists rather than the
   * loader minting a human actor to walk `publish → canary → stable`. That ladder governs
   * CHANGES to what `@stable` means while a deployment is running, and `#requireStablePromoter`
   * refuses a non-human because a bot must not repoint `@stable` at its own draft. A working
   * tree read at boot is not a bot: it is the operator's own filesystem, read once, before
   * anything is serving. Faking a human actor to get past a guard would defeat exactly the
   * guard's argument; naming the door for what it is leaves the guard intact and makes the
   * exemption visible to a reader.
   *
   * Seeded versions are ordinary versions — `fetch`, `document`, `list` and `versions` see
   * them — and the promotion ladder governs everything that happens to them afterwards.
   */
  readonly seed?: readonly { readonly kind: ResourceKind; readonly name: string; readonly content: unknown }[];
}

/** The capability both doors onto `@stable` spend. Named once so the deny-lists agree on it. */
const PROMOTE_STABLE = "resource:promote(stable)";

/**
 * The deny-lists the store keeps, seeded so the built-in one cannot be dropped.
 *
 * A near-twin of `run/policy.ts`'s `engineDenyLists`, and a copy rather than an import for
 * the reason that file gives about `MAX_TIMER_MS`: exporting a two-line seeding helper would
 * put it on the pinned public surface, and the shared thing that MUST NOT drift — the list
 * itself — is imported from `EVOLUTION_ACTOR` rather than restated.
 */
function storeDenyLists(
  supplied: Readonly<Record<string, readonly string[]>> | undefined,
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>([[EVOLUTION_ACTOR.id, EVOLUTION_ACTOR.denied ?? []]]);
  for (const [id, caps] of Object.entries(supplied ?? {})) out.set(id, [...(out.get(id) ?? []), ...caps]);
  return out;
}

/** Trailing `*` is a prefix wildcard — the same reading `PolicyEngine` gives a pattern. */
function matches(patterns: readonly string[], capability: string): boolean {
  return patterns.some((p) => (p.endsWith("*") ? capability.startsWith(p.slice(0, -1)) : p === capability));
}

export class ResourceStore implements ResourceResolver {
  /** `kind/name` → versions, in publish order. */
  readonly #versions = new Map<string, ResourceVersion[]>();
  /** `kind/name@channel` → digest. THE only mutable mapping in the layer. */
  readonly #selectors = new Map<string, Digest>();
  readonly #byDigest = new Map<Digest, ResourceVersion>();
  readonly #idempotency = new Map<string, Digest>();
  readonly #now: () => number;
  /** Deny-lists this STORE holds. External to the actor on purpose — see the option. */
  readonly #deniedActors: ReadonlyMap<string, readonly string[]>;

  constructor(opts: ResourceStoreOptions = {}) {
    this.#now = opts.now ?? Date.now;
    this.#deniedActors = storeDenyLists(opts.deniedActors);
    for (const s of opts.seed ?? []) this.#seed(s.kind, s.name, s.content);
  }

  /** One initial version, at `@stable`. See `ResourceStoreOptions.seed`. */
  #seed(kind: ResourceKind, name: string, content: unknown): void {
    const digest = resourceDigest(kind, name, content);
    const key = `${kind}/${name}`;
    const version = (this.#versions.get(key)?.length ?? 0) + 1;
    const record: ResourceVersion = {
      kind,
      name,
      version,
      digest,
      content,
      createdAt: this.#now(),
      createdBy: "seed",
      yanked: false,
    };
    this.#versions.set(key, [...(this.#versions.get(key) ?? []), record]);
    this.#byDigest.set(digest, record);
    this.#selectors.set(`${key}@stable`, digest);
    this.#selectors.set(`${key}@${String(version)}`, digest);
  }

  // ── publish ───────────────────────────────────────────────────────────────

  /**
   * Publish as `draft`.
   *
   * Content-addressed: publishing identical bytes twice returns the SAME digest and
   * creates no new version. That makes republishing idempotent without a key, and it
   * makes "did anything actually change?" answerable by comparing digests rather
   * than by diffing.
   */
  publish<T>(input: PublishInput<T>): ResolvedRef {
    const key = `${input.kind}/${input.name}`;
    // The digest covers IDENTITY as well as content.
    //
    // Pure content-addressing collides across names: `function/passthrough` and
    // `function/merge-digests` both with content `{}` are the same bytes, so the
    // second publish would silently return the first resource's version — and its
    // channel. Including kind and name keeps "identical content ⇒ same version"
    // true WITHIN a resource, which is the property that actually matters, while
    // keeping two differently-named resources distinct.
    const d = digest({ kind: input.kind, name: input.name, content: input.content });

    if (input.idempotencyKey !== undefined) {
      const seen = this.#idempotency.get(input.idempotencyKey);
      if (seen !== undefined && seen !== d) {
        throw err.conflict(CODES.E_IDEMPOTENCY_MISMATCH, `idempotency key reused with different content`, {
          details: { key: input.idempotencyKey },
        });
      }
      this.#idempotency.set(input.idempotencyKey, d);
    }

    const existing = this.#byDigest.get(d);
    if (existing !== undefined) {
      return { ref: `${key}@${existing.version}`, digest: d, channel: this.#channelOf(d) };
    }

    const versions = this.#versions.get(key) ?? [];
    const record: ResourceVersion<T> = {
      kind: input.kind,
      name: input.name,
      version: versions.length + 1,
      digest: d,
      content: input.content,
      createdAt: this.#now(),
      createdBy: input.actor.id,
      yanked: false,
    };
    versions.push(record as ResourceVersion);
    this.#versions.set(key, versions);
    this.#byDigest.set(d, record as ResourceVersion);
    this.#selectors.set(`${key}@draft`, d);

    return { ref: `${key}@${record.version}`, digest: d, channel: "draft" };
  }

  // ── promotion ─────────────────────────────────────────────────────────────

  /**
   * Move a selector. Never mutates content.
   *
   * `stable` requires a HUMAN actor. The evolution engine's identity is deny-listed
   * for `resource:promote(stable)` (D10.g), so the check is on a deny-list rather than
   * on an absent grant — "forgot to grant" and "must never have" are different facts
   * and only the second survives someone widening a grant.
   *
   * WHICH deny-list is the whole question, and it is `#requireStablePromoter`'s: the
   * store's, not the caller's.
   */
  promote(ref: ResolvedRef | string, to: Channel, actor: PolicyActor): ResolvedRef {
    const resolved = typeof ref === "string" ? this.#requireRef(ref) : ref;
    const record = this.#byDigest.get(resolved.digest);
    if (record === undefined) throw err.notFound(CODES.E_RESOURCE_NOT_FOUND, `unknown digest ${resolved.digest}`);
    if (record.yanked) throw err.policy(CODES.E_RESOURCE_YANKED, `"${record.name}" is yanked and cannot be promoted`);

    const from = this.#channelOf(resolved.digest);
    if (!(TRANSITIONS[from] ?? []).includes(to)) {
      throw err.conflict(CODES.E_ILLEGAL_TRANSITION, `cannot promote ${from} → ${to}`, { details: { from, to } });
    }
    if (to === "stable") this.#requireStablePromoter(actor, "promoting to stable");

    const key = `${record.kind}/${record.name}`;
    this.#selectors.set(`${key}@${to}`, resolved.digest);
    return { ref: `${key}@${record.version}`, digest: resolved.digest, channel: to };
  }

  /**
   * Instantaneous and always safe as an OPERATION: it moves a pointer, and in-flight runs
   * hold digests. Not unauthorized, though — it writes `@stable`.
   *
   * SAME DOOR AS `promote(…, "stable")`, and for the reason that method gives. Rollback
   * sets exactly the selector that promotion guards with a human check and a deny-list, so
   * an unguarded rollback is not a weaker lever, it is the way around the stronger one:
   * the evolution engine could point `@stable` at a draft of its own that no eval suite
   * ever saw, and it could do it without passing through a single promotion criterion.
   *
   * It does NOT walk the `TRANSITIONS` ladder. Restoring a superseded version is
   * `stable → stable`, and `#channelOf` reports a version the selector has moved off as
   * `draft`, so checking the ladder here would refuse every real rollback. Which version
   * is safe to go back to is a human's judgement; that a human made it is what this
   * enforces.
   */
  rollback(kind: ResourceKind, name: string, toVersion: number, actor: PolicyActor): ResolvedRef {
    const record = (this.#versions.get(`${kind}/${name}`) ?? []).find((v) => v.version === toVersion);
    if (record === undefined) {
      throw err.notFound(CODES.E_RESOURCE_NOT_FOUND, `${kind}/${name}@${toVersion} does not exist`);
    }
    this.#requireStablePromoter(actor, "rolling back moves @stable and");
    this.#selectors.set(`${kind}/${name}@stable`, record.digest);
    return { ref: `${kind}/${name}@${toVersion}`, digest: record.digest, channel: "stable" };
  }

  /**
   * The ONE door onto `@stable`, so the two callers cannot disagree about it.
   *
   * They did. `promote` and `rollback` write the same selector and carried two copies of the
   * check, and both copies read `actor.denied` — a field on the object being authorized, so
   * the guard was answerable by the thing it guards. THREE facts are checked here and only
   * the last belongs to the caller:
   *
   *   1. the actor is a HUMAN. A kind is still self-asserted, which is why 2 exists.
   *   2. the STORE's own deny-list, seeded from `EVOLUTION_ACTOR` and un-droppable. This is
   *      the authority that does not travel on the request.
   *   3. the actor's own list, kept because an embedder minting a scoped actor should be able
   *      to hand it a narrower one than the store knows about. Deny beats allow, so a third
   *      list can only ever refuse more.
   *
   * `what` is the caller's own phrasing of what it is about to do, because "you may not
   * promote" is a confusing thing to be told by `rollback`.
   */
  #requireStablePromoter(actor: PolicyActor, what: string): void {
    if (actor.kind !== "human") {
      throw err.policy(CODES.E_HUMAN_APPROVAL_REQUIRED, `${what} requires a human actor; got "${actor.kind}"`, {
        details: { actor: actor.id },
      });
    }
    if (matches(this.#deniedActors.get(actor.id) ?? [], PROMOTE_STABLE)) {
      throw err.policy(
        CODES.E_OVERSIGHT_LOOSEN_FORBIDDEN,
        `identity "${actor.id}" is deny-listed for ${PROMOTE_STABLE} by this store`,
        { details: { actor: actor.id, source: "store.deniedActors" } },
      );
    }
    if (matches(actor.denied ?? [], PROMOTE_STABLE)) {
      throw err.policy(CODES.E_OVERSIGHT_LOOSEN_FORBIDDEN, `actor "${actor.id}" is deny-listed for ${PROMOTE_STABLE}`, {
        details: { actor: actor.id, source: "actor.denied" },
      });
    }
  }

  /**
   * Security removal. Breaks NEW compiles deliberately.
   *
   * In-flight runs are NOT broken mid-flight — stranding them could leave irreversible
   * work half-done. The design's answer (D8.5) is to escalate those runs to human
   * oversight instead, which the engine does on seeing a yanked manifest entry.
   */
  yank(kind: ResourceKind, name: string, version: number, reason: string, actor: PolicyActor): void {
    if (actor.kind !== "human") {
      throw err.policy(CODES.E_HUMAN_APPROVAL_REQUIRED, "yanking requires a human actor");
    }
    if (reason.trim() === "") throw err.validation(CODES.E_HUMAN_APPROVAL_REQUIRED, "yanking requires an incident reference");

    const versions = this.#versions.get(`${kind}/${name}`) ?? [];
    const i = versions.findIndex((v) => v.version === version);
    if (i < 0) throw err.notFound(CODES.E_RESOURCE_NOT_FOUND, `${kind}/${name}@${version} does not exist`);
    const yanked: ResourceVersion = { ...versions[i]!, yanked: true, yankReason: reason };
    versions[i] = yanked;
    this.#byDigest.set(yanked.digest, yanked);
  }

  // ── resolution: the pinning rule ──────────────────────────────────────────

  /**
   * COMPILE TIME ONLY. Turns any selector into a digest.
   *
   * Accepts `@<version>`, `@sha256:…`, and the floating channels. Everything the
   * compiler resolves is written into the RunGraph's manifest, which is what freezes
   * the Run's view of the world.
   */
  resolve(ref: ResourceRef): ResolvedRef | undefined {
    const parsed = parseRef(ref);
    if (parsed === undefined) return undefined;
    const { kind, name, selector } = parsed;
    const key = `${kind}/${name}`;

    if (selector.startsWith("sha256:")) {
      const record = this.#byDigest.get(selector as Digest);
      if (record === undefined || record.yanked) return undefined;
      return { ref, digest: record.digest, channel: this.#channelOf(record.digest) };
    }

    const asVersion = Number(selector);
    if (Number.isInteger(asVersion)) {
      const record = (this.#versions.get(key) ?? []).find((v) => v.version === asVersion);
      if (record === undefined || record.yanked) return undefined;
      return { ref, digest: record.digest, channel: this.#channelOf(record.digest) };
    }

    const d = this.#selectors.get(`${key}@${selector}`);
    if (d === undefined) return undefined;
    const record = this.#byDigest.get(d);
    if (record === undefined || record.yanked) return undefined;
    return { ref, digest: d, channel: selector as Channel };
  }

  /**
   * RUN TIME. Demands a digest.
   *
   * A floating ref here is an `internal`-class bug, not a user error: it means some
   * code path skipped the compiler's pinning, and the Run's view of the world is no
   * longer frozen. Failing loudly is the only way that stays true.
   */
  fetch<T = unknown>(pinned: ResolvedRef | Digest): ResourceVersion<T> {
    const d = typeof pinned === "string" ? pinned : pinned.digest;
    if (!d.startsWith("sha256:")) {
      throw err.internal(CODES.E_FLOATING_REF_AT_RUNTIME, `fetch requires a digest, got "${d}"`, { details: { ref: d } });
    }
    const record = this.#byDigest.get(d as Digest);
    if (record === undefined) throw err.notFound(CODES.E_RESOURCE_NOT_FOUND, `no resource with digest ${d}`);
    return record as ResourceVersion<T>;
  }

  /**
   * RUN TIME. The text a pinned document holds.
   *
   * `fetch` already refuses a floating ref, which is the property this method exists to
   * inherit rather than restate. `undefined` for a pin whose content is not text — a
   * `function` or a `subgraph` pin reaches here through the same resolver and is not a
   * document, and answering `[object Object]` to a model would be worse than answering
   * nothing.
   */
  document(pinned: Digest): string | undefined {
    const record = this.#byDigest.get(pinned);
    // `undefined` for a pin this store does not hold, rather than `fetch`'s throw: a layered
    // resolver asks every pin it sees, and most of them belong to the pin-only half beneath
    // it. `fetch` keeps its throw, which is right for a caller that believes it holds the
    // resource; this is the caller that is asking whether it does.
    if (record === undefined || record.yanked) return undefined;
    return typeof record.content === "string" ? record.content : undefined;
  }

  /** For the compiler's subgraph recursion. */
  subgraph(ref: ResourceRef): GraphSpec | undefined {
    const resolved = this.resolve(ref);
    if (resolved === undefined) return undefined;
    const record = this.#byDigest.get(resolved.digest);
    if (record === undefined || (record.kind !== "subgraph" && record.kind !== "graph")) return undefined;
    return record.content as GraphSpec;
  }

  // ── queries ───────────────────────────────────────────────────────────────

  list(filter: ResourceFilter = {}): readonly ResourceVersion[] {
    const out: ResourceVersion[] = [];
    for (const versions of this.#versions.values()) {
      for (const v of versions) {
        if (filter.kind !== undefined && v.kind !== filter.kind) continue;
        if (filter.name !== undefined && v.name !== filter.name) continue;
        if (filter.channel !== undefined && this.#channelOf(v.digest) !== filter.channel) continue;
        out.push(v);
      }
    }
    // Code-unit order, the house rule `canonical.ts` states: `localeCompare` is locale-
    // and ICU-dependent, so two machines would page this list in different orders and a
    // cursor over it would skip or repeat rows.
    return out.sort((a, b) => {
      const l = a.kind + a.name;
      const r = b.kind + b.name;
      return l < r ? -1 : l > r ? 1 : a.version - b.version;
    });
  }

  versions(kind: ResourceKind, name: string): readonly ResourceVersion[] {
    return [...(this.#versions.get(`${kind}/${name}`) ?? [])];
  }

  /** The highest channel currently pointing at this digest, or `draft`. */
  #channelOf(d: Digest): Channel {
    for (const channel of ["stable", "canary", "deprecated", "draft"] as const) {
      for (const [key, value] of this.#selectors) {
        if (value === d && key.endsWith(`@${channel}`)) return channel;
      }
    }
    return "draft";
  }

  #requireRef(ref: string): ResolvedRef {
    const r = this.resolve(ref);
    if (r === undefined) throw err.notFound(CODES.E_RESOURCE_NOT_FOUND, `"${ref}" does not resolve`);
    return r;
  }
}

/** The identity-aware digest, exposed so callers can precompute one. */
export function resourceDigest(kind: ResourceKind, name: string, content: unknown): Digest {
  return digest({ kind, name, content });
}

export function parseRef(ref: ResourceRef): { kind: ResourceKind; name: string; selector: string } | undefined {
  const at = ref.lastIndexOf("@");
  const slash = ref.indexOf("/");
  if (at < 0 || slash < 0 || slash > at) return undefined;
  return {
    kind: ref.slice(0, slash) as ResourceKind,
    name: ref.slice(slash + 1, at),
    selector: ref.slice(at + 1),
  };
}
