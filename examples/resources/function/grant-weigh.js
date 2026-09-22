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

  // `Number.isFinite` AND NOT JUST `typeof`, because `Infinity` and `NaN` are numbers. A request
  // whose file says `"hours": 1e309` parses to `Infinity`, passed this check, was DENIED by
  // `firstDenial` for not being a whole number — and then failed the run at
  // `validation`/`E_RESOURCE_INVALID`, "non-finite number Infinity at hours", because `decision`
  // carries the raw value and the journal will not record one. A denial nobody can journal is a
  // denial nobody can read, so the value is refused here where the reason can still be said.
  for (const [field, kind] of [["who", "string"], ["resource", "string"], ["level", "string"], ["hours", "number"]]) {
    if (
      typeof req[field] !== kind ||
      (kind === "string" && req[field].trim() === "") ||
      (kind === "number" && !Number.isFinite(req[field]))
    ) {
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

  // A LEDGER THAT EXISTS AND WAS NOT READ IS A REFUSAL, AND THIS IS THE ONLY PLACE THAT CAN SEE IT.
  //
  // The `error` arm on `read-ledger` is handed no reason (F5), so `first-grant` reports "there is
  // no ledger yet" for a read that failed for ANY reason — including a ledger that is present and
  // unreadable, which `grant-record.js` would then REPLACE with a document built from nothing.
  // `look` runs `fs.glob` over the same path and its listing is the second opinion: glob lists a
  // file `fs.read` cannot open (measured at `chmod 222`), so **listing non-empty AND history from
  // the error arm** is exactly the case the arm cannot distinguish and this can.
  //
  // THIS DEFENCE COVERS EXACTLY ONE CASE AND FAILS OPEN ON THE REST, which is the same shape as
  // the hole it is standing in for, and saying so is the point of the comment.
  //
  //   COVERED: a regular file that is LISTABLE but not readable (`chmod 222` on the ledger).
  //   UNCOVERED BY THIS DEFENCE, each measured — and they DO NOT END ALIKE, which is the part
  //   worth reading:
  //     · an unlistable PARENT directory — `chmod 333 out`. fs.glob skips it, and the run
  //       SUCCEEDS and REWRITES the ledger. This is the silent data loss, and the only one.
  //       Pinned as a KNOWN HAZARD test so it cannot stop existing quietly.
  //     · an escaping SYMLINK at the path — fs.glob skips it. The run fails CLOSED, ledger
  //       intact, for a reason this defence had nothing to do with: `write-ledger` meets the
  //       same obstruction `read-ledger` did (`write-grant` lands first and is compensated).
  //     · a DIRECTORY at the path — fs.glob lists files. Same ending as the symlink.
  //
  // All three make fs.glob answer `(no matches)`, which is byte-identical to its answer for "there
  // is nothing here" — so `ledgerOnDisk` is false and the run proceeds. Four patterns were tried
  // (`out/access-ledger.json`, `out/*`, `out/**`, `out`) and none distinguishes "empty" from
  // "cannot enumerate". **A guard that fails open is being guarded by a guard that fails open**;
  // only a failure projection from the runtime closes it, which is why F5 stays a PRODUCT row.
  //
  // It also has a TOCTOU window: the file can appear or vanish between `look` and `read-ledger`.
  // That race loses in the failing-CLOSED direction — a spurious refusal, never a spurious grant —
  // which is the one part of this shape that is safe by construction.
  const listing = String(view.require("listing")).trim();
  const ledgerOnDisk = listing !== "" && listing !== "(no matches)";
  if (ledgerOnDisk && history.source === "none") {
    return {
      refuse: {
        reason:
          `"out/access-ledger.json" IS on disk — fs.glob lists it as "${listing}" — but the run reached ` +
          `here on the error arm, which means fs.read could not open it and this graph was told only ` +
          `that it failed. Granting now would publish a ledger rebuilt from an empty history and ` +
          `destroy every grant the file already holds. Fix the file's permissions, or move it aside ` +
          `deliberately if you mean to start a new ledger.`,
      },
    };
  }

  // DENIALS BEFORE RENEWALS, and the reason is the cap and ONLY the cap: `firstDenial` refuses
  // anything over `maxHours`, so no renewal can be reached by a request that exceeds it. It does
  // NOT stop a renewal from widening what was already approved — that is `findRenewal`'s own job,
  // and it is where the three bounds live. An earlier version of this comment claimed the ordering
  // prevented widening; it does not, and the measurement that showed so is in §3 of
  // `docs/workflow-port-2026-09-22b.md` (a human-approved 4h write followed by an `auto` 24h
  // "renewal" of it).
  const denial = firstDenial();
  const renewal = denial === null ? findRenewal() : null;

  const ceremony =
    denial !== null ? "deny" : renewal !== null ? "auto" : tier === "public" && req.level === "read" ? "auto" : "review";

  // A RENEWAL'S `why` NAMES BOTH SIDES, so the record cannot describe a WIDER grant as a renewal:
  // the level and the hours a person actually approved are printed beside the ones being granted
  // now, and `findRenewal` has already refused to return anything that widens either. An earlier
  // version printed only the prior level and the age, and said "this is a renewal and not a new
  // grant" over a 24h grant renewing a 4h approval.
  const why =
    denial !== null
      ? denial
      : renewal !== null
        ? `a person granted ${req.who} ${renewal.level}/${renewal.hours}h on ${req.resource} ` +
          `${hoursAgo(renewal)} hours ago, inside the policy's ${pol.renewalWithinHours}-hour window; ` +
          `this asks for ${req.level}/${req.hours}h, which is no wider, so it renews that decision ` +
          `rather than making a new one`
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

  // A RENEWAL SKIPS THE PERSON, SO IT IS BOUNDED THREE WAYS AND EVERY ONE OF THEM IS LOAD-BEARING.
  // Each has a test that goes red when it alone is deleted — see `examples-grant.test.ts`, which
  // exists because the first version of this body had two of these guards and a suite that stayed
  // 16/16 green with EITHER of them removed.
  //
  //   1. A PERSON DECIDED THE PRIOR GRANT. Only `decidedByKind: "human"` starts a window. Without
  //      this, an auto-renewal is itself renewable and its fresh `grantedAt` restarts the clock,
  //      so ONE approval chains into indefinite access — measured: a grant expired 718 hours ago
  //      renewed `auto`, because the window is measured from `grantedAt` and every renewal reset
  //      it. The window now always ends 720 hours after the last time a human said yes.
  //   2. A RENEWAL MAY NOT WIDEN. Not the level (a prior `read` cannot carry a requested `write`)
  //      and not the duration (a prior 4h cannot carry a requested 24h). Widening is a NEW
  //      decision and goes to a person. `firstDenial` does not cover this: it enforces the
  //      policy's cap, and 24h of write is inside the 24h cap — so without this guard a human who
  //      approved four hours had authorised a day.
  //   3. IT IS STILL INSIDE THE WINDOW, measured from the prior grant's own `grantedAt`.
  //
  // Same-or-higher on the level, rather than equal: somebody trusted with `admin` yesterday does
  // not need a second person to be handed `read` today, and requiring an exact match would send
  // the NARROWER request to a human while the wider one sailed through.
  //
  // WHAT "HIGHER" MEANS IS `pol.levels`' ARRAY ORDER and nothing else — that array is the privilege
  // lattice, and `access/policy.json`'s own `note` says so, because reordering it silently
  // redefines which grants outrank which.
  function findRenewal() {
    const windowMs = Number(pol.renewalWithinHours) * 3_600_000;
    if (!Number.isFinite(windowMs) || windowMs <= 0) return null;
    const now = ctx.now();
    let best = null;
    for (const g of history.grants) {
      if (g === null || typeof g !== "object") continue;
      if (g.decidedByKind !== "human") continue;
      const priorRank = pol.levels.indexOf(g.level);
      if (priorRank < 0 || priorRank < rank) continue;
      const priorHours = Number(g.hours);
      if (!Number.isFinite(priorHours) || req.hours > priorHours) continue;
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
    // `JSON.stringify(Infinity)` is the string "null", so the obvious formatter reported a
    // non-finite `hours` as "number null" — which reads as a missing field and sends whoever is
    // holding the request looking for one. `String()` says `Infinity`.
    if (typeof v === "number" && !Number.isFinite(v)) return `the non-finite number ${String(v)}`;
    return `${typeof v} ${JSON.stringify(v)}`;
  }
}
