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
import type { PolicyActor } from "../run/policy.ts";

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
}

export class ResourceStore implements ResourceResolver {
  /** `kind/name` → versions, in publish order. */
  readonly #versions = new Map<string, ResourceVersion[]>();
  /** `kind/name@channel` → digest. THE only mutable mapping in the layer. */
  readonly #selectors = new Map<string, Digest>();
  readonly #byDigest = new Map<Digest, ResourceVersion>();
  readonly #idempotency = new Map<string, Digest>();
  readonly #now: () => number;

  constructor(opts: ResourceStoreOptions = {}) {
    this.#now = opts.now ?? Date.now;
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
   * for `resource:promote(stable)` (D10.g), so the check is on the actor's kind and
   * its deny-list, not on an absent grant — "forgot to grant" and "must never have"
   * are different facts and only the second survives someone widening a grant.
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
    if (to === "stable") {
      if (actor.kind !== "human") {
        throw err.policy(
          CODES.E_HUMAN_APPROVAL_REQUIRED,
          `promoting to stable requires a human actor; got "${actor.kind}"`,
          { details: { actor: actor.id } },
        );
      }
      if ((actor.denied ?? []).includes("resource:promote(stable)")) {
        throw err.policy(CODES.E_OVERSIGHT_LOOSEN_FORBIDDEN, `actor "${actor.id}" is deny-listed for stable promotion`);
      }
    }

    const key = `${record.kind}/${record.name}`;
    this.#selectors.set(`${key}@${to}`, resolved.digest);
    return { ref: `${key}@${record.version}`, digest: resolved.digest, channel: to };
  }

  /** Instantaneous and always safe: it moves a pointer, and in-flight runs hold digests. */
  rollback(kind: ResourceKind, name: string, toVersion: number, actor: PolicyActor): ResolvedRef {
    const record = (this.#versions.get(`${kind}/${name}`) ?? []).find((v) => v.version === toVersion);
    if (record === undefined) {
      throw err.notFound(CODES.E_RESOURCE_NOT_FOUND, `${kind}/${name}@${toVersion} does not exist`);
    }
    this.#selectors.set(`${kind}/${name}@stable`, record.digest);
    return { ref: `${kind}/${name}@${toVersion}`, digest: record.digest, channel: "stable" };
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
    return out.sort((a, b) => (a.kind + a.name).localeCompare(b.kind + b.name) || a.version - b.version);
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
