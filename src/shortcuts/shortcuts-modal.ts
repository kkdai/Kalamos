/**
 * #147: Keyboard shortcuts cheatsheet overlay (說明 > 鍵盤快捷鍵).
 *
 * - Groups every shortcut from `menu-spec.json` and editor/table/search keymaps.
 * - Live search (IME-safe) filters by command name, category, or key combo.
 * - Esc, close button, backdrop click, or repeating the toggle shortcut closes
 *   and restores focus to the editor / previous element.
 */
import "./shortcuts-modal.css";

import { t } from "../i18n";
import { currentMenuPlatform, type MenuPlatform } from "../menu/menu-dispatch";
import {
  buildShortcutGroups,
  filterShortcutGroups,
  type ShortcutGroup,
} from "./shortcuts-data";

export interface ShortcutsModalOptions {
  /** Container to mount the overlay into (usually #app or document.body). */
  parent: HTMLElement;
  /** Called when the panel closes so focus returns cleanly to the editor. */
  onRestoreFocus?: (previousFocus: HTMLElement | null) => void;
  /** Override platform formatting (defaults to `currentMenuPlatform()`). */
  platform?: MenuPlatform;
  /** Document instance (for tests). */
  doc?: Document;
}

export interface ShortcutsModalController {
  open: () => void;
  close: (restoreFocus?: boolean) => void;
  toggle: () => void;
  isOpen: () => boolean;
  destroy: () => void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

const SEARCH_ICON = [
  "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z",
  "M21 21l-4.35-4.35",
];

const CLOSE_ICON = ["M18 6L6 18", "M6 6l12 12"];

function strokeIcon(
  doc: Document,
  paths: readonly string[],
  className: string,
  size = 15,
): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("k-icon", className);
  for (const d of paths) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

export function createShortcutsModal(
  options: ShortcutsModalOptions,
): ShortcutsModalController {
  const doc = options.doc ?? options.parent.ownerDocument ?? document;

  let backdrop: HTMLDivElement | null = null;
  let inputEl: HTMLInputElement | null = null;
  let clearBtnEl: HTMLButtonElement | null = null;
  let bodyEl: HTMLDivElement | null = null;
  let countEl: HTMLSpanElement | null = null;
  let allGroups: ShortcutGroup[] = [];
  let composing = false;
  let previousFocus: HTMLElement | null = null;

  function renderGroups(): void {
    if (!bodyEl || !inputEl) return;
    const query = inputEl.value;
    if (clearBtnEl) {
      clearBtnEl.hidden = query.length === 0;
    }

    const filtered = filterShortcutGroups(allGroups, query);
    const total = filtered.reduce((sum, g) => sum + g.items.length, 0);
    if (countEl) {
      countEl.textContent = t(
        total === 1 ? "shortcuts.countOne" : "shortcuts.count",
        { count: total },
      );
    }

    bodyEl.innerHTML = "";
    if (filtered.length === 0) {
      bodyEl.classList.remove("is-single-col");
      const empty = doc.createElement("div");
      empty.className = "k-sc-empty";
      empty.dataset.testid = "shortcuts-empty";
      empty.textContent = t("shortcuts.empty");
      bodyEl.appendChild(empty);
      return;
    }

    bodyEl.classList.toggle("is-single-col", filtered.length === 1);
    const columns = doc.createElement("div");
    columns.className = "k-sc-columns";
    columns.dataset.testid = "shortcuts-groups";

    for (const group of filtered) {
      const section = doc.createElement("section");
      section.className = "k-sc-group";
      section.dataset.testid = `shortcuts-group-${group.id}`;
      section.dataset.category = group.id;

      const heading = doc.createElement("h2");
      heading.className = "k-sc-group-title";
      heading.textContent = group.title;
      section.appendChild(heading);

      const list = doc.createElement("ul");
      list.className = "k-sc-list";
      for (const item of group.items) {
        const li = doc.createElement("li");
        li.className = "k-sc-row";
        li.dataset.testid = "shortcut-row";
        li.dataset.shortcutId = item.id;

        const label = doc.createElement("span");
        label.className = "k-sc-label";
        label.textContent = item.label;

        const kbd = doc.createElement("kbd");
        kbd.className = "k-sc-kbd";
        kbd.dataset.testid = "shortcut-key";
        kbd.textContent = item.displayKey;

        li.append(label, kbd);
        list.appendChild(li);
      }
      section.appendChild(list);
      columns.appendChild(section);
    }
    bodyEl.appendChild(columns);
  }

  function build(): HTMLDivElement {
    const root = doc.createElement("div");
    root.className = "k-sc-backdrop";
    root.dataset.testid = "shortcuts-backdrop";

    const dialog = doc.createElement("div");
    dialog.className = "k-sc-dialog";
    dialog.dataset.testid = "shortcuts-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "k-sc-title");

    const header = doc.createElement("div");
    header.className = "k-sc-header";

    const title = doc.createElement("h1");
    title.id = "k-sc-title";
    title.className = "k-sc-title";
    title.textContent = t("shortcuts.title");

    const closeBtn = doc.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "k-sc-close";
    closeBtn.dataset.testid = "shortcuts-close";
    closeBtn.setAttribute("aria-label", t("shortcuts.close"));
    closeBtn.title = t("shortcuts.close");
    closeBtn.appendChild(strokeIcon(doc, CLOSE_ICON, "k-sc-close-icon", 15));
    closeBtn.addEventListener("click", () => close(true));

    header.append(title, closeBtn);

    const searchWrap = doc.createElement("div");
    searchWrap.className = "k-sc-search-wrap";

    const searchIcon = strokeIcon(doc, SEARCH_ICON, "k-sc-search-icon", 15);

    const input = doc.createElement("input");
    input.type = "text";
    input.className = "k-sc-input";
    input.dataset.testid = "shortcuts-search";
    input.placeholder = t("shortcuts.search.placeholder");
    input.setAttribute("aria-label", t("shortcuts.search.label"));
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("autocorrect", "off");

    const clearBtn = doc.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "k-sc-clear";
    clearBtn.dataset.testid = "shortcuts-clear";
    clearBtn.setAttribute("aria-label", t("shortcuts.clear"));
    clearBtn.title = t("shortcuts.clear");
    clearBtn.hidden = true;
    clearBtn.appendChild(strokeIcon(doc, CLOSE_ICON, "k-sc-clear-icon", 13));
    clearBtn.addEventListener("mousedown", (e) => e.preventDefault());
    clearBtn.addEventListener("click", () => {
      input.value = "";
      renderGroups();
      input.focus();
    });

    searchWrap.append(searchIcon, input, clearBtn);

    const body = doc.createElement("div");
    body.className = "k-sc-body";
    body.dataset.testid = "shortcuts-body";

    const footer = doc.createElement("div");
    footer.className = "k-sc-footer";

    const hint = doc.createElement("span");
    hint.className = "k-sc-hint";
    hint.textContent = t("shortcuts.hint.close", { shortcut: "Esc" });

    const count = doc.createElement("span");
    count.className = "k-sc-count";
    count.dataset.testid = "shortcuts-count";

    footer.append(hint, count);
    dialog.append(header, searchWrap, body, footer);
    root.appendChild(dialog);

    input.addEventListener("compositionstart", () => {
      composing = true;
    });
    input.addEventListener("compositionend", () => {
      composing = false;
      renderGroups();
    });
    input.addEventListener("input", (e) => {
      if (composing || (e as InputEvent).isComposing) return;
      renderGroups();
    });

    root.addEventListener("mousedown", (e) => {
      if (e.target === root) {
        e.preventDefault();
        close(true);
      }
    });

    inputEl = input;
    clearBtnEl = clearBtn;
    bodyEl = body;
    countEl = count;
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
    allGroups = buildShortcutGroups(options.platform ?? currentMenuPlatform());
    backdrop = build();
    options.parent.appendChild(backdrop);
    doc.addEventListener("keydown", onDocumentKeydown, true);
    renderGroups();
    inputEl?.focus();
  }

  function close(restoreFocus = true): void {
    if (!backdrop) return;
    doc.removeEventListener("keydown", onDocumentKeydown, true);
    backdrop.remove();
    backdrop = null;
    inputEl = null;
    clearBtnEl = null;
    bodyEl = null;
    countEl = null;
    allGroups = [];
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

  function destroy(): void {
    close(false);
  }

  return {
    open,
    close,
    toggle,
    isOpen: () => backdrop !== null,
    destroy,
  };
}
