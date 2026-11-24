/**
 * #104: Cmd+P Quick Open overlay (fuzzy file search + recently opened files).
 *
 * - Opens centered near the top of the editor area, focusing the input.
 * - Empty input shows up to 20 recent files (newest first); typing fuzzy-searches
 *   the cached folder Markdown paths + recent files (top 50 results).
 * - IME-safe: ignores input and Enter while composing, searches on compositionend.
 * - Keyboard: ↑ / ↓ (and Ctrl+N / Ctrl+P on macOS), Enter (tab rules),
 *   Cmd/Ctrl+Enter (always new tab), Esc / Cmd+P (close and restore focus).
 */
import "./quick-open.css";

import { getUiLocale, t } from "../i18n";
import { MAX_QUICK_OPEN_PATHS } from "../ipc";
import { PLATFORM, shortcutLabel, toNativePath } from "../platform";
import type { OpenMode } from "../tabs/tab-model";
import {
  type PreparedCandidate,
  prepareCandidates,
  type QuickOpenMatch,
  searchQuickOpen,
} from "./fuzzy";

export interface QuickOpenOptions {
  /** Container to mount the overlay into (usually #app or document.body). */
  parent: HTMLElement;
  /** Called when the user confirms a file (Enter / Cmd+Enter / click). */
  onOpenFile: (path: string, mode: OpenMode) => void | Promise<unknown>;
  /** Called when the panel closes without opening a file so focus returns to the editor. */
  onRestoreFocus?: (previousFocus: HTMLElement | null) => void;
  /** Optional hook called right before opening (e.g. if folder cache hasn't initialized yet). */
  onBeforeOpen?: () => void | Promise<void>;
  /** Enable macOS-style Ctrl+N / Ctrl+P navigation (defaults to `PLATFORM === "mac"`). */
  emacsNav?: boolean;
  /** Document instance (for tests). */
  doc?: Document;
}

