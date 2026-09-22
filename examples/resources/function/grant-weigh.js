// The only node that decides anything: request × policy × history → the CEREMONY.
//
// WHY THIS IS A `function` AND NOT AN `agent`. Every term is read off, not inferred: the tier is a
// lookup, the cap is a lookup, the level is an index into a declared list, and a renewal is a date
// comparison. There is no judgement in any of it, so a model would add nothing but a second
// opinion nobody could audit. The judgement that IS worth a model — does the stated REASON justify
// this access — is the thing this graph refuses to guess at. It puts the reason in front of the
// person at the gate and lets them answer it.
//
// THE SPLIT BETWEEN A REFUSAL AND A DENIAL IS THE DESIGN, and it is the same split both earlier
// ports make. A REFUSAL (`{refuse}`) means *this graph cannot decide*: the document is malformed,
// truncated, or missing a field the rules key off. A DENIAL (`ceremony: "deny"`) means *this graph
// decided, and the answer is no* — a real outcome, routed to `deny` by the router's fallback edge
// and carrying the policy rule that said so. Answering "cannot decide" with a denial would tell a
// requester their access was refused on the merits when in fact nobody looked.
(view, ctx) => {
  const request = parse(view.require("request"), "the request", 'the "read-request" node');
  if (request.refuse !== undefined) return request;
  const policy = parse(view.require("policyDoc"), "access/policy.json", 'the "read-policy" node');
  if (policy.refuse !== undefined) return policy;

  const req = request.value;
  const pol = policy.value;

  for (const [field, kind] of [["who", "string"], ["resource", "string"], ["level", "string"], ["hours", "number"]]) {
    if (typeof req[field] !== kind || (kind === "string" && req[field].trim() === "")) {
      return {
        refuse: {
          reason:
            `the request declares no usable \`${field}\` (found ${describe(req[field])}, wanted a ` +
            `${kind === "string" ? "non-empty string" : "number"}). Every rule in this policy keys off ` +
            `who, resource, level and hours; a request missing one of them cannot be decided either ` +
            `way, and defaulting it would grant or deny on a value nobody wrote.`,
        },
      };
    }
  }
  if (!isPlainObject(pol.resources) || !Array.isArray(pol.levels) || !isPlainObject(pol.maxHours)) {
    return {
      refuse: {
        reason:
          `"access/policy.json" is JSON but not an access policy: it needs \`resources\`, \`levels\` ` +
          `and \`maxHours\`. Without them every request would fall through to the same answer, and a ` +
          `policy that says the same thing about everything is not a policy.`,
      },
    };
  }

  const history = view.require("history");
  const resource = Object.hasOwn(pol.resources, req.resource) ? pol.resources[req.resource] : undefined;
  const tier = resource === undefined ? null : String(resource.tier);
  const owners = resource === undefined || !Array.isArray(resource.owners) ? [] : resource.owners.map(String);
  const rank = pol.levels.indexOf(req.level);
  const cap = Object.hasOwn(pol.maxHours, req.level) ? pol.maxHours[req.level] : undefined;

  // THE RULES, IN ORDER, AND THE ORDER IS LOAD-BEARING. Every denial is checked before any
  // renewal is looked for: a prior grant is a reason to skip the human, never a reason to exceed
  // the cap. Inverting these two would let somebody widen an expired grant by re-asking for it.
  const denial = firstDenial();
  const renewal = denial === null ? findRenewal() : null;

  const ceremony =
    denial !== null ? "deny" : renewal !== null ? "auto" : tier === "public" && req.level === "read" ? "auto" : "review";

  const why =
    denial !== null
      ? denial
      : renewal !== null
        ? `${req.who} was already granted ${renewal.level} on ${req.resource} ${hoursAgo(renewal)} hours ago, ` +
          `within the policy's ${pol.renewalWithinHours}-hour renewal window, so this is a renewal and not a new grant`
        : ceremony === "auto"
          ? `${req.resource} is public-tier and this asks only to read it`
          : `${req.resource} is ${tier}-tier and this asks to ${req.level} it, which no rule grants without a person`;

  return {
    writes: {
      decision: {
        requestId: typeof req.id === "string" ? req.id : "(no id)",
        who: req.who,
        resource: req.resource,
        level: req.level,
        hours: req.hours,
        reason: typeof req.reason === "string" ? req.reason : "(none given)",
        tier,
        owners,
        cap: cap === undefined ? null : cap,
        ceremony,
        why,
        // WHERE THE HISTORY CAME FROM, carried all the way to the gate. "No prior grants" and "we
        // never found the ledger" are different facts and a person deciding must be able to tell
        // them apart — `source: "none"` is the first run of this command, and nothing else.
        historySource: history.source,
        renewalOf: renewal === null ? null : { at: renewal.grantedAt, level: renewal.level, by: renewal.decidedBy },
        priorGrants: history.grants.map((g) => ({ at: g.grantedAt, level: g.level, hours: g.hours, by: g.decidedBy })),
        decidedAt: ctx.now(),
      },
    },
  };

  function firstDenial() {
    if (resource === undefined) {
      const known = Object.keys(pol.resources).sort();
      return `"${req.resource}" is not a resource this policy knows (it declares ${known.map((k) => `"${k}"`).join(", ")}). A resource nobody has written a tier for has no ceremony, and guessing one would invent a policy`;
    }
    if (rank < 0) {
      return `"${req.level}" is not an access level this policy declares (it declares ${pol.levels.map((l) => `"${l}"`).join(", ")})`;
    }
    if (!Number.isInteger(req.hours) || req.hours <= 0) {
      return `\`hours\` is ${describe(req.hours)}; a grant needs a whole number of hours greater than zero, because it is what the expiry is computed from`;
    }
    if (typeof cap !== "number") {
      return `this policy declares no \`maxHours\` for "${req.level}", so there is no ceiling to check this request against`;
    }
    if (req.hours > cap) {
      return `${req.hours}h of ${req.level} exceeds this policy's ${cap}h ceiling for ${req.level} access`;
    }
    if (tier === "secret" && req.level === "admin") {
      return `admin on a secret-tier resource is never granted through an access request — ${req.resource} holds key material, and that change goes through the break-glass procedure with both owners present`;
    }
    return null;
  }

  // A RENEWAL IS A PRIOR GRANT AT THIS LEVEL OR HIGHER, STILL INSIDE THE WINDOW. Same-or-higher
  // rather than equal: somebody who was trusted with `admin` last week does not need a second
  // person to be handed `read` today, and requiring an exact match would send the WIDER grant
  // through automatically and the narrower one to a human.
  function findRenewal() {
    const windowMs = Number(pol.renewalWithinHours) * 3_600_000;
    if (!Number.isFinite(windowMs) || windowMs <= 0) return null;
    const now = ctx.now();
    let best = null;
    for (const g of history.grants) {
      if (g === null || typeof g !== "object") continue;
      const priorRank = pol.levels.indexOf(g.level);
      if (priorRank < rank) continue;
      const at = Number(g.grantedAt);
      if (!Number.isFinite(at) || now - at > windowMs || at > now) continue;
      if (best === null || at > Number(best.grantedAt)) best = g;
    }
    return best;
  }

  function hoursAgo(g) {
    return Math.round((ctx.now() - Number(g.grantedAt)) / 3_600_000);
  }

  function parse(raw, what, who) {
    if (/\n…\[truncated \d+ chars\]$/.test(raw)) {
      return {
        refuse: {
          reason:
            `${what} was read back TRUNCATED (${raw.length} chars). A prefix of a policy document is a ` +
            `policy with rules missing from it, and every missing rule reads here as "no such rule" — ` +
            `which is the permissive direction. Raise maxBytes on ${who}.`,
        },
      };
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch (e) {
      return {
        refuse: {
          reason:
            `${what} is not JSON (${String(e && e.message ? e.message : e)}). This graph decides who ` +
            `may reach a production resource by reading fields off a JSON document; a document it ` +
            `cannot read has no fields, and a request with no fields matches no denial rule.`,
        },
      };
    }
    if (!isPlainObject(value)) {
      return {
        refuse: {
          reason:
            `${what} parses as ${describe(value)}, not an object. Every rule here is a property ` +
            `lookup, and every lookup on a non-object is \`undefined\` — so the whole rule table ` +
            `would abstain and the request would read as unremarkable.`,
        },
      };
    }
    return { value };
  }

  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function describe(v) {
    if (v === undefined) return "nothing";
    if (v === null) return "null";
    if (Array.isArray(v)) return `an array of ${v.length}`;
    return `${typeof v} ${JSON.stringify(v)}`;
  }
}
