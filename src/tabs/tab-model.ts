/**
 * #81 A: pure helpers for the document tabs (naming, collision labels,
 * keyboard cycling, which tab becomes active after a close, reordering).
 */

export const UNTITLED_LABEL = "未命名";

/** 1 → 「未命名」, n → 「未命名 n」. */
export function untitledLabel(n: number): string {
  return n <= 1 ? UNTITLED_LABEL : `${UNTITLED_LABEL} ${n}`;
}

/** The lowest positive number no open untitled tab uses. */
export function nextUntitledNumber(used: Iterable<number>): number {
  const taken = new Set(used);
  let n = 1;
  while (taken.has(n)) n++;
  return n;
}

export interface TabNameInput {
  id: string;
  /** null = untitled. */
  path: string | null;
  /** Used while the tab is untitled. */
  untitledNumber: number;
}

function splitPath(path: string): string[] {
  return path.split(/[\\/]/).filter((part) => part.length > 0);
}

export function baseNameOf(path: string): string {
  const parts = splitPath(path);
  return parts[parts.length - 1] ?? path;
}

/**
 * Tab labels keyed by tab id. Saved tabs show their file name; when two open
 * files share a name, each also shows as many parent folders as it takes to
 * tell them apart, e.g. 「README.md — docs」.
 */
export function tabLabels(tabs: TabNameInput[]): Map<string, string> {
  const labels = new Map<string, string>();
  const byName = new Map<string, TabNameInput[]>();
  for (const tab of tabs) {
    if (tab.path === null) {
      labels.set(tab.id, untitledLabel(tab.untitledNumber));
      continue;
    }
    const name = baseNameOf(tab.path);
    const group = byName.get(name);
    if (group) group.push(tab);
    else byName.set(name, [tab]);
  }
  for (const [name, group] of byName) {
    const distinctPaths = new Set(group.map((t) => t.path));
    if (distinctPaths.size < 2) {
      for (const tab of group) labels.set(tab.id, name);
      continue;
    }
    const parents = new Map(group.map((t) => [t.id, splitPath(t.path!).slice(0, -1)]));
    const maxDepth = Math.max(...[...parents.values()].map((p) => p.length));
    const suffix = (dirs: string[], depth: number) => dirs.slice(Math.max(0, dirs.length - depth)).join("/");
    for (const tab of group) {
      const dirs = parents.get(tab.id)!;
      let depth = 1;
      // Grow until no other path in the group shares this suffix.
      while (
        depth < maxDepth &&
        group.some(
          (other) =>
            other.path !== tab.path && suffix(parents.get(other.id)!, depth) === suffix(dirs, depth),
        )
      ) {
        depth++;
      }
      const where = suffix(dirs, depth);
      labels.set(tab.id, where ? `${name} — ${where}` : name);
    }
  }
  return labels;
}

/** Next / previous index with wrap-around (Ctrl+Tab / Ctrl+Shift+Tab). */
export function cycleIndex(index: number, count: number, delta: 1 | -1): number {
  if (count <= 0) return -1;
  return (((index + delta) % count) + count) % count;
}

/**
 * Index (in the list without the closed tab) of the tab that should be active
 * after closing `closedIndex`. Closing the active tab moves to its right-hand
 * neighbour (or the left one when it was last); closing another tab keeps the
 * active one.
 */
export function activeIndexAfterClose(closedIndex: number, activeIndex: number, count: number): number {
  const remaining = count - 1;
  if (remaining <= 0) return -1;
  if (closedIndex === activeIndex) return Math.min(closedIndex, remaining - 1);
  return closedIndex < activeIndex ? activeIndex - 1 : activeIndex;
}

/** A copy of `items` with the item at `from` moved to `to` (indices in the original list). */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const out = items.slice();
  if (from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1);
  const target = Math.max(0, Math.min(to, out.length));
  out.splice(target, 0, item);
  return out;
}
