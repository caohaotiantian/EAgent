/**
 * Slash-command registry. Commands are the user-facing verbs a host (the CLI)
 * dispatches, analogous to Emacs interactive commands / `M-x`. Like tools, a
 * later registration shadows an earlier one and disposing restores it.
 */

import type { Agent } from "./agent.ts";
import type { Disposable } from "./types.ts";

export interface CommandContext {
  agent: Agent;
  /** Raw argument string after the command name. */
  args: string;
  /** Print a line to the user. */
  print(line: string): void;
}

export interface Command {
  name: string;
  description: string;
  run(ctx: CommandContext): void | Promise<void>;
}

export class CommandRegistry {
  readonly #commands = new Map<string, Command[]>();

  register(command: Command): Disposable {
    let stack = this.#commands.get(command.name);
    if (!stack) this.#commands.set(command.name, (stack = []));
    stack.push(command);
    return {
      dispose: () => {
        const s = this.#commands.get(command.name);
        if (!s) return;
        const i = s.lastIndexOf(command);
        if (i >= 0) s.splice(i, 1);
        if (s.length === 0) this.#commands.delete(command.name);
      },
    };
  }

  get(name: string): Command | undefined {
    return this.#commands.get(name)?.at(-1);
  }

  list(): Command[] {
    return [...this.#commands.keys()].sort().map((n) => this.#commands.get(n)!.at(-1)!);
  }
}
