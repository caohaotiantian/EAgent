// The router's FALLBACK arm: the policy decided, and the answer is no.
//
// It refuses, so the run fails `validation`/`E_FUNCTION_REFUSED` and exits 1 — which is the point.
// A denied access request that exited 0 with an empty `out/` would be indistinguishable, to the
// script that called it, from a granted one whose write silently failed. The reason is
// `decision.why`, computed by `grant-weigh.js` where the rule that said no is still in hand; this
// node does not re-derive it, because a second copy of a rule table is a second answer waiting to
// disagree with the first.
//
// IT IS THE FALLBACK EDGE AND NOT A CASE, deliberately. `route` names `auto` and `review`
// explicitly and sends EVERYTHING ELSE here. A ceremony this graph has no case for is a ceremony
// nobody wrote an arm for, and the failing-closed answer to that is to decline — not to pick the
// nearest arm, and certainly not the one that grants access.
(view, ctx) => {
  const d = view.require("decision");
  return {
    refuse: {
      reason:
        `access DENIED for ${d.who} on ${d.resource} (${d.level}, ${d.hours}h, request ` +
        `${d.requestId}): ${d.why}. Nothing was written and no grant exists.`,
    },
  };
}
