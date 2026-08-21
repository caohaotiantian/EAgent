/**
 * `/config` — inspect and override centralized configuration.
 *
 * EAgent's configuration is one layered surface (`e.config`): every knob resolves
 * `override > env > file > default` (value keys) and every extension's enablement
 * resolves `env-veto > override > store > default`. This command makes that
 * surface *discoverable and tunable at runtime* — the single answer to "what can
 * I configure, and what is it set to?" that previously required grepping ~50
 * files.
 *
 *   /config                 — same as `list`
 *   /config list            — every touched key: value + winning source
 *   /config get <key>       — one key's resolved value + source
 *   /config set <key> <val> — write the persisted runtime override (val is
 *                             coerced: true/false → boolean, a number → number)
 *   /config unset <key>     — drop the override for <key>
 *   /config reload          — re-read the JSON config file layer
 *
 * `/config set` writes the *override* layer (trusted, interactive) — it may set
 * value keys and enablement keys alike; the untrusted vector is the config file,
 * which never affects enablement. Secret-substring keys are never printed.
 * Kill switch: `EAGENT_CONFIG=off`.
 */

import type { ExtensionAPI } from "../kernel/extension.ts";
import { isSecretKey } from "../config.ts";

/** Coerce a raw `/config set` token to a boolean, a number, or the string. */
function coerce(raw: string): string | number | boolean {
  const v = raw.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (v !== "" && Number.isFinite(Number(v))) return Number(v);
  return v;
}

export default function activate(e: ExtensionAPI): void {
  const enabled = (): boolean => e.config.enabled("config", { default: true });

  e.registerCommand({
    name: "config",
    description:
      "Inspect/override centralized configuration: /config [list | get <key> | set <key> <val> | unset <key> | reload]",
    run: (ctx) => {
      if (!enabled()) {
        ctx.print("config is disabled (EAGENT_CONFIG=off).");
        return;
      }
      const argv = ctx.args.trim().split(/\s+/).filter((s) => s.length > 0);
      const sub = argv[0] ?? "list";

      if (sub === "list") {
        const entries = e.config.entries();
        if (entries.length === 0) {
          ctx.print("(no configuration values read yet this session)");
          return;
        }
        for (const { key, value, source } of entries) {
          ctx.print(`  ${key.padEnd(32)} ${String(value ?? "").padEnd(24)} [${source}]`);
        }
        return;
      }

      if (sub === "get") {
        const key = argv[1];
        if (!key) {
          ctx.print("usage: /config get <key>");
          return;
        }
        const hit = e.config.entries().find((en) => en.key === key);
        // Touch the key so it resolves even if never read before.
        const raw = hit ? hit.value : e.config.get<unknown>(key, undefined);
        // Hide secrets even on the fallback path (an env-only secret key is not in
        // entries(), so it would otherwise print raw — the exfiltration hole).
        const value = isSecretKey(key) ? "«hidden»" : raw;
        const source = hit?.source ?? "default";
        ctx.print(`${key} = ${String(value ?? "(unset)")} [${source}]`);
        return;
      }

      if (sub === "set") {
        const key = argv[1];
        if (!key || argv.length < 3) {
          ctx.print("usage: /config set <key> <value>");
          return;
        }
        const value = coerce(argv.slice(2).join(" "));
        e.config.set(key, value);
        ctx.print(`set ${key} = ${String(value)} (override)`);
        return;
      }

      if (sub === "unset") {
        const key = argv[1];
        if (!key) {
          ctx.print("usage: /config unset <key>");
          return;
        }
        e.config.unset(key);
        ctx.print(`unset ${key} (override cleared)`);
        return;
      }

      if (sub === "reload") {
        // The file layer lives on the host's LayeredConfig; reload it if present.
        const c = e.config as { reload?: () => void };
        c.reload?.();
        ctx.print("config: file layer reloaded.");
        return;
      }

      ctx.print(`Unknown subcommand "${sub}". Use list | get <key> | set <key> <val> | unset <key> | reload.`);
    },
  });
}
