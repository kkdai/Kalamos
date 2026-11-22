/**
 * Platform helpers (macOS / Windows / Linux).
 *
 * Paths: the frontend works with forward-slash paths everywhere
 * (`/Users/me/a.md`, `C:/Users/me/a.md`, `//server/share/a.md`). On Windows
 * the IPC layer (src/ipc.ts) converts paths coming from Rust / dialogs to that
 * form (`toSlashPath`) and converts them back before handing them to Rust or
 * the asset protocol (`toNativePath`).
 *
 * Shortcuts: labels are written macOS-style (⌘ ⌥ ⇧, "Cmd+Opt+…");
 * `shortcutLabel` rewrites them as Ctrl / Alt / Shift on Windows and Linux.
 * CodeMirror's `Mod-` key bindings already map to Ctrl there.
 */

function detectPlatform(): "mac" | "windows" | "linux" | "other" {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent || "";
  if (/Windows NT|Win64|WOW64/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
  if (/Linux|X11/i.test(ua) && !/jsdom/i.test(ua)) return "linux";
  return "other";
}

const PLATFORM = detectPlatform();

/** True inside the Windows app (WebView2). False under jsdom / vitest. */
export const IS_WINDOWS = PLATFORM === "windows";
/** True on Windows / Linux, where shortcuts use Ctrl instead of ⌘. */
export const USES_CTRL = PLATFORM === "windows" || PLATFORM === "linux";

/** All Markdown extensions Kalamos opens (matches `open_with::MARKDOWN_EXTENSIONS`). */
export const MARKDOWN_EXTENSIONS = [
  "md",
  "markdown",
  "mdown",
  "mkd",
  "mkdn",
  "mdwn",
  "mdtxt",
] as const;

/** True when `path` ends with one of `MARKDOWN_EXTENSIONS`. */
export function isMarkdownFilePath(path: string): boolean {
  const clean = path.replace(/[?#].*$/, "");
  const dot = clean.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = clean.slice(dot + 1).toLowerCase();
  return (MARKDOWN_EXTENSIONS as readonly string[]).includes(ext);
}

/** `C:\a\b` → `C:/a/b`, `\\?\C:\a` → `C:/a`, `\\srv\share` → `//srv/share`. */
export function toSlashPath(path: string): string;
export function toSlashPath(path: string | null): string | null;
export function toSlashPath(path: string | null | undefined): string | null | undefined;
export function toSlashPath(path: string | null | undefined): string | null | undefined {
  if (!path || !IS_WINDOWS) return path;
  return windowsToSlash(path);
}

/** Forward-slash path → native path (backslashes on Windows). */
export function toNativePath(path: string): string;
export function toNativePath(path: string | null): string | null;
export function toNativePath(path: string | null | undefined): string | null | undefined;
export function toNativePath(path: string | null | undefined): string | null | undefined {
  if (!path || !IS_WINDOWS) return path;
  return path.replace(/\//g, "\\");
}

/** Pure conversion (exported for tests). */
export function windowsToSlash(path: string): string {
  let p = path;
  if (p.startsWith("\\\\?\\UNC\\")) p = `\\\\${p.slice(8)}`;
  else if (p.startsWith("\\\\?\\")) p = p.slice(4);
  return p.replace(/\\/g, "/");
}

/** Root of an absolute slash path: `/`, `C:/`, `//server/share/` (or ""). */
export function pathRoot(path: string): string {
  const unc = /^\/\/[^/]+\/[^/]+\/?/.exec(path);
  if (unc) return unc[0].endsWith("/") ? unc[0] : `${unc[0]}/`;
  const drive = /^[A-Za-z]:(?:\/|$)/.exec(path);
  if (drive) return `${path.slice(0, 2)}/`;
  if (path.startsWith("/")) return "/";
  return "";
}

/** `/a`, `C:/a`, `C:\a`, `//srv/share/a`. */
export function isAbsolutePath(path: string): boolean {
  return pathRoot(path.replace(/\\/g, "/")) !== "";
}

/** True for a Windows drive path such as `C:/x` or `C:\x`. */
export function isDrivePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * Rewrites a macOS-style shortcut label for the current platform:
 * `⌥⇧⌘←` → `Ctrl+Alt+Shift+←`, `Cmd+Opt+T` → `Ctrl+Alt+T`.
 */
export function shortcutLabel(label: string): string {
  return USES_CTRL ? toCtrlLabel(label) : label;
}

/** Pure conversion (exported for tests). */
export function toCtrlLabel(label: string): string {
  let out = label.replace(/\bCmd\+/g, "Ctrl+").replace(/\bOpt\+/g, "Alt+");
  // Symbol runs such as ⌥⇧⌘G / ⇧⌘⌫: Ctrl, Alt, Shift order.
  out = out.replace(/[⌘⌥⇧⌃]+(⌫|Enter|←|→|↑|↓|[A-Za-z0-9/])/g, (run: string, key: string) => {
    const mods = run.slice(0, run.length - key.length);
    const parts: string[] = [];
    if (mods.includes("⌘") || mods.includes("⌃")) parts.push("Ctrl");
    if (mods.includes("⌥")) parts.push("Alt");
    if (mods.includes("⇧")) parts.push("Shift");
    const k = key === "⌫" ? "Backspace" : key;
    return [...parts, k].join("+");
  });
  return out;
}
