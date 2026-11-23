import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emitMockMenuAction,
  getMockListMarkdownPathsCallCount,
  getMockMenuState,
  getSettings,
  resetMockListMarkdownPathsCallCount,
  resetMockState,
  seedMockDir,
  seedMockFile,
  seedMockSettings,
  trashPath,
  triggerMockFsChanged,
} from "../ipc";
import { createKalamosApp, type KalamosApp } from "../main";
import { createQuickOpen } from "./quick-open";

function setupDom(): void {
  document.body.innerHTML = `
    <div id="app">
      <aside id="sidebar" data-visible="false"></aside>
      <main id="editor-container"></main>
      <div id="status" data-testid="status" role="status"></div>
    </div>
  `;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 5));
}

function pressKey(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(ev);
  return ev;
}

describe("#104 Quick Open panel, IME, recent files, cache & menu", () => {
  let app: KalamosApp | null = null;
  const root = "/tmp/kalamos-test/qo-vault";

  beforeEach(async () => {
    resetMockState();
    setupDom();
    seedMockDir(root);
    seedMockFile(`${root}/README.md`, "# Readme");
    seedMockFile(`${root}/notes.md`, "# Notes");
    seedMockFile(`${root}/guides/shortcuts.md`, "# Shortcuts");
    seedMockFile(`${root}/guides/quick-open.md`, "# Quick Open");
    seedMockFile("/tmp/kalamos-test/outside/external.md", "# External");

    app = createKalamosApp(document);
    await app.init();
    await settle();
  });

  afterEach(() => {
    app?.destroy();
    app = null;
  });

  it("Cmd+P opens and closes Quick Open without double-triggering from menu", async () => {
    await app!.openFolder(root);
    await settle();

    // Cmd+P opens; matching menu event immediately after is deduplicated.
    pressKey(window, { key: "p", code: "KeyP", metaKey: true });
    await emitMockMenuAction("file.quickOpen");
    expect(app!.quickOpen.isOpen()).toBe(true);
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="quick-open-input"]',
    );
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);

    // Pressing Cmd+P again closes it.
    pressKey(input!, { key: "p", code: "KeyP", metaKey: true });
    await emitMockMenuAction("file.quickOpen");
    expect(app!.quickOpen.isOpen()).toBe(false);

    // Menu click alone opens it, Esc closes it.
    await emitMockMenuAction("file.quickOpen");
    expect(app!.quickOpen.isOpen()).toBe(true);
    pressKey(document.querySelector('[data-testid="quick-open-input"]')!, {
      key: "Escape",
      code: "Escape",
    });
    expect(app!.quickOpen.isOpen()).toBe(false);
  });

  it("caches folder paths across opens and refreshes on fs-changed watch events", async () => {
    resetMockListMarkdownPathsCallCount();
    await app!.openFolder(root);
    await settle();
    expect(getMockListMarkdownPathsCallCount()).toBe(1);

    // Repeated open/close must NOT re-scan the folder.
    app!.quickOpen.open();
    app!.quickOpen.close();
    app!.quickOpen.open();
    app!.quickOpen.close();
    expect(getMockListMarkdownPathsCallCount()).toBe(1);

    // Watch event triggers a re-scan and picks up new files.
    seedMockFile(`${root}/fresh-note.md`, "# Fresh");
    await triggerMockFsChanged({ root, paths: [`${root}/fresh-note.md`] });
    await settle();
    expect(getMockListMarkdownPathsCallCount()).toBe(2);

    app!.quickOpen.open();
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="quick-open-input"]',
    )!;
    input.value = "fresh";
    input.dispatchEvent(new Event("input"));
    const items = document.querySelectorAll('[data-testid="quick-open-item"]');
    expect(items).toHaveLength(1);
    expect((items[0] as HTMLElement).dataset.path).toBe(
      `${root}/fresh-note.md`,
    );
  });

  it("fuzzy searches with highlighted marks, keyboard navigation, and tab rules", async () => {
    await app!.openFolder(root);
    await settle();

    app!.quickOpen.open();
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="quick-open-input"]',
    )!;
    input.value = "qo";
    input.dispatchEvent(new Event("input"));

    const items = document.querySelectorAll<HTMLElement>(
      '[data-testid="quick-open-item"]',
    );
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0].dataset.path).toBe(`${root}/guides/quick-open.md`);
    const marks = Array.from(items[0].querySelectorAll("mark.k-qo-match")).map(
      (m) => m.textContent,
    );
    expect(marks).toEqual(["q", "o"]);

    // Enter reuses the initial pristine blank tab.
    pressKey(input, { key: "Enter", code: "Enter" });
    await settle();
    expect(app!.quickOpen.isOpen()).toBe(false);
    expect(app!.getCurrentPath()).toBe(`${root}/guides/quick-open.md`);
    expect(app!.getTabs()).toHaveLength(1);

    // Opening another file with Enter opens a new tab (since active tab is not pristine).
    app!.quickOpen.open();
    const input2 = document.querySelector<HTMLInputElement>(
      '[data-testid="quick-open-input"]',
    )!;
    input2.value = "notes";
    input2.dispatchEvent(new Event("input"));
    pressKey(input2, { key: "Enter", code: "Enter" });
    await settle();
    expect(app!.getTabs()).toHaveLength(2);
    expect(app!.getCurrentPath()).toBe(`${root}/notes.md`);

    // Opening an already-open file switches to its existing tab instead of duplicating.
    app!.quickOpen.open();
    const input3 = document.querySelector<HTMLInputElement>(
      '[data-testid="quick-open-input"]',
    )!;
    input3.value = "quick-open";
    input3.dispatchEvent(new Event("input"));
    pressKey(input3, { key: "Enter", code: "Enter" });
    await settle();
    expect(app!.getTabs()).toHaveLength(2);
    expect(app!.getCurrentPath()).toBe(`${root}/guides/quick-open.md`);

    // Cmd+Enter always opens a new tab even when active tab is blank untitled.
    app!.newTab();
    expect(app!.getTabs()).toHaveLength(3);
    app!.quickOpen.open();
    const input4 = document.querySelector<HTMLInputElement>(
      '[data-testid="quick-open-input"]',
    )!;
    input4.value = "readme";
    input4.dispatchEvent(new Event("input"));
    pressKey(input4, { key: "Enter", code: "Enter", metaKey: true });
    await settle();
    expect(app!.getTabs()).toHaveLength(4);
    expect(app!.getCurrentPath()).toBe(`${root}/README.md`);
  });

  it("records recent files on open and save-as, persists them, handles missing files, and syncs menu", async () => {
    // Open an external file without any folder open.
    await app!.openPath("/tmp/kalamos-test/outside/external.md", "tab");
    await app!.openPath(`${root}/notes.md`, "tab");
    await settle();

    expect(app!.getRecentFiles()).toEqual([
      `${root}/notes.md`,
      "/tmp/kalamos-test/outside/external.md",
    ]);
    expect((await getSettings()).recentFiles).toEqual([
      `${root}/notes.md`,
      "/tmp/kalamos-test/outside/external.md",
    ]);
    expect(getMockMenuState()?.recentFiles?.map((r) => r.path)).toEqual([
      `${root}/notes.md`,
      "/tmp/kalamos-test/outside/external.md",
    ]);

    // Save As to a new path updates recent files.
    app!.newTab();
    app!.editor.setContent("# Saved As");
    await app!.saveDocumentAs("/tmp/kalamos-test/outside/saved.md");
    await settle();
    expect(app!.getRecentFiles()[0]).toBe("/tmp/kalamos-test/outside/saved.md");

    // Empty Quick Open lists recent files newest-first even with no folder open.
    app!.quickOpen.open();
    const items = document.querySelectorAll<HTMLElement>(
      '[data-testid="quick-open-item"]',
    );
    expect(Array.from(items).map((el) => el.dataset.path)).toEqual([
      "/tmp/kalamos-test/outside/saved.md",
      `${root}/notes.md`,
      "/tmp/kalamos-test/outside/external.md",
    ]);
    app!.quickOpen.close();

    // Close the external file's tab, delete it from disk, then try opening via menu -> clear error & removed.
    const extTab = app!
      .getTabs()
      .find((t) => t.path === "/tmp/kalamos-test/outside/external.md");
    expect(extTab).toBeDefined();
    await app!.closeTab(extTab!.id);
    await trashPath("/tmp/kalamos-test/outside/external.md");
    await emitMockMenuAction(
      "file.openRecent",
      "/tmp/kalamos-test/outside/external.md",
    );
    await settle();
    expect(app!.getStatusText()).toContain("找不到檔案");
    expect(app!.getRecentFiles()).not.toContain(
      "/tmp/kalamos-test/outside/external.md",
    );
    expect((await getSettings()).recentFiles).not.toContain(
      "/tmp/kalamos-test/outside/external.md",
    );

    // Clear recent files via native menu action.
    await emitMockMenuAction("file.clearRecent");
    await settle();
    expect(app!.getRecentFiles()).toEqual([]);
    expect((await getSettings()).recentFiles).toEqual([]);
    expect(getMockMenuState()?.recentFiles).toEqual([]);
  });

  it("loads recentFiles from persisted settings on startup", async () => {
    app!.destroy();
    resetMockState();
    seedMockFile(`${root}/notes.md`, "# Notes");
    seedMockSettings({
      theme: "papyros",
      recentFiles: [`${root}/notes.md`],
    });
    setupDom();
    app = createKalamosApp(document);
    await app.init();
    await settle();

    expect(app.getRecentFiles()).toEqual([`${root}/notes.md`]);
    expect(getMockMenuState()?.recentFiles).toEqual([
      { path: `${root}/notes.md`, label: "notes.md" },
    ]);
  });

  it("respects IME composition: no search during composition, Enter during composition does not open", () => {
    const opened: string[] = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    const qo = createQuickOpen({
      parent: host,
      emacsNav: true,
      onOpenFile: (path) => {
        opened.push(path);
      },
    });
    qo.setFolderPaths(root, [`${root}/設計筆記.md`, `${root}/notes.md`], false);
    qo.setRecentFiles([`${root}/notes.md`]);
    qo.open();

    const input = host.querySelector<HTMLInputElement>(
      '[data-testid="quick-open-input"]',
    )!;
    // Start IME composition (e.g. Zhuyin)
    input.dispatchEvent(new Event("compositionstart"));
    input.value = "ㄕㄜˋ";
    input.dispatchEvent(new Event("input"));
    // Still showing recent list (not searched yet)
    expect(
      host.querySelector<HTMLElement>('[data-testid="quick-open-item"]')
        ?.dataset.path,
    ).toBe(`${root}/notes.md`);

    // Enter while composing must NOT open a file!
    pressKey(input, { key: "Enter", code: "Enter" });
    expect(opened).toEqual([]);
    expect(qo.isOpen()).toBe(true);

    // Composition ends -> now searches for "設計"
    input.value = "設計";
    input.dispatchEvent(new Event("compositionend"));
    const matched = host.querySelectorAll<HTMLElement>(
      '[data-testid="quick-open-item"]',
    );
    expect(matched).toHaveLength(1);
    expect(matched[0].dataset.path).toBe(`${root}/設計筆記.md`);

    // Enter after compositionend opens the file
    pressKey(input, { key: "Enter", code: "Enter" });
    expect(opened).toEqual([`${root}/設計筆記.md`]);
    expect(qo.isOpen()).toBe(false);

    // Emacs Ctrl+N / Ctrl+P navigation when emacsNav is enabled
    qo.open();
    const input2 = host.querySelector<HTMLInputElement>(
      '[data-testid="quick-open-input"]',
    )!;
    input2.value = "md";
    input2.dispatchEvent(new Event("input"));
    const items = host.querySelectorAll<HTMLElement>(
      '[data-testid="quick-open-item"]',
    );
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute("aria-selected")).toBe("true");
    pressKey(input2, { key: "n", code: "KeyN", ctrlKey: true });
    expect(items[1].getAttribute("aria-selected")).toBe("true");
    pressKey(input2, { key: "p", code: "KeyP", ctrlKey: true });
    expect(items[0].getAttribute("aria-selected")).toBe("true");

    qo.destroy();
    host.remove();
  });
});
