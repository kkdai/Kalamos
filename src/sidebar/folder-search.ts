/**
 * #73 B: the sidebar's 「搜尋」 tab — search the Markdown files of the open
 * folder (Rust `search_in_folder`).
 *
 * - Typing is debounced (~250 ms); Enter searches at once. Nothing is searched
 *   while an IME composition is in progress.
 * - Every search gets a sequence number; a reply that is not the latest one is
 *   dropped, so an old, slow search can never overwrite a newer result.
 * - Results are grouped by file (collapsible), the hit is highlighted in each
 *   snippet, and clicking a hit asks the app to open the file at that spot.
 */
import {
  searchInFolder,
  type FolderSearchHit,
  type FolderSearchOptions,
  type FolderSearchResults,
} from "../ipc";

export const FOLDER_SEARCH_DEBOUNCE_MS = 250;

export interface FolderSearchOptionsInit {
  getFolder: () => string | null;
  onOpenHit: (hit: FolderSearchHit) => void | Promise<void>;
  /** Override the IPC call (tests). */
  search?: (root: string, query: string, opts: FolderSearchOptions) => Promise<FolderSearchResults>;
}

export interface FolderSearchView {
  /** The tab's DOM, kept across tab switches. */
  element: HTMLElement;
  /** Re-render for the current folder (called when the tab is shown). */
  refresh: () => void;
  focusInput: () => void;
  /** Run the search now (skips the debounce). */
  runNow: () => Promise<void>;
  destroy: () => void;
}

export interface FileGroup {
  path: string;
  hits: FolderSearchHit[];
}

