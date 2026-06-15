/**
 * The four built-in tools — read, write, edit, bash — shipped as a single
 * extension. This is the "everything is an extension" rule applied to the
 * kernel itself: the core has no hard-coded tools, it just loads this.
 *
 * Each tool declares the capability it needs, so the kernel's permission layer
 * mediates filesystem and shell access uniformly.
 */

import { exec } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

import { defineTool, fail, ok } from "../kernel/define.js";
import type { ExtensionAPI } from "../kernel/extension.js";

const execAsync = promisify(exec);

export default function activate(e: ExtensionAPI): void {
  e.grantCapability("fs:read");
  e.grantCapability("fs:write");
  // shell:exec is intentionally NOT auto-granted: bash should prompt/deny by
  // default unless the host policy opts in.

  e.registerTool(
    defineTool({
      name: "read",
      description: "Read a UTF-8 text file. Optionally slice by line range.",
      capabilities: ["fs:read"],
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read." },
          offset: { type: "integer", description: "1-based first line to return." },
          limit: { type: "integer", description: "Maximum number of lines to return." },
        },
        required: ["path"],
      },
      execute: (args) => {
        const path = String(args.path);
        let lines: string[];
        try {
          lines = readFileSync(path, "utf8").split("\n");
        } catch (err) {
          return fail(`Cannot read ${path}: ${(err as Error).message}`);
        }
        const start = args.offset ? Math.max(0, Number(args.offset) - 1) : 0;
        const end = args.limit ? start + Number(args.limit) : lines.length;
        const slice = lines.slice(start, end);
        const numbered = slice.map((l, i) => `${String(start + i + 1).padStart(5)}  ${l}`).join("\n");
        return ok(numbered, { path, lineCount: lines.length });
      },
    }),
  );

  e.registerTool(
    defineTool({
      name: "write",
      description: "Write (create or overwrite) a UTF-8 text file.",
      capabilities: ["fs:write"],
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to write." },
          content: { type: "string", description: "Full file contents." },
        },
        required: ["path", "content"],
      },
      execute: (args) => {
        const path = String(args.path);
        try {
          writeFileSync(path, String(args.content));
        } catch (err) {
          return fail(`Cannot write ${path}: ${(err as Error).message}`);
        }
        return ok(`Wrote ${Buffer.byteLength(String(args.content))} bytes to ${path}`);
      },
    }),
  );

  e.registerTool(
    defineTool({
      name: "edit",
      description: "Replace an exact substring in a file. Fails if not found or ambiguous.",
      capabilities: ["fs:read", "fs:write"],
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old: { type: "string", description: "Exact text to replace." },
          new: { type: "string", description: "Replacement text." },
          replaceAll: { type: "boolean", description: "Replace every occurrence.", default: false },
        },
        required: ["path", "old", "new"],
      },
      execute: (args) => {
        const path = String(args.path);
        let content: string;
        try {
          content = readFileSync(path, "utf8");
        } catch (err) {
          return fail(`Cannot read ${path}: ${(err as Error).message}`);
        }
        const oldStr = String(args.old);
        const count = content.split(oldStr).length - 1;
        if (count === 0) return fail(`Text not found in ${path}.`);
        if (count > 1 && !args.replaceAll) {
          return fail(`Text appears ${count} times in ${path}; pass replaceAll or make it unique.`);
        }
        const updated = args.replaceAll
          ? content.split(oldStr).join(String(args.new))
          : content.replace(oldStr, String(args.new));
        try {
          writeFileSync(path, updated);
        } catch (err) {
          return fail(`Cannot write ${path}: ${(err as Error).message}`);
        }
        return ok(`Edited ${path} (${count} replacement${count === 1 ? "" : "s"}).`);
      },
    }),
  );

  e.registerTool(
    defineTool({
      name: "bash",
      description: "Run a shell command and return its combined stdout/stderr.",
      capabilities: ["shell:exec"],
      // A sequential tool: shell side effects should not interleave with peers.
      executionMode: "sequential",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to execute via /bin/sh." },
          timeout: { type: "integer", description: "Timeout in milliseconds.", default: 120000 },
        },
        required: ["command"],
      },
      execute: async (args, ctx) => {
        const command = String(args.command);
        const timeout = Number(args.timeout ?? 120000);
        try {
          const { stdout, stderr } = await execAsync(command, {
            timeout,
            signal: ctx.signal,
            maxBuffer: 8 * 1024 * 1024,
          });
          const out = [stdout, stderr].filter(Boolean).join("\n").trim();
          return ok(out || "(no output)");
        } catch (err) {
          const e2 = err as { stdout?: string; stderr?: string; message: string };
          const out = [e2.stdout, e2.stderr].filter(Boolean).join("\n").trim();
          return fail(out || e2.message);
        }
      },
    }),
  );

  e.registerCommand({
    name: "tools",
    description: "List registered tools.",
    run: (ctx) => {
      const lines = ctx.agent.tools.list().map((t) => `  ${t.spec.name.padEnd(12)} ${t.spec.description}`);
      ctx.print(lines.length ? lines.join("\n") : "(no tools registered)");
    },
  });
}
