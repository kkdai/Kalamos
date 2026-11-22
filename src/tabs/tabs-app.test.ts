import { undo } from "@codemirror/commands";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitMockMenuAction,
  getMockQuitCount,
  getMockSaveChangesPrompts,
  getMockWindowTitle,
  listRecovery,
  readMockFile,
  resetMockState,
  seedMockFile,
  seedMockSettings,
  setMockDialogHandlers,
  triggerMockCloseRequested,
  triggerMockFileDrop,
} from "../ipc";
import {
  createKalamosApp,
  NAMED_AUTOSAVE_DELAY_MS,
  UNTITLED_RECOVERY_INTERVAL_MS,
  type KalamosApp,
} from "../main";
import { codeLineNumbersFacet } from "../editor/code-blocks";
import { imageDocPathField, imageRootSettingField } from "../editor/images";
import { MENU_THEN_KEY_WINDOW_MS } from "../menu/menu-dispatch";

function setupDom(): void {
  document.body.innerHTML = `
    <div id="app">
      <aside id="sidebar" data-visible="false"></aside>
      <main id="editor-container"></main>
      <div id="status" data-testid="status" role="status"></div>
    </div>
  `;
}

function type(app: KalamosApp, text: string): void {
  const { view } = app.editor;
  view.dispatch({ changes: { from: view.state.doc.length, insert: text }, userEvent: "input.type" });
}

function key(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}

const tabEls = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="tab"]'));

