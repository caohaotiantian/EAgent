/**
 * Image attachment.
 *
 * Two routes, both ending in a kernel `ImageBlock`:
 *   - an `@path/to/shot.png` mention, which the `@` popup already completes;
 *   - `Ctrl+V`-style clipboard paste, via a platform command.
 *
 * The path route is the reliable one and needs no external binary. Clipboard
 * reading is genuinely platform-specific and may simply be unavailable, which
 * `clipboardImageCommand` reports rather than papering over.
 */

/** Extensions the providers accept as inline image data. */
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export const isImagePath = (path: string): boolean => {
  const dot = path.lastIndexOf(".");
  return dot !== -1 && IMAGE_EXT.has(path.slice(dot).toLowerCase());
};

/** Media type for a path, or null when it is not an image we can attach. */
export function mediaType(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = path.slice(dot).toLowerCase();
  if (!IMAGE_EXT.has(ext)) return null;
  return ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : `image/${ext.slice(1)}`;
}

/**
 * The `@`-mentioned paths in a prompt that point at images.
 *
 * Anchored the same way the popup's trigger is — start of input or after
 * whitespace — so an email address is never mistaken for an attachment.
 */
export function imageMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)@(\S+)/g)) {
    const path = m[1];
    if (path !== undefined && isImagePath(path)) out.push(path);
  }
  return out;
}

/**
 * The command that writes a clipboard image to `file`, or null when this
 * platform has no way to do it. Returned as data so the caller spawns it and
 * tests never need a clipboard.
 */
export function clipboardImageCommand(
  platform: string,
  file: string,
): { command: string; args: string[] } | null {
  if (platform === "darwin") {
    // AppleScript is always present on macOS; `pngpaste` is not.
    return {
      command: "osascript",
      args: ["-e", `set f to open for access POSIX file "${file}" with write permission`,
             "-e", "try",
             "-e", "write (the clipboard as «class PNGf») to f",
             "-e", "end try",
             "-e", "close access f"],
    };
  }
  if (platform === "linux") {
    return { command: "sh", args: ["-c", `xclip -selection clipboard -t image/png -o > '${file}'`] };
  }
  return null;
}
