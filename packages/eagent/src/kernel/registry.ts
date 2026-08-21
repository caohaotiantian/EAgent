/**
 * The tool and provider registries.
 *
 * Registration is the verb of the whole system: extensions register tools,
 * providers, commands, and hooks, and every registration hands back a
 * `Disposable` so a hot-reload can undo it precisely. A later registration of
 * the same tool name shadows the earlier one (Emacs redefinition), and
 * disposing it restores the previous definition.
 *
 * Note the two registries here are not symmetric: providers register by
 * overwrite (`Map.set` keyed by name) rather than by stack, so a later
 * provider with the same name silently replaces the earlier one with no
 * shadow to restore — and disposing the default provider promotes an
 * arbitrary remaining one rather than the previously shadowed definition.
 */

import type { Disposable, Provider, Tool } from "./types.ts";

export class ToolRegistry {
  /** name -> stack of definitions; the top of the stack is active. */
  readonly #tools = new Map<string, Tool[]>();

  register(tool: Tool): Disposable {
    const name = tool.spec.name;
    let stack = this.#tools.get(name);
    if (!stack) this.#tools.set(name, (stack = []));
    stack.push(tool);
    return {
      dispose: () => {
        const s = this.#tools.get(name);
        if (!s) return;
        const i = s.lastIndexOf(tool);
        if (i >= 0) s.splice(i, 1);
        if (s.length === 0) this.#tools.delete(name);
      },
    };
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name)?.at(-1);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /** Active tools (top of each stack), sorted by name for stable output. */
  list(): Tool[] {
    return [...this.#tools.keys()]
      .sort()
      .map((name) => this.#tools.get(name)!.at(-1)!)
      .filter(Boolean);
  }
}

export class ProviderRegistry {
  readonly #providers = new Map<string, Provider>();
  #default: string | undefined;

  register(provider: Provider, opts: { default?: boolean } = {}): Disposable {
    this.#providers.set(provider.name, provider);
    if (opts.default || this.#default === undefined) this.#default = provider.name;
    return {
      dispose: () => {
        this.#providers.delete(provider.name);
        if (this.#default === provider.name) {
          this.#default = this.#providers.keys().next().value;
        }
      },
    };
  }

  get(name?: string): Provider | undefined {
    return this.#providers.get(name ?? this.#default ?? "");
  }

  setDefault(name: string): void {
    if (this.#providers.has(name)) this.#default = name;
  }

  list(): Provider[] {
    return [...this.#providers.values()];
  }
}
