/**
 * A shared convention for in-place provider wrappers.
 *
 * A wrapper that re-registers under the SAME name (the `watchdog` idle-deadline
 * wrapper is the sole current example) shadows the concrete provider in the
 * registry — the agent resolves by name each turn, so occupying the name is the
 * whole mechanism. But code that must reach the underlying provider (registry
 * introspection, or reconfiguring the scriptable mock in `evals`/tests) then sees
 * the wrapper, not the concrete provider. A wrapper attaches the provider it
 * guards as `wrappedInner`; `unwrapProvider` returns that inner provider (or the
 * provider unchanged when it is not a wrapper), so a caller can see through one
 * layer of same-name wrapping without coupling to any specific wrapper.
 */

import type { Provider } from "../../kernel/types.js";

/** A same-name provider wrapper carrying a reference to the provider it guards. */
export interface WrappedProvider extends Provider {
  readonly wrappedInner: Provider;
}

/** The provider `p` guards if it is a wrapper, else `p` unchanged. */
export function unwrapProvider(p: Provider): Provider {
  return (p as Partial<WrappedProvider>).wrappedInner ?? p;
}
