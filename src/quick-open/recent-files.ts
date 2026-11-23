/**
 * #104: pure helpers for the recently-opened files list (max 20, newest first)
 * and the native 「檔案 > 打開最近使用」 submenu labels.
 */
import type { RecentMenuEntry } from "../ipc";
import { IS_WINDOWS } from "../platform";

export const MAX_RECENT_FILES = 20;

/** Returns a deduplicated list with `path` placed at the front, capped at `limit`. */
export function addRecentFile(
  list: readonly string[],
  path: string,
  limit = MAX_RECENT_FILES,
): string[] {
  const trimmed = path.trim();
  if (!trimmed) return sanitizeRecentFiles(list, limit);
  const out = [trimmed];
  for (const item of list) {
    if (out.length >= limit) break;
    const norm = item.trim();
    if (norm && norm !== trimmed && !out.includes(norm)) {
      out.push(norm);
    }
  }
  return out;
}

/** Removes `path` (and any descendants if `path` is a folder) from the list. */
export function removeRecentFile(
  list: readonly string[],
  path: string,
): string[] {
  const norm = path.replace(/\/+$/, "");
  if (!norm) return list.slice();
  const prefix = `${norm}/`;
  return list.filter((item) => item !== norm && !item.startsWith(prefix));
}

/** Updates entries affected by a file or folder rename, keeping order and deduplicating. */
export function renameRecentFiles(
  list: readonly string[],
  fromPath: string,
  toPath: string,
): string[] {
  const normFrom = fromPath.replace(/\/+$/, "");
  const normTo = toPath.replace(/\/+$/, "");
  if (!normFrom || !normTo || normFrom === normTo) return list.slice();
  const prefix = `${normFrom}/`;
  const out: string[] = [];
  for (const item of list) {
    let next = item;
    if (item === normFrom) next = normTo;
    else if (item.startsWith(prefix))
      next = `${normTo}${item.slice(normFrom.length)}`;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}

/** Filters empty / duplicate items and caps the list at `limit`. */
export function sanitizeRecentFiles(
  list: readonly string[] | null | undefined,
  limit = MAX_RECENT_FILES,
): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || out.includes(trimmed)) continue;
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}

function splitSegments(path: string): string[] {
  return path.split(/[\\/]/).filter((part) => part.length > 0);
}

/**
 * Builds labels for the native 「檔案 > 打開最近使用」 submenu.
 * Unique filenames show just the filename; colliding filenames add enough
 * parent segments to distinguish them (e.g. `README.md — docs`).
 */
export function recentMenuEntries(
  paths: readonly string[],
  options?: { separator?: string },
): RecentMenuEntry[] {
  const sep = options?.separator ?? (IS_WINDOWS ? "\\" : "/");
  const byName = new Map<string, string[]>();
  const names = new Map<string, string>();
  for (const p of paths) {
    const segs = splitSegments(p);
    const name = segs[segs.length - 1] ?? p;
    names.set(p, name);
    const group = byName.get(name);
    if (group) group.push(p);
    else byName.set(name, [p]);
  }

  const labels = new Map<string, string>();
  for (const [name, group] of byName) {
    if (group.length < 2) {
      labels.set(group[0], name);
      continue;
    }
    const parents = new Map(
      group.map((p) => [p, splitSegments(p).slice(0, -1)]),
    );
    const maxDepth = Math.max(...[...parents.values()].map((d) => d.length));
    const suffix = (dirs: string[], depth: number) =>
      dirs.slice(Math.max(0, dirs.length - depth)).join(sep);
    for (const p of group) {
      const dirs = parents.get(p)!;
      let depth = 1;
      while (
        depth < maxDepth &&
        group.some(
          (other) =>
            other !== p &&
            suffix(parents.get(other)!, depth) === suffix(dirs, depth),
        )
      ) {
        depth++;
      }
      const where = suffix(dirs, depth);
      labels.set(p, where ? `${name} — ${where}` : name);
    }
  }

  return paths.map((path) => ({
    path,
    label: labels.get(path) ?? names.get(path) ?? path,
  }));
}
