// OS clipboard access for the text fields' copy/cut/paste. In raw mode the terminal hands
// Ctrl+C/V/X straight to us as control bytes, so the app has to talk to the clipboard itself
// rather than relying on the terminal's own paste.
//
// NOTE: copying a secret puts its plaintext on the system clipboard, where any other app can
// read it. That is the user explicitly asking for it, but it is a real exposure - the README
// says so next to the keybinding.
import { spawnSync } from "node:child_process";

/** Used when no OS clipboard tool is reachable, so copy/paste still works within the app. */
let fallback = "";

/** True only if a real OS clipboard tool took it; false means only the in-process fallback
 * holds it, so pasting into another app will NOT work. Callers that promise the user a
 * clipboard copy must say so when this is false. */
export function writeClipboard(text: string): boolean {
  fallback = text;
  try {
    const r =
      process.platform === "win32"
        ? spawnSync("clip", [], { input: text })
        : process.platform === "darwin"
          ? spawnSync("pbcopy", [], { input: text })
          : spawnSync("xclip", ["-selection", "clipboard"], { input: text });
    return !r.error && r.status === 0;
  } catch {
    // keep the in-process fallback
    return false;
  }
}

export function readClipboard(): string {
  try {
    if (process.platform === "win32") {
      const r = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"],
        { encoding: "utf-8" },
      );
      // Get-Clipboard -Raw still appends a trailing newline; a pasted secret must not carry one.
      if (r.status === 0 && typeof r.stdout === "string") return r.stdout.replace(/\r?\n$/, "");
    } else if (process.platform === "darwin") {
      const r = spawnSync("pbpaste", [], { encoding: "utf-8" });
      if (r.status === 0 && typeof r.stdout === "string") return r.stdout;
    } else {
      const r = spawnSync("xclip", ["-selection", "clipboard", "-o"], { encoding: "utf-8" });
      if (r.status === 0 && typeof r.stdout === "string") return r.stdout;
    }
  } catch {
    // fall through
  }
  return fallback;
}
