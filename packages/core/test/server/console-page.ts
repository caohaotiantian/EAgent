/**
 * The console's own script, running against a live plane — shared by every test file that needs
 * to drive it rather than re-testing `applyEvent` in isolation.
 *
 * Not a `.test.ts` file: `npm test` globs every such file under `test/`, and a file under that
 * glob runs as its own suite. This one exists so two suites (`plane-watch-and-stop.test.ts`, which
 * built it, and `console.test.ts`, which drives the SSE-fold pin for A.45) can import ONE copy of
 * the DOM mock instead of each carrying a hand-rolled one that silently diverges — which is
 * exactly the kind of detail `openConsole`'s own comments below record having gotten wrong once
 * (`innerHTML`, `append`) before this file existed.
 *
 * NOT A BROWSER, and it does not pretend to be one: the DOM here is a bag of properties, so
 * nothing about rendering is under test. What IS under test is the half a static `assert.match`
 * on `CONSOLE_HTML` cannot reach — that the page's own script issues the right request, sends the
 * credential it holds, applies the reply the route sends back, and folds the events an SSE stream
 * actually carries the way `applyEvent` says it does. A test that issues requests ITSELF pins the
 * route, which `http.test.ts` already does; only this pins the page.
 *
 * `alert` and the timer are captured rather than ignored. The page reports every failure through
 * `alert(e.message)` and repaints through a 60 ms `setTimeout`, so an error in either is the page
 * not working — silently, if nothing is watching.
 */

import vm from "node:vm";

import { CONSOLE_HTML } from "../../src/server/console.ts";

export interface Page {
  run: (expr: string) => Promise<unknown>;
  alerts: string[];
  errors: string[];
  answers: string[];
}

export function openConsole(base: string, token: string, answer: () => string): Page {
  const script = CONSOLE_HTML.split("<script>")[1]!.split("</script>")[0]!;
  const alerts: string[] = [];
  const errors: string[] = [];
  const answers: string[] = [];
  const elements = new Map<string, Record<string, unknown>>();
  const element = (): Record<string, unknown> => {
    const children: Record<string, unknown>[] = [];
    // `innerHTML` is a real setter here, not a plain field. Four render functions clear it to
    // `""` and then re-populate via `appendChild`/`append` — `drawControls`, the non-empty
    // branch of `drawGates`, `loadRuns`, and `loadMine` — exactly what a browser's
    // `innerHTML = ""` does by removing every child node first.
    // Without this, a SECOND render of the same cached element (this mock reuses one object
    // per id — see `getElementById` below) appends onto whatever the first render already
    // left in `children`, instead of replacing it. That is what produced
    // `pause,advance,cancel,pause,advance,cancel`: `command()`'s own coalescing timer
    // (`invalidate()`, 60 ms) can fire a stray extra `draw()` after the last `command()` call
    // and before the test's own explicit render, and the mock's un-cleared `children` array
    // accumulated it. See `.agent/flake/plan.md` for the full trace.
    let html = "";
    const el: Record<string, unknown> = {
      textContent: "",
      title: "",
      className: "",
      value: "",
      placeholder: "",
      onclick: null,
      onchange: null,
      children,
      appendChild: (c: Record<string, unknown>) => void children.push(c),
      // `drawGates` calls `actions.append(yes, no)` (plural, `Element.append`), not
      // `appendChild` — a real DOM element has both, and this mock previously had neither
      // defined for `append`, which threw `TypeError: actions.append is not a function` the
      // moment a leftover `draw()` (the same coalescing-timer race above) landed while a gate
      // was open. That is a SECOND, independent way the same test could fail under load;
      // confirmed reachable by forcing a run to `awaiting_gate` before issuing any command and
      // calling `draw()` directly, which threw exactly that error before this line existed.
      append: (...cs: Record<string, unknown>[]) => void children.push(...cs),
    };
    Object.defineProperty(el, "innerHTML", {
      get: () => html,
      set: (v: string) => { html = String(v); children.length = 0; },
      enumerable: true,
      configurable: true,
    });
    return el;
  };
  const store = new Map<string, string>([["loom.token", token]]);
  const ctx = vm.createContext({
    document: {
      getElementById: (id: string) => {
        const found = elements.get(id) ?? element();
        elements.set(id, found);
        return found;
      },
      createElement: () => element(),
    },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    // RELATIVE, exactly as the page writes them — the base is the browser's, not the page's.
    fetch: (path: string, init?: RequestInit) => fetch(base + String(path), init),
    // Contained rather than ignored: a throw inside a repaint is an uncaught exception that
    // would take down the test file with no attribution.
    setTimeout: (fn: () => void, ms: number) => setTimeout(() => { try { fn(); } catch (e) { errors.push(String(e)); } }, ms),
    // A NO-OP. The page's 4 s poll would outlive the test and keep the process alive.
    setInterval: () => 0,
    AbortController,
    TextDecoder,
    alert: (m: string) => void alerts.push(String(m)),
    prompt: () => { const a = answer(); answers.push(a); return a; },
    console,
  });
  vm.runInContext(script, ctx);
  return { run: async (expr) => vm.runInContext(expr, ctx), alerts, errors, answers };
}