export interface QuickOpenController {
  open: () => void;
  close: (restoreFocus?: boolean) => void;
  toggle: () => void;
  isOpen: () => boolean;
  /** Updates the cached folder file paths (precomputes fuzzy candidates once). */
  setFolderPaths: (
    root: string | null,
    paths: readonly string[],
    truncated?: boolean,
  ) => void;
  /** Updates the recently-opened files list. */
  setRecentFiles: (recent: readonly string[]) => void;
  destroy: () => void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function strokeIcon(
  paths: string[],
  className: string,
  size = 16,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("k-icon", className);
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

const SEARCH_ICON = [
  "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z",
  "M21 21l-4.35-4.35",
];

const FILE_ICON = [
  "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z",
  "M14 3v6h6",
];

const CLOCK_ICON = ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M12 6v6l4 2"];

const CLOSE_ICON = ["M18 6L6 18", "M6 6l12 12"];

/** Appends `text` with consecutive `indices` wrapped in `<mark class="k-qo-match">`. */
export function renderHighlightedText(
  container: HTMLElement,
  text: string,
  indices: readonly number[],
  doc: Document = document,
): void {
  if (!text) return;
  if (indices.length === 0) {
    container.textContent = text;
    return;
  }
  let cursor = 0;
  let i = 0;
  while (i < indices.length) {
    const start = indices[i];
    if (start < cursor || start >= text.length) {
      i++;
      continue;
    }
    if (start > cursor) {
      container.appendChild(doc.createTextNode(text.slice(cursor, start)));
    }
    let end = start + 1;
    while (i + 1 < indices.length && indices[i + 1] === end) {
      i++;
      end++;
    }
    const mark = doc.createElement("mark");
    mark.className = "k-qo-match";
    mark.textContent = text.slice(start, end);
    container.appendChild(mark);
    cursor = end;
    i++;
  }
  if (cursor < text.length) {
    container.appendChild(doc.createTextNode(text.slice(cursor)));
  }
}

export function createQuickOpen(
  options: QuickOpenOptions,
): QuickOpenController {
  const doc = options.doc ?? options.parent.ownerDocument ?? document;

  let folderRoot: string | null = null;
  let candidates: PreparedCandidate[] = [];
  let folderTruncated = false;
  let recentFiles: string[] = [];

  let backdrop: HTMLDivElement | null = null;
  let inputEl: HTMLInputElement | null = null;
  let clearBtnEl: HTMLButtonElement | null = null;
  let sectionEl: HTMLDivElement | null = null;
  let listEl: HTMLDivElement | null = null;

  let currentMatches: QuickOpenMatch[] = [];
  let selectedIndex = 0;
  let composing = false;
  let previousFocus: HTMLElement | null = null;

  function renderList(): void {
    if (!listEl || !sectionEl || !inputEl) return;
    const query = inputEl.value.trim();
    const isRecentView = query.length === 0;

    if (clearBtnEl) {
      clearBtnEl.hidden = inputEl.value.length === 0;
    }

    currentMatches = searchQuickOpen(
      candidates,
      recentFiles,
      query,
      folderRoot,
    );
    if (currentMatches.length === 0) {
      selectedIndex = -1;
    } else if (selectedIndex < 0 || selectedIndex >= currentMatches.length) {
      selectedIndex = 0;
    }

    // Section / truncation header bar
    const parts: string[] = [];
    if (isRecentView && currentMatches.length > 0) {
      parts.push(t("quickOpen.recent.heading"));
    }
    if (folderTruncated && folderRoot) {
      parts.push(
        t("quickOpen.folderIndexTruncated", {
          limit: MAX_QUICK_OPEN_PATHS.toLocaleString(getUiLocale()),
        }),
      );
    }
    if (parts.length > 0) {
      sectionEl.textContent = parts.join(" · ");
      sectionEl.hidden = false;
    } else {
      sectionEl.textContent = "";
      sectionEl.hidden = true;
    }

    listEl.innerHTML = "";
    if (currentMatches.length === 0) {
      const empty = doc.createElement("div");
      empty.className = "k-qo-empty";
      empty.dataset.testid = "quick-open-empty";
      if (isRecentView) {
        empty.textContent = folderRoot
          ? t("quickOpen.recent.emptyWithFolder")
          : t("quickOpen.recent.emptyWithoutFolder", {
              openFile: shortcutLabel("⌘O"),
              openFolder: shortcutLabel("⇧⌘O"),
            });
      } else {
        empty.textContent = t("quickOpen.noMatches");
      }
      listEl.appendChild(empty);
      inputEl.removeAttribute("aria-activedescendant");
      return;
    }

    const frag = doc.createDocumentFragment();
    for (let i = 0; i < currentMatches.length; i++) {
      const match = currentMatches[i];
      const item = doc.createElement("button");
      item.type = "button";
      item.id = `k-qo-opt-${i}`;
      item.className = "k-qo-item";
      item.dataset.testid = "quick-open-item";
      item.dataset.path = match.path;
      item.dataset.index = String(i);
      item.setAttribute("role", "option");
      const active = i === selectedIndex;
      item.setAttribute("aria-selected", active ? "true" : "false");
      item.title = toNativePath(match.path);

      item.appendChild(
        strokeIcon(isRecentView ? CLOCK_ICON : FILE_ICON, "k-qo-item-icon", 15),
      );

      const nameEl = doc.createElement("span");
      nameEl.className = "k-qo-name";
      nameEl.dataset.testid = "quick-open-item-name";
      renderHighlightedText(nameEl, match.name, match.nameMatches, doc);
      item.appendChild(nameEl);

      if (match.dir) {
        const dirEl = doc.createElement("span");
        dirEl.className = "k-qo-dir";
        dirEl.dataset.testid = "quick-open-item-dir";
        renderHighlightedText(
          dirEl,
          toNativePath(match.dir),
          match.dirMatches,
          doc,
        );
        item.appendChild(dirEl);
      }

      if (!isRecentView && match.isRecent) {
        const badge = doc.createElement("span");
        badge.className = "k-qo-badge";
        badge.textContent = t("quickOpen.recent.badge");
        item.appendChild(badge);
      }

      item.addEventListener("mousedown", (e) => {
        // Keep focus on the input until click fires.
        e.preventDefault();
      });
      item.addEventListener("click", (e) => {
        const newTab = (e.metaKey || e.ctrlKey) && !(e.metaKey && e.ctrlKey);
        confirmIndex(i, newTab ? "newTab" : "tab");
      });

      frag.appendChild(item);
    }
    listEl.appendChild(frag);
    updateActiveDescendant();
  }

  function updateActiveDescendant(): void {
    if (!inputEl) return;
    if (selectedIndex >= 0 && selectedIndex < currentMatches.length) {
      inputEl.setAttribute(
        "aria-activedescendant",
        `k-qo-opt-${selectedIndex}`,
      );
    } else {
      inputEl.removeAttribute("aria-activedescendant");
    }
  }

  function moveSelection(delta: 1 | -1): void {
    if (!listEl || currentMatches.length === 0) return;
    const prev = selectedIndex;
    const count = currentMatches.length;
    selectedIndex = prev < 0 ? 0 : (((prev + delta) % count) + count) % count;

    const prevEl =
      prev >= 0
        ? listEl.querySelector<HTMLElement>(`.k-qo-item[data-index="${prev}"]`)
        : null;
    if (prevEl) prevEl.setAttribute("aria-selected", "false");

    const nextEl = listEl.querySelector<HTMLElement>(
      `.k-qo-item[data-index="${selectedIndex}"]`,
    );
    if (nextEl) {
      nextEl.setAttribute("aria-selected", "true");
      if (typeof nextEl.scrollIntoView === "function") {
        nextEl.scrollIntoView({ block: "nearest" });
      }
    }
    updateActiveDescendant();
  }

  function confirmIndex(index: number, mode: OpenMode): void {
    const match = currentMatches[index];
    if (!match) return;
    close(false);
    void Promise.resolve(options.onOpenFile(match.path, mode)).then((ok) => {
      if (ok === false) {
        options.onRestoreFocus?.(null);
      }
    });
  }

  function build(): HTMLDivElement {
    const root = doc.createElement("div");
    root.className = "k-qo-backdrop";
    root.dataset.testid = "quick-open-backdrop";

    const dialog = doc.createElement("div");
    dialog.className = "k-qo-dialog";
    dialog.dataset.testid = "quick-open";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", t("quickOpen.dialog"));

    const inputWrap = doc.createElement("div");
    inputWrap.className = "k-qo-input-wrap";

    const searchIcon = strokeIcon(SEARCH_ICON, "k-qo-search-icon", 16);

    const input = doc.createElement("input");
    input.type = "text";
    input.className = "k-qo-input";
    input.dataset.testid = "quick-open-input";
    input.placeholder = t("quickOpen.input.placeholder");
    input.setAttribute("aria-label", t("quickOpen.input.label"));
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-controls", "k-qo-listbox");
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("autocorrect", "off");

    const clearBtn = doc.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "k-qo-clear";
    clearBtn.dataset.testid = "quick-open-clear";
    clearBtn.setAttribute("aria-label", t("quickOpen.clear.label"));
    clearBtn.title = t("quickOpen.clear.tooltip");
    clearBtn.hidden = true;
    clearBtn.appendChild(strokeIcon(CLOSE_ICON, "k-qo-clear-icon", 14));
    clearBtn.addEventListener("mousedown", (e) => e.preventDefault());
    clearBtn.addEventListener("click", () => {
      input.value = "";
      selectedIndex = 0;
      renderList();
      input.focus();
    });

    inputWrap.append(searchIcon, input, clearBtn);

    const section = doc.createElement("div");
    section.className = "k-qo-section";
    section.dataset.testid = "quick-open-section";
    section.hidden = true;

    const list = doc.createElement("div");
    list.id = "k-qo-listbox";
    list.className = "k-qo-list";
    list.dataset.testid = "quick-open-list";
    list.setAttribute("role", "listbox");

    const footer = doc.createElement("div");
    footer.className = "k-qo-footer";
    footer.dataset.testid = "quick-open-footer";

    const hints = [
      t("quickOpen.hint.move", { shortcut: "↑↓" }),
      t("quickOpen.hint.open", { shortcut: "Enter" }),
      t("quickOpen.hint.openInNewTab", { shortcut: shortcutLabel("⌘Enter") }),
      t("quickOpen.hint.close", { shortcut: "Esc" }),
    ];
    for (const text of hints) {
      const span = doc.createElement("span");
      span.className = "k-qo-hint";
      span.textContent = text;
      footer.appendChild(span);
    }

    dialog.append(inputWrap, section, list, footer);
    root.appendChild(dialog);

    // IME composition handling: never search or open while composing.
    input.addEventListener("compositionstart", () => {
      composing = true;
    });
    input.addEventListener("compositionend", () => {
      composing = false;
      selectedIndex = 0;
      renderList();
    });
    input.addEventListener("input", (e) => {
      if (composing || (e as InputEvent).isComposing) return;
      selectedIndex = 0;
      renderList();
    });

    input.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229 || composing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveSelection(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveSelection(-1);
        return;
      }
      // Emacs navigation on macOS (on Windows/Linux Ctrl+P is Quick Open toggle).
      if (
        (options.emacsNav ?? PLATFORM === "mac") &&
        e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        const lower = e.key.toLowerCase();
        if (lower === "n" || e.code === "KeyN") {
          e.preventDefault();
          moveSelection(1);
          return;
        }
        if (lower === "p" || e.code === "KeyP") {
          e.preventDefault();
          moveSelection(-1);
          return;
        }
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (selectedIndex >= 0 && selectedIndex < currentMatches.length) {
          const newTab = (e.metaKey || e.ctrlKey) && !(e.metaKey && e.ctrlKey);
          confirmIndex(selectedIndex, newTab ? "newTab" : "tab");
        }
      }
    });

    root.addEventListener("mousedown", (e) => {
      if (e.target === root) {
        e.preventDefault();
        close(true);
      }
    });

    inputEl = input;
    clearBtnEl = clearBtn;
    sectionEl = section;
    listEl = list;
    return root;
  }

