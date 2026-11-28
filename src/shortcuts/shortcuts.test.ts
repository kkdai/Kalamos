import { afterEach, describe, expect, it, vi } from "vitest";
import { EDITOR_EXTRA_SHORTCUT_LIST } from "../editor/keymaps";
import { SEARCH_EXTRA_SHORTCUTS } from "../editor/search";
import { TABLE_SHORTCUTS } from "../editor/table-toolbar";
import { DEFAULT_UI_LOCALE, initUiLocale } from "../i18n";
import {
  formatAccelerator,
  menuActions,
  menuSpecFor,
} from "../menu/menu-dispatch";
import {
  APP_EXTRA_SHORTCUTS,
  buildShortcutGroups,
  cmKeyToAccelerator,
  filterShortcutGroups,
  SHORTCUT_CATEGORY_ORDER,
} from "./shortcuts-data";
import { createShortcutsModal } from "./shortcuts-modal";

afterEach(() => {
  initUiLocale(DEFAULT_UI_LOCALE);
  document.body.innerHTML = "";
});

describe("#147 keyboard shortcuts single-source cheatsheet", () => {
  it("includes every menu accelerator from menu-spec.json on both macOS and Windows", () => {
    for (const platform of ["macos", "windows"] as const) {
      const groups = buildShortcutGroups(platform);
      const entries = groups.flatMap((g) => g.items);
      const byId = new Map(entries.map((e) => [e.id, e]));

      const specActions = menuActions(menuSpecFor(platform)).filter((a) =>
        Boolean(a.accel),
      );
      expect(specActions.length).toBeGreaterThan(30);

      for (const action of specActions) {
        const entry = byId.get(action.id);
        expect(entry, `${platform}: missing ${action.id}`).toBeDefined();
        expect(entry!.accel).toBe(action.accel);
        expect(entry!.displayKey).toBe(
          formatAccelerator(action.accel!, platform),
        );
      }
    }
  });

  it("includes non-menu keymap shortcuts (editor, search, table, app) from the same sources", () => {
    for (const platform of ["macos", "windows"] as const) {
      const entries = buildShortcutGroups(platform).flatMap((g) => g.items);
      const byId = new Map(entries.map((e) => [e.id, e]));

      for (const def of [
        ...EDITOR_EXTRA_SHORTCUT_LIST,
        ...SEARCH_EXTRA_SHORTCUTS,
      ]) {
        const expectedAccel = cmKeyToAccelerator(def.key);
        const entry = byId.get(def.id);
        expect(entry, `${platform}: missing ${def.id}`).toBeDefined();
        expect(entry!.displayKey).toBe(
          formatAccelerator(expectedAccel, platform),
        );
      }

      for (const def of APP_EXTRA_SHORTCUTS) {
        const entry = byId.get(def.id);
        expect(entry, `${platform}: missing ${def.id}`).toBeDefined();
        expect(entry!.displayKey).toBe(formatAccelerator(def.accel, platform));
      }

      for (const spec of TABLE_SHORTCUTS) {
        const expectedAccel = cmKeyToAccelerator(spec.key);
        const entry = byId.get(`table.${spec.action}`);
        expect(
          entry,
          `${platform}: missing table.${spec.action}`,
        ).toBeDefined();
        expect(entry!.displayKey).toBe(
          formatAccelerator(expectedAccel, platform),
        );
      }
    }
  });

  it("formats macOS glyphs and Windows Ctrl/Alt/Shift labels cleanly across all 7 categories", () => {
    const macGroups = buildShortcutGroups("macos");
    const winGroups = buildShortcutGroups("windows");

    expect(macGroups.map((g) => g.id)).toEqual([...SHORTCUT_CATEGORY_ORDER]);
    expect(winGroups.map((g) => g.id)).toEqual([...SHORTCUT_CATEGORY_ORDER]);

    const macById = new Map(
      macGroups.flatMap((g) => g.items).map((e) => [e.id, e]),
    );
    const winById = new Map(
      winGroups.flatMap((g) => g.items).map((e) => [e.id, e]),
    );

    expect(macById.get("help.shortcuts")?.displayKey).toBe("⌥⌘/");
    expect(macById.get("help.shortcuts")?.category).toBe("view");
    expect(macById.get("file.exportPdf")?.category).toBe("file");
    expect(macById.get("file.exportPandoc")?.category).toBe("file");
    expect(macById.get("file.newTab")?.category).toBe("tabs");
    expect(macById.get("edit.find")?.category).toBe("search");
    expect(winById.get("help.shortcuts")?.displayKey).toBe("Ctrl+Alt+/");
    expect(macById.get("view.sourceMode")?.displayKey).toBe("⌘/");
    expect(winById.get("view.sourceMode")?.displayKey).toBe("Ctrl+/");
    expect(macById.get("window.nextTab")?.displayKey).toBe("⌃⇥");
    expect(winById.get("window.nextTab")?.displayKey).toBe("Ctrl+Tab");
    expect(macById.get("table.deleteRow")?.displayKey).toBe("⇧⌘⌫");
    expect(winById.get("table.deleteRow")?.displayKey).toBe(
      "Ctrl+Shift+Backspace",
    );

    for (const entry of winById.values()) {
      expect(entry.displayKey, entry.id).not.toMatch(/[⌘⌥⇧⌃⇥⌫↩]/);
    }
  });

  it("supports i18n in zh-TW and en and filters by label, category, or key", () => {
    initUiLocale("zh-TW");
    const zhGroups = buildShortcutGroups("macos");
    expect(zhGroups.map((g) => g.title)).toEqual([
      "檔案",
      "編輯",
      "段落",
      "格式",
      "檢視",
      "分頁",
      "搜尋",
    ]);

    const byLabel = filterShortcutGroups(zhGroups, "快速開啟");
    expect(byLabel.flatMap((g) => g.items).map((i) => i.id)).toContain(
      "file.quickOpen",
    );

    const byCategory = filterShortcutGroups(zhGroups, "分頁");
    expect(byCategory.map((g) => g.id)).toContain("tabs");

    const byKey = filterShortcutGroups(zhGroups, "F8");
    expect(byKey.flatMap((g) => g.items).map((i) => i.id)).toEqual([
      "view.focusMode",
    ]);

    initUiLocale("en");
    const enGroups = buildShortcutGroups("windows");
    expect(enGroups.map((g) => g.title)).toEqual([
      "File",
      "Edit",
      "Paragraph",
      "Format",
      "View",
      "Tabs",
      "Search",
    ]);
    expect(
      filterShortcutGroups(enGroups, "ctrl+alt+/")
        .flatMap((g) => g.items)
        .map((i) => i.id),
    ).toEqual(["help.shortcuts"]);
    expect(filterShortcutGroups(enGroups, "definitely-no-match")).toEqual([]);
  });

  it("modal opens, filters (IME-safe), clears, closes on Esc/backdrop, and restores focus", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    const onRestoreFocus = vi.fn();
    const modal = createShortcutsModal({
      parent: document.body,
      platform: "macos",
      onRestoreFocus,
    });

    modal.open();
    expect(modal.isOpen()).toBe(true);
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="shortcuts-search"]',
    )!;
    expect(document.activeElement).toBe(input);
    expect(
      document.querySelectorAll('[data-testid="shortcut-row"]').length,
    ).toBeGreaterThan(40);

    // IME composition should not filter until compositionend.
    input.dispatchEvent(new Event("compositionstart"));
    input.value = "不存在";
    input.dispatchEvent(new Event("input"));
    expect(
      document.querySelector('[data-testid="shortcuts-empty"]'),
    ).toBeNull();
    input.dispatchEvent(new Event("compositionend"));
    expect(
      document.querySelector('[data-testid="shortcuts-empty"]')?.textContent,
    ).toBe("找不到符合的快捷鍵");

    // Clear resets filter.
    const clearBtn = document.querySelector<HTMLButtonElement>(
      '[data-testid="shortcuts-clear"]',
    )!;
    expect(clearBtn.hidden).toBe(false);
    clearBtn.click();
    expect(input.value).toBe("");
    expect(clearBtn.hidden).toBe(true);
    expect(
      document.querySelectorAll('[data-testid="shortcut-row"]').length,
    ).toBeGreaterThan(40);

    // Escape closes and calls onRestoreFocus with the previously focused element.
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
    );
    expect(modal.isOpen()).toBe(false);
    expect(onRestoreFocus).toHaveBeenCalledWith(trigger);

    // Backdrop click also closes.
    modal.open();
    const backdrop = document.querySelector<HTMLElement>(
      '[data-testid="shortcuts-backdrop"]',
    )!;
    backdrop.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    expect(modal.isOpen()).toBe(false);

    modal.destroy();
  });
});