describe("#81 A document tabs", () => {
  let app: KalamosApp;

  beforeEach(async () => {
    vi.useFakeTimers();
    resetMockState();
    setupDom();
    app = createKalamosApp(document);
    await app.init();
  });

  afterEach(() => {
    app.destroy();
    vi.useRealTimers();
  });

  it("starts with one untitled tab and no tab bar", () => {
    expect(app.getTabs()).toHaveLength(1);
    expect(app.getTabs()[0].label).toBe("未命名");
    expect(app.tabBar.isVisible()).toBe(false);
    expect(getMockWindowTitle()).toBe("未命名");
  });

  it("Cmd+T, Cmd+N and ＋ open untitled tabs named 未命名 2, 未命名 3…", async () => {
    key({ key: "t", code: "KeyT", metaKey: true });
    expect(app.getTabs().map((t) => t.label)).toEqual(["未命名", "未命名 2"]);
    expect(app.tabBar.isVisible()).toBe(true);
    expect(tabEls()).toHaveLength(2);

    key({ key: "n", code: "KeyN", metaKey: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.getTabs()).toHaveLength(3);

    document.querySelector<HTMLButtonElement>('[data-testid="tab-new"]')!.click();
    expect(app.getTabs().map((t) => t.label)).toEqual(["未命名", "未命名 2", "未命名 3", "未命名 4"]);
    expect(app.getTabs()[3].active).toBe(true);
    expect(getMockWindowTitle()).toBe("未命名 4");
  });

  it("keeps content and undo history per tab", () => {
    type(app, "AAA");
    const first = app.getActiveTabId();
    app.newTab();
    type(app, "BBB");
    app.activateTab(first);
    expect(app.editor.getContent()).toBe("AAA");
    vi.advanceTimersByTime(1000); // a separate undo step
    type(app, "+");
    undo(app.editor.view);
    expect(app.editor.getContent()).toBe("AAA");
    undo(app.editor.view);
    expect(app.editor.getContent()).toBe("");
    app.cycleTab(1);
    expect(app.editor.getContent()).toBe("BBB");
  });

  it("keeps the selection per tab", () => {
    type(app, "hello world");
    app.editor.view.dispatch({ selection: { anchor: 2, head: 5 } });
    const first = app.getActiveTabId();
    app.newTab();
    app.activateTab(first);
    const sel = app.editor.view.state.selection.main;
    expect([sel.anchor, sel.head]).toEqual([2, 5]);
  });

  it("global settings toggled in one tab apply to the others", () => {
    const first = app.getActiveTabId();
    app.newTab();
    app.editor.toggleSourceMode();
    app.editor.toggleCodeLineNumbers();
    app.editor.toggleFocusMode();
    app.activateTab(first);
    expect(app.editor.isSourceMode()).toBe(true);
    expect(app.editor.view.state.facet(codeLineNumbersFacet)).toBe(true);
    expect(app.editor.view.dom.classList.contains("k-focus-mode")).toBe(true);
    app.editor.toggleSourceMode();
    app.editor.toggleFocusMode();
    app.cycleTab(1);
    expect(app.editor.view.dom.classList.contains("k-focus-mode")).toBe(false);
    expect(app.editor.view.dom.querySelector(".cm-content")).not.toBeNull();
  });

  it("the image root setting and document path follow the switch", async () => {
    seedMockFile("/notes/a.md", "# A");
    await app.openDocument("/notes/a.md");
    const first = app.getActiveTabId();
    app.newTab();
    await app.setImageRootDir("/images");
    expect(app.editor.view.state.field(imageDocPathField)).toBeNull();
    app.activateTab(first);
    expect(app.editor.view.state.field(imageDocPathField)).toBe("/notes/a.md");
    expect(app.editor.view.state.field(imageRootSettingField)).toBe("/images");
  });

  it("line separator stays a per-document property", async () => {
    seedMockFile("/notes/crlf.md", "a\r\nb");
    await app.openDocument("/notes/crlf.md");
    app.newTab();
    type(app, "x");
    expect(app.editor.getContent()).toBe("x");
    app.cycleTab(-1);
    expect(app.editor.getContent()).toBe("a\r\nb");
  });

  it("labels same-name files with their folder and updates the word count / outline on switch", async () => {
    seedMockFile("/p/docs/README.md", "# Docs\n\none two three");
    seedMockFile("/p/README.md", "# Root");
    await app.openDocument("/p/docs/README.md");
    app.newTab();
    await app.openDocument("/p/README.md");
    expect(app.getTabs().map((t) => t.label)).toEqual(["README.md — docs", "README.md — p"]);
    expect(app.wordCounter.getDocumentStats().words).toBe(1);
    expect(app.sidebar.outline.getHeadings().map((h) => h.text)).toEqual(["Root"]);
    app.cycleTab(1);
    expect(app.wordCounter.getDocumentStats().words).toBe(4);
    expect(app.sidebar.outline.getHeadings().map((h) => h.text)).toEqual(["Docs"]);
    expect(getMockWindowTitle()).toBe("README.md — docs");
  });

  it("Ctrl+Tab / Ctrl+Shift+Tab cycle with wrap-around", () => {
    app.newTab();
    app.newTab();
    const ids = app.getTabs().map((t) => t.id);
    expect(app.getActiveTabId()).toBe(ids[2]);
    key({ key: "Tab", code: "Tab", ctrlKey: true });
    expect(app.getActiveTabId()).toBe(ids[0]);
    key({ key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true });
    expect(app.getActiveTabId()).toBe(ids[2]);
    key({ key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true });
    expect(app.getActiveTabId()).toBe(ids[1]);
  });

  it("clicking a tab selects it; middle click and × close it", async () => {
    app.newTab();
    app.newTab();
    tabEls()[0].click();
    expect(app.getTabs()[0].active).toBe(true);
    tabEls()[1].dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(app.getTabs()).toHaveLength(2);
    tabEls()[1].querySelector<HTMLButtonElement>('[data-testid="tab-close"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.getTabs()).toHaveLength(1);
    expect(app.tabBar.isVisible()).toBe(false);
  });

  it("Cmd+W closes the tab and activates its neighbour; the last tab becomes a blank one", async () => {
    type(app, "first");
    seedMockFile("/n/one.md", "one");
    app.newTab();
    await app.openDocument("/n/one.md");
    app.newTab();
    app.cycleTab(-1);
    key({ key: "w", code: "KeyW", metaKey: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.getTabs()).toHaveLength(2);
    expect(app.getTabs()[1].active).toBe(true);
    expect(app.getTabs()[1].label).toBe("未命名 2");

    // Untitled + dirty → prompt; discard closes.
    app.activateTab(app.getTabs()[0].id);
    setMockDialogHandlers({ saveChanges: () => "discard" });
    await app.closeTab();
    expect(getMockSaveChangesPrompts()).toEqual(["「未命名」有未儲存的變更，要在關閉前儲存嗎？"]);
    await app.closeTab();
    expect(app.getTabs()).toHaveLength(1);
    expect(app.getTabs()[0].label).toBe("未命名");
    expect(app.editor.getContent()).toBe("");
  });

  it("cancel keeps the tab; save asks for a path and writes the file", async () => {
    type(app, "draft");
    app.newTab();
    setMockDialogHandlers({ saveChanges: () => "cancel" });
    const first = app.getTabs()[0].id;
    expect(await app.closeTab(first)).toBe(false);
    expect(app.getTabs()).toHaveLength(2);
    // The prompt shows the tab it asks about.
    expect(app.getActiveTabId()).toBe(first);

    setMockDialogHandlers({ saveChanges: () => "save", save: () => "/n/draft.md" });
    expect(await app.closeTab(first)).toBe(true);
    expect(readMockFile("/n/draft.md")).toBe("draft");
    expect(app.getTabs()).toHaveLength(1);
  });

  it("a named dirty tab is saved on close when autosave is on, prompted when it is off", async () => {
    seedMockFile("/n/a.md", "a");
    await app.openDocument("/n/a.md");
    type(app, "1");
    app.newTab();
    await app.closeTab(app.getTabs()[0].id);
    expect(readMockFile("/n/a.md")).toBe("a1");
    expect(getMockSaveChangesPrompts()).toHaveLength(0);

  });

  it("with autosave off, closing a named dirty tab asks first", async () => {
    app.destroy();
    resetMockState();
    setupDom();
    seedMockSettings({ autoSave: false });
    app = createKalamosApp(document);
    await app.init();
    seedMockFile("/n/b.md", "b");
    await app.openDocument("/n/b.md");
    type(app, "2");
    setMockDialogHandlers({ saveChanges: () => "save" });
    expect(await app.closeTab()).toBe(true);
    expect(getMockSaveChangesPrompts()).toEqual(["「b.md」有未儲存的變更，要在關閉前儲存嗎？"]);
    expect(readMockFile("/n/b.md")).toBe("b2");
  });

  it("autosaves a named tab after switching away from it", async () => {
    seedMockFile("/n/bg.md", "bg");
    await app.openDocument("/n/bg.md");
    type(app, "!");
    app.newTab();
    type(app, "other");
    await vi.advanceTimersByTimeAsync(NAMED_AUTOSAVE_DELAY_MS);
    expect(readMockFile("/n/bg.md")).toBe("bg!");
    expect(app.getTabs()[0].dirty).toBe(false);
  });

  it("writes recovery for every untitled tab with changes", async () => {
    type(app, "one");
    app.newTab();
    type(app, "two");
    app.newTab();
    await vi.advanceTimersByTimeAsync(UNTITLED_RECOVERY_INTERVAL_MS);
    const entries = await listRecovery();
    expect(entries.map((e) => e.content).sort()).toEqual(["one", "two"]);
    const docIds = app.getTabs().slice(0, 2).map((t) => t.docId);
    expect(entries.map((e) => e.docId).sort()).toEqual([...docIds].sort());
  });

  it("#81 B window close lists every unsaved tab, background ones included", async () => {
    seedMockFile("/n/c.md", "c");
    await app.openDocument("/n/c.md");
    type(app, "+");
    app.newTab();
    type(app, "untitled bg");
    app.newTab();
    type(app, "untitled fg");
    app.newTab();
    setMockDialogHandlers({ saveChanges: () => "cancel" });
    expect(await triggerMockCloseRequested()).toBe(false);
    // The named file was written (autosave on); the two drafts are listed.
    expect(readMockFile("/n/c.md")).toBe("c+");
    expect(getMockSaveChangesPrompts()).toEqual([
      "以下 2 份文件有未儲存的變更：\n・未命名\n・未命名 2\n\n要在關閉前儲存嗎？",
    ]);
    expect(app.getTabs()).toHaveLength(4);
  });

  it("#81 B 全部儲存 saves each draft (asking for its path); a cancelled save dialog keeps the window", async () => {
    type(app, "one");
    app.newTab();
    type(app, "two");
    const paths = ["/n/one.md", null];
    setMockDialogHandlers({ saveChanges: () => "save", save: () => paths.shift() ?? null });
    expect(await triggerMockCloseRequested()).toBe(false);
    expect(readMockFile("/n/one.md")).toBe("one");
    expect(app.getTabs()[0].dirty).toBe(false);
    expect(app.getTabs()[1].dirty).toBe(true);

    setMockDialogHandlers({ saveChanges: () => "save", save: () => "/n/two.md" });
    expect(await triggerMockCloseRequested()).toBe(true);
    expect(readMockFile("/n/two.md")).toBe("two");
  });

  it("#81 B with autosave off, named files are listed too; ⌘Q quits only when settled", async () => {
    app.destroy();
    resetMockState();
    setupDom();
    seedMockSettings({ autoSave: false });
    app = createKalamosApp(document);
    await app.init();
    seedMockFile("/n/q.md", "q");
    await app.openDocument("/n/q.md");
    type(app, "!");
    setMockDialogHandlers({ saveChanges: () => "cancel" });
    await emitMockMenuAction("app.quit");
    await vi.advanceTimersByTimeAsync(0);
    expect(getMockQuitCount()).toBe(0);
    expect(getMockSaveChangesPrompts()[0]).toContain("・q.md");

    setMockDialogHandlers({ saveChanges: () => "save" });
    await emitMockMenuAction("app.quit");
    await vi.advanceTimersByTimeAsync(0);
    expect(readMockFile("/n/q.md")).toBe("q!");
    expect(getMockQuitCount()).toBe(1);
  });

  it("#81 B 視窗 > 顯示下一個 / 上一個分頁", async () => {
    app.newTab();
    app.newTab();
    const ids = app.getTabs().map((t) => t.id);
    await emitMockMenuAction("window.nextTab");
    expect(app.getActiveTabId()).toBe(ids[0]);
    await emitMockMenuAction("window.previousTab");
    expect(app.getActiveTabId()).toBe(ids[2]);
  });

  it("#81 B dropped Markdown files open in tabs", async () => {
    seedMockFile("/n/d1.md", "d1");
    seedMockFile("/n/d2.markdown", "d2");
    await triggerMockFileDrop({ paths: ["/n/d1.md", "/n/d2.markdown", "/n/x.txt"] });
    expect(app.getTabs().map((t) => t.path)).toEqual(["/n/d1.md", "/n/d2.markdown"]);
  });

  it("#81 B Cmd+click in the file list opens a new tab", async () => {
    seedMockFile("/n/s1.md", "s1");
    seedMockFile("/n/s2.md", "s2");
    await app.openFolder("/n");
    await app.sidebar.setTab("list");
    const item = (name: string) =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-testid="file-item"]')).find((el) =>
        el.textContent?.includes(name),
      )!;
    item("s1.md").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.getTabs().map((t) => t.path)).toEqual(["/n/s1.md"]);
    item("s2.md").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.getTabs().map((t) => t.path)).toEqual(["/n/s2.md"]);
    item("s1.md").dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(app.getTabs().map((t) => t.path)).toEqual(["/n/s2.md", "/n/s1.md"]);
  });

  it("dirty tabs are marked in the tab bar", () => {
    app.newTab();
    type(app, "x");
    expect(tabEls()[1].dataset.dirty).toBe("true");
    expect(tabEls()[0].dataset.dirty).toBe("false");
  });

  it("menu items 新增分頁 / 關閉分頁 run once per key press", async () => {
    await emitMockMenuAction("file.newTab");
    expect(app.getTabs()).toHaveLength(2);
    vi.advanceTimersByTime(MENU_THEN_KEY_WINDOW_MS + 10);
    // The page handled Cmd+W itself; the menu event for the same press is dropped.
    key({ key: "w", code: "KeyW", metaKey: true });
    await vi.advanceTimersByTimeAsync(0);
    await emitMockMenuAction("file.closeTab");
    await vi.advanceTimersByTimeAsync(0);
    expect(app.getTabs()).toHaveLength(1);
  });

  it("reorders tabs", () => {
    app.newTab();
    app.newTab();
    const ids = app.getTabs().map((t) => t.id);
    app.moveTab(ids[2], 0);
    expect(app.getTabs().map((t) => t.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(tabEls().map((el) => el.dataset.tabId)).toEqual([ids[2], ids[0], ids[1]]);
  });
});
