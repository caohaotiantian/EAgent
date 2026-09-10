/**
 * ONE RULE FOR "WHAT MAY A DOOR SHOW OF A CHANNEL", because there were two spellings of it.
 *
 * WHY THIS FILE EXISTS. `server/http.ts` had a private `redactChannels` and `cli.ts` a private
 * `redactGateRead`, and the second one's own docstring said what was wrong with it: *"IT IS A
 * SECOND SPELLING AND THAT IS A SEAM, NOT A DECISION … the honest fix is one shared function,
 * and it belongs to whoever owns that file next."* Two spellings of a redaction rule fail one
 * way: a classification added later is handled by one door and not the other, silently, on the
 * one axis where the non-negotiable says *refusing is always allowed; loosening never is*.
 * `TODO.md` §H.8.
 *
 * WHY HERE AND NOT IN `redact.ts`. `index.ts` re-exports `security/redact.ts` wholesale, so
 * putting these two names there would add two entries to the pinned public surface
 * (`scripts/surface.json`) for a seam that exists only between two internal doors. Nothing
 * re-exports this file; both callers import it directly, and neither has to reach into the
 * other's private surface — which is the shape §H.8 asked for.
 *
 * THE RULE, THREE ARMS, FAILING CLOSED AT BOTH ENDS:
 *
 *   - a name NO spec declares is `secret_ref`. A plane or a CLI that does not hold the graph a
 *     run compiled cannot know which of these names is a credential, and falling back to
 *     `internal` IS the leak. What it costs is bounded and visible: the gate, its approvers and
 *     its deadline all still arrive; only the values are withheld.
 *   - a DECLARED name with no `classification` is `internal`, the documented default and the
 *     detector backstop, so an ordinary unclassified channel reaches an approver unchanged.
 *   - anything else goes through `maxClassification`, which is `vocab.ts`'s membership test and
 *     answers `secret_ref` for a word this vocabulary cannot read.
 *
 * THE VALUE FUNCTION IS THE PRIMITIVE AND THE MAP IS BUILT ON IT, deliberately in that order.
 * `server/http.ts`'s `redactBinding` already argued the point for a one-entry map — "IT IS
 * `redactChannels` WITH ONE ENTRY, NOT A FOURTH SPELLING OF THE LOOKUP" — and it was right
 * about the rule and wrong about which way the dependency should run: the CLI's door has one
 * value and no map at all, so a map-only primitive forced it to fabricate `{[name]: value}` and
 * unwrap the answer. One value in, one value out; the map form is a loop.
 */

import { maxClassification, type Classification } from "../vocab.ts";
import { redactPayload } from "./redact.ts";

/** Everything either door needs of a channel's spec. Wider than `ChannelSpec` on purpose. */
export interface ClassifiedChannel {
  readonly classification?: Classification;
}

/**
 * An OWN property of a record, or `undefined` — never `Object.prototype`'s.
 *
 * A bare `channels[name]` answers the `Object` FUNCTION for `constructor`, whose
 * `classification` is `undefined`, which reads as "declared, unclassified" — a name nothing
 * declared, treated as safe. `__proto__` is excluded outright rather than looked up: a channel
 * map parsed from JSON CAN carry it as an own property, and a door is not the place to decide
 * that a graph naming a channel `__proto__` meant it.
 */
function own<T>(rec: Readonly<Record<string, T>>, name: string): T | undefined {
  return name !== "__proto__" && Object.prototype.hasOwnProperty.call(rec, name) ? rec[name] : undefined;
}

/**
 * ONE channel value, swept under the classification THAT channel's spec declared.
 *
 * `channels` being `undefined` is the fail-closed answer and not a shortcut: it means the door
 * does not hold the graph, and every value it is about to show is therefore unclassifiable.
 */
export function redactChannelValue(
  channels: Readonly<Record<string, ClassifiedChannel>> | undefined,
  name: string,
  value: unknown,
): unknown {
  const declared = channels === undefined ? undefined : own(channels, name);
  if (declared === undefined || declared === null) return redactPayload(value, "secret_ref");
  const c = declared.classification;
  return redactPayload(value, c === undefined ? "internal" : maxClassification(c));
}

/**
 * A whole channel map, each value swept by its own spec.
 *
 * A NON-MAP FALLS BACK TO `internal` RATHER THAN REFUSING, which is `server/http.ts`'s
 * behaviour kept unchanged: the callers hand this a projection's `channels`, its `outputs` and
 * an event payload, and a journal is authoritative rather than well-formed. There is no name
 * to look up for a value that is not an object, so the detector backstop is the only mechanism
 * left — and it is the one an unclassified value would have had anyway.
 */
export function redactChannelMap(
  value: unknown,
  channels: Readonly<Record<string, ClassifiedChannel>> | undefined,
): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return redactPayload(value, "internal");
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, v]) => [name, redactChannelValue(channels, name, v)]),
  );
}