/** Hits → groups by file, keeping the order the files first appear in. */
export function groupHitsByFile(hits: FolderSearchHit[]): FileGroup[] {
  const groups: FileGroup[] = [];
  const byPath = new Map<string, FileGroup>();
  for (const hit of hits) {
    let g = byPath.get(hit.path);
    if (!g) {
      g = { path: hit.path, hits: [] };
      byPath.set(hit.path, g);
      groups.push(g);
    }
    g.hits.push(hit);
  }
  return groups;
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** Folder of `path` relative to `root` ("" for the root itself). */
export function relativeDir(root: string, path: string): string {
  const base = root.replace(/\/+$/, "");
  const dirEnd = path.lastIndexOf("/");
  const dir = dirEnd <= 0 ? "/" : path.slice(0, dirEnd);
  if (dir === base) return "";
  return dir.startsWith(`${base}/`) ? dir.slice(base.length + 1) : dir;
}

/** The sidebar is narrow: keep only a little text before the hit so it stays visible. */
export const SNIPPET_LEAD_CHARS = 6;
export function shortenLead(before: string): string {
  const chars = Array.from(before);
  if (chars.length <= SNIPPET_LEAD_CHARS + 2) return before;
  return `…${chars.slice(-SNIPPET_LEAD_CHARS).join("").replace(/^\s+/, "")}`;
}

export function summaryText(results: FolderSearchResults): string {
  if (results.hits.length === 0) return "無結果";
  const files = new Set(results.hits.map((h) => h.path)).size;
  const base = `${results.hits.length}${results.truncated ? "+" : ""} 筆結果，${files} 個檔案`;
  return results.truncated ? `${base}（已截斷，請縮小搜尋範圍）` : base;
}

function optionButton(label: string, title: string, testid: string, extraClass = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `k-folder-search-opt ${extraClass}`.trim();
  b.textContent = label;
  b.title = title;
  b.dataset.testid = testid;
  b.setAttribute("aria-label", title);
  b.setAttribute("aria-pressed", "false");
  b.addEventListener("mousedown", (e) => e.preventDefault());
  return b;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function chevron(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("k-folder-search-chevron");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M6 4l4 4-4 4");
  svg.appendChild(path);
  return svg;
}

export function createFolderSearch(init: FolderSearchOptionsInit): FolderSearchView {
  const doSearch = init.search ?? searchInFolder;

  const element = document.createElement("div");
  element.className = "k-folder-search";
  element.dataset.testid = "folder-search";

  const field = document.createElement("div");
  field.className = "k-folder-search-field";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "k-folder-search-input";
  input.dataset.testid = "folder-search-input";
  input.placeholder = "在資料夾中搜尋";
  input.setAttribute("aria-label", "在資料夾中搜尋");
  input.spellcheck = false;
  input.autocomplete = "off";
  const caseBtn = optionButton("Aa", "區分大小寫", "folder-search-case");
  const wordBtn = optionButton("ab", "全字比對", "folder-search-word", "k-folder-search-opt-word");
  const regexBtn = optionButton(".*", "正規表示式", "folder-search-regex");
  const opts = document.createElement("div");
  opts.className = "k-folder-search-options";
  opts.append(caseBtn, wordBtn, regexBtn);
  field.append(input, opts);

  const status = document.createElement("div");
  status.className = "k-folder-search-status";
  status.dataset.testid = "folder-search-status";
  status.setAttribute("aria-live", "polite");

  const resultsEl = document.createElement("div");
  resultsEl.className = "k-folder-search-results";
  resultsEl.dataset.testid = "folder-search-results";

  element.append(field, status, resultsEl);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;
  let composing = false;
  let destroyed = false;
  const collapsed = new Set<string>();
  let lastResults: { root: string; results: FolderSearchResults } | null = null;

  const pressed = (b: HTMLButtonElement) => b.getAttribute("aria-pressed") === "true";

  function setStatus(text: string, state: string): void {
    status.textContent = text;
    status.dataset.state = state;
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function renderResults(root: string, results: FolderSearchResults): void {
    resultsEl.innerHTML = "";
    for (const group of groupHitsByFile(results.hits)) {
      const groupEl = document.createElement("div");
      groupEl.className = "k-folder-search-group";
      groupEl.dataset.testid = "folder-search-group";
      groupEl.dataset.path = group.path;
      const isCollapsed = collapsed.has(group.path);
      groupEl.dataset.collapsed = isCollapsed ? "true" : "false";

      const header = document.createElement("button");
      header.type = "button";
      header.className = "k-folder-search-file";
      header.dataset.testid = "folder-search-file";
      header.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
      header.title = group.path;
      const name = document.createElement("span");
      name.className = "k-folder-search-file-name";
      name.textContent = basename(group.path);
      const dir = document.createElement("span");
      dir.className = "k-folder-search-file-dir";
      dir.textContent = relativeDir(root, group.path);
      const count = document.createElement("span");
      count.className = "k-folder-search-file-count";
      count.textContent = String(group.hits.length);
      header.append(chevron(), name, dir, count);
      header.addEventListener("click", () => {
        const now = groupEl.dataset.collapsed !== "true";
        groupEl.dataset.collapsed = now ? "true" : "false";
        header.setAttribute("aria-expanded", now ? "false" : "true");
        if (now) collapsed.add(group.path);
        else collapsed.delete(group.path);
      });

      const list = document.createElement("div");
      list.className = "k-folder-search-hits";
      list.setAttribute("role", "list");
      for (const hit of group.hits) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "k-folder-search-hit";
        item.dataset.testid = "folder-search-hit";
        item.dataset.line = String(hit.line);
        item.dataset.column = String(hit.column);
        item.setAttribute("role", "listitem");
        item.title = `第 ${hit.line} 行`;
        const lineNo = document.createElement("span");
        lineNo.className = "k-folder-search-line";
        lineNo.textContent = String(hit.line);
        const text = document.createElement("span");
        text.className = "k-folder-search-snippet";
        const s = hit.snippet;
        const mark = document.createElement("mark");
        mark.textContent = s.slice(hit.snippetMatchStart, hit.snippetMatchEnd);
        text.append(
          document.createTextNode(shortenLead(s.slice(0, hit.snippetMatchStart))),
          mark,
          document.createTextNode(s.slice(hit.snippetMatchEnd)),
        );
        item.append(lineNo, text);
        item.addEventListener("click", () => {
          for (const el of resultsEl.querySelectorAll('.k-folder-search-hit[data-active="true"]')) {
            (el as HTMLElement).dataset.active = "false";
          }
          item.dataset.active = "true";
          void init.onOpenHit(hit);
        });
        list.appendChild(item);
      }
      groupEl.append(header, list);
      resultsEl.appendChild(groupEl);
    }
  }

  async function runNow(): Promise<void> {
    clearTimer();
    const mySeq = ++seq;
    const root = init.getFolder();
    const query = input.value;
    if (!root) {
      lastResults = null;
      resultsEl.innerHTML = "";
      setStatus("請先開啟資料夾（⇧⌘O）才能搜尋", "no-folder");
      return;
    }
    if (!query) {
      lastResults = null;
      resultsEl.innerHTML = "";
      setStatus("", "empty");
      return;
    }
    setStatus("搜尋中…", "searching");
    const options: FolderSearchOptions = {
      caseSensitive: pressed(caseBtn),
      wholeWord: pressed(wordBtn),
      regex: pressed(regexBtn),
    };
    try {
      const results = await doSearch(root, query, options);
      if (destroyed || mySeq !== seq) return; // a newer search owns the UI
      lastResults = { root, results };
      renderResults(root, results);
      setStatus(summaryText(results), results.hits.length ? (results.truncated ? "truncated" : "some") : "none");
    } catch (err) {
      if (destroyed || mySeq !== seq) return;
      lastResults = null;
      resultsEl.innerHTML = "";
      const kind = (err as { kind?: string } | null)?.kind;
      if (kind === "Parse" && options.regex) setStatus("正規表示式無效", "invalid");
      else {
        const message = (err as { message?: string } | null)?.message ?? String(err);
        setStatus(`搜尋失敗：${message}`, "error");
      }
    }
  }

  function schedule(): void {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void runNow();
    }, FOLDER_SEARCH_DEBOUNCE_MS);
  }

  input.addEventListener("compositionstart", () => {
    composing = true;
  });
  input.addEventListener("compositionend", () => {
    composing = false;
    schedule();
  });
  input.addEventListener("input", (e) => {
    if (composing || (e as InputEvent).isComposing) return;
    schedule();
  });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229 || composing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void runNow();
    } else if (e.key === "Escape" && input.value) {
      e.preventDefault();
      input.value = "";
      void runNow();
    }
  });
  for (const b of [caseBtn, wordBtn, regexBtn]) {
    b.addEventListener("click", () => {
      b.setAttribute("aria-pressed", pressed(b) ? "false" : "true");
      void runNow();
    });
  }

  function refresh(): void {
    const root = init.getFolder();
    if (!root) {
      seq++;
      clearTimer();
      lastResults = null;
      resultsEl.innerHTML = "";
      setStatus("請先開啟資料夾（⇧⌘O）才能搜尋", "no-folder");
      return;
    }
    if (lastResults && lastResults.root !== root) {
      // A different folder: the old hits no longer apply.
      void runNow();
    } else if (!input.value) {
      setStatus("", "empty");
    }
  }

  function focusInput(): void {
    input.focus();
    input.select();
  }

  function destroy(): void {
    destroyed = true;
    clearTimer();
    element.remove();
  }

  return { element, refresh, focusInput, runNow, destroy };
}