  const onDocumentKeydown = (e: KeyboardEvent) => {
    if (!backdrop) return;
    if (e.isComposing || e.keyCode === 229 || composing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  };

  function open(): void {
    if (backdrop) {
      inputEl?.focus();
      inputEl?.select();
      return;
    }
    previousFocus = doc.activeElement as HTMLElement | null;
    composing = false;
    selectedIndex = 0;
    backdrop = build();
    options.parent.appendChild(backdrop);
    doc.addEventListener("keydown", onDocumentKeydown, true);
    renderList();
    inputEl?.focus();
    void options.onBeforeOpen?.();
  }

  function close(restoreFocus = true): void {
    if (!backdrop) return;
    doc.removeEventListener("keydown", onDocumentKeydown, true);
    backdrop.remove();
    backdrop = null;
    inputEl = null;
    clearBtnEl = null;
    sectionEl = null;
    listEl = null;
    currentMatches = [];
    selectedIndex = 0;
    composing = false;

    const prev = previousFocus;
    previousFocus = null;
    if (restoreFocus) {
      if (options.onRestoreFocus) {
        options.onRestoreFocus(prev);
      } else if (prev?.isConnected) {
        prev.focus();
      }
    }
  }

  function toggle(): void {
    if (backdrop) close(true);
    else open();
  }

  function setFolderPaths(
    root: string | null,
    paths: readonly string[],
    truncated = false,
  ): void {
    folderRoot = root;
    folderTruncated = truncated;
    candidates = prepareCandidates(paths, root);
    if (backdrop) {
      selectedIndex = 0;
      renderList();
    }
  }

  function setRecentFiles(recent: readonly string[]): void {
    recentFiles = recent.slice();
    if (backdrop) {
      renderList();
    }
  }

  function destroy(): void {
    close(false);
  }

  return {
    open,
    close,
    toggle,
    isOpen: () => backdrop !== null,
    setFolderPaths,
    setRecentFiles,
    destroy,
  };
}
