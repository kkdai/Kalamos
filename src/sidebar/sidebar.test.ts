import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSettings,
  listRecovery,
  openFile,
  readMockFile,
  resetMockState,
  seedMockDir,
  seedMockFile,
  setMockDialogHandlers,
  triggerMockFsChanged,
} from "../ipc";
import {
  createKalamosApp,
  NAMED_AUTOSAVE_DELAY_MS,
  UNTITLED_RECOVERY_INTERVAL_MS,
  type KalamosApp,
} from "../main";

function setupDom(): HTMLElement {
  document.body.innerHTML = `
    <div id="app">
      <div id="recovery-banner" role="alert" data-visible="false">
        <span id="recovery-message">偵測到上次未儲存的內容，是否還原？</span>
        <div id="recovery-actions">
          <button type="button" id="recovery-restore-btn">還原</button>
          <button type="button" id="recovery-discard-btn">捨棄</button>
        </div>
      </div>
      <aside id="sidebar" data-testid="sidebar" data-visible="false"></aside>
      <main id="editor-container" aria-label="Markdown Editor"></main>
      <div id="status" data-testid="status" role="status" aria-live="polite"></div>
    </div>
  `;
  return document.getElementById("app")!;
}

function userTypeText(app: KalamosApp, text: string): void {
  const { view } = app.editor;
  view.dispatch({
    changes: { from: view.state.doc.length, insert: text },
  });
}

describe("Sidebar — file tree, file list, fs-changed, context menu, and shortcuts (NV-01)", () => {
  let app: KalamosApp | null = null;

  beforeEach(() => {
    resetMockState();
    setupDom();
  });

  afterEach(() => {
    app?.destroy();
    app = null;
    vi.useRealTimers();
  });

  it("renders file tree sorted dirs-first & case-insensitive, expands folders, and opens files on click", async () => {
    seedMockDir("/notes/zeta");
    seedMockDir("/notes/Alpha");
    seedMockFile("/notes/Alpha/nested.md", "# Nested Alpha Content");
    seedMockFile("/notes/beta.md", "# Beta Content");
    seedMockFile("/notes/apple.md", "# Apple Content");
    seedMockFile("/notes/Banana.markdown", "# Banana Content");

    app = createKalamosApp(document);
    await app.init();
    await app.openFolder("/notes");

    const folderItems = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="folder-item"]'),
    );
    expect(folderItems.map((el) => el.dataset.path)).toEqual([
      "/notes/Alpha",
      "/notes/zeta",
    ]);

    // Before expanding /notes/Alpha, only top-level markdown files are rendered
    const topLevelFiles = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="file-item"]'),
    );
    expect(topLevelFiles.map((el) => el.dataset.path)).toEqual([
      "/notes/apple.md",
      "/notes/Banana.markdown",
      "/notes/beta.md",
    ]);

    // Click /notes/Alpha to expand it
    folderItems[0].click();
    const expandedFiles = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="file-item"]'),
    );
    expect(expandedFiles.map((el) => el.dataset.path)).toEqual([
      "/notes/Alpha/nested.md",
      "/notes/apple.md",
      "/notes/Banana.markdown",
      "/notes/beta.md",
    ]);

    // Click nested.md to open it in the editor
    const nestedItem = document.querySelector<HTMLElement>(
      '[data-testid="file-item"][data-path="/notes/Alpha/nested.md"]',
    )!;
    nestedItem.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(app.getCurrentPath()).toBe("/notes/Alpha/nested.md");
    expect(app.editor.getContent()).toBe("# Nested Alpha Content");
  });

  it("preserves expanded folder state and updates tree when fs-changed event arrives", async () => {
    app = createKalamosApp(document);
    await app.init();
    await app.openFolder("/demo");

    // Expand /demo/guides
    const guidesDir = document.querySelector<HTMLElement>(
      '[data-testid="folder-item"][data-path="/demo/guides"]',
    )!;
    guidesDir.click();
    expect(app.sidebar.fileTree.isExpanded("/demo/guides")).toBe(true);
    expect(
      document.querySelector(
        '[data-testid="file-item"][data-path="/demo/guides/shortcuts.md"]',
      ),
    ).not.toBeNull();

    // External process adds a new file inside /demo/guides and triggers fs-changed
    seedMockFile("/demo/guides/external-added.md", "# 外部新增檔案");
    await triggerMockFsChanged({
      root: "/demo",
      paths: ["/demo/guides/external-added.md"],
    });

    // Subfolder /demo/guides remains expanded and the new file is visible
    expect(app.sidebar.fileTree.isExpanded("/demo/guides")).toBe(true);
    const addedEl = document.querySelector<HTMLElement>(
      '[data-testid="file-item"][data-path="/demo/guides/external-added.md"]',
    );
    expect(addedEl).not.toBeNull();
  });

  it("switches between File Tree and File List tabs, sorting list by mtimeMs desc with excerpt", async () => {
    seedMockFile("/project/old.md", "# 舊文件標題\n內文", 1000);
    seedMockFile("/project/sub/new.md", "\n# 最新修改的文件\n內文", 5000);
    seedMockFile("/project/mid.md", "# 中間文件\n內文", 3000);

    app = createKalamosApp(document);
    await app.init();
    await app.openFolder("/project");

    const listTabBtn = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-tab-list"]',
    )!;
    listTabBtn.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(app.sidebar.getTab()).toBe("list");
    const listItems = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="file-item"]'),
    );
    expect(listItems.map((el) => el.dataset.path)).toEqual([
      "/project/sub/new.md",
      "/project/mid.md",
      "/project/old.md",
    ]);
    expect(listItems[0].textContent).toContain("new.md");
    expect(listItems[0].textContent).toContain("# 最新修改的文件");

    // Clicking an item in File List opens the document
    listItems[0].click();
    await new Promise((r) => setTimeout(r, 0));
    expect(app.getCurrentPath()).toBe("/project/sub/new.md");
    expect(app.editor.getContent()).toBe("\n# 最新修改的文件\n內文");

    // Switch back to File Tree tab
    const treeTabBtn = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-tab-tree"]',
    )!;
    treeTabBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(app.sidebar.getTab()).toBe("tree");
  });

  it("toggles sidebar with Cmd+Shift+L, opens folder with Cmd+Shift+O, and restores settings on startup", async () => {
    setMockDialogHandlers({
      openFolder: () => "/demo",
    });

    app = createKalamosApp(document);
    await app.init();

    const sidebarEl = document.querySelector<HTMLElement>('[data-testid="sidebar"]')!;
    expect(sidebarEl.dataset.visible).toBe("false");

    // Cmd+Shift+L shows sidebar
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "L",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(sidebarEl.dataset.visible).toBe("true");

    // Cmd+Shift+O opens folder from dialog
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "O",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(app.sidebar.getCurrentFolder()).toBe("/demo");

    // Switch tab to list
    await app.sidebar.setTab("list");

    const savedSettings = await getSettings();
    expect(savedSettings.sidebarVisible).toBe(true);
    expect(savedSettings.sidebarTab).toBe("list");
    expect(savedSettings.lastFolder).toBe("/demo");

    // Restart app and verify settings are restored
    app.destroy();
    setupDom();
    app = createKalamosApp(document);
    await app.init();

    const restoredSidebarEl = document.querySelector<HTMLElement>(
      '[data-testid="sidebar"]',
    )!;
    expect(restoredSidebarEl.dataset.visible).toBe("true");
    expect(app.sidebar.getTab()).toBe("list");
    expect(app.sidebar.getCurrentFolder()).toBe("/demo");
  });

  it("supports context menu actions (create auto-.md, rename, trash) and closes context menu on Escape", async () => {
    app = createKalamosApp(document);
    await app.init();
    await app.openFolder("/demo");

    // Right-click on /demo/notes.md to open context menu, then press Escape to close
    const notesItem = document.querySelector<HTMLElement>(
      '[data-testid="file-item"][data-path="/demo/notes.md"]',
    )!;
    notesItem.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    const contextMenu = document.querySelector<HTMLElement>(
      '[data-testid="sidebar-context-menu"]',
    )!;
    expect(contextMenu.dataset.visible).toBe("true");

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(contextMenu.dataset.visible).toBe("false");

    // 1. Right-click and create a file without extension -> auto-appends .md
    notesItem.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    document
      .querySelector<HTMLButtonElement>('[data-testid="context-menu-create"]')!
      .click();

    const inlineInput = document.querySelector<HTMLInputElement>(
      '[data-testid="sidebar-inline-input"]',
    )!;
    expect(inlineInput).not.toBeNull();
    inlineInput.value = "draft";
    inlineInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(app.getCurrentPath()).toBe("/demo/draft.md");
    expect(
      document.querySelector(
        '[data-testid="file-item"][data-path="/demo/draft.md"]',
      ),
    ).not.toBeNull();

    // 2. Right-click on /demo/draft.md and rename to draft-renamed.md
    const draftItem = document.querySelector<HTMLElement>(
      '[data-testid="file-item"][data-path="/demo/draft.md"]',
    )!;
    draftItem.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    document
      .querySelector<HTMLButtonElement>('[data-testid="context-menu-rename"]')!
      .click();

    const renameInput = document.querySelector<HTMLInputElement>(
      '[data-testid="sidebar-inline-input"]',
    )!;
    renameInput.value = "draft-renamed.md";
    renameInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(app.getCurrentPath()).toBe("/demo/draft-renamed.md");
    expect(
      document.querySelector(
        '[data-testid="file-item"][data-path="/demo/draft-renamed.md"]',
      ),
    ).not.toBeNull();

    // 3. Right-click on /demo/draft-renamed.md and move to trash
    const renamedItem = document.querySelector<HTMLElement>(
      '[data-testid="file-item"][data-path="/demo/draft-renamed.md"]',
    )!;
    renamedItem.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    document
      .querySelector<HTMLButtonElement>('[data-testid="context-menu-trash"]')!
      .click();
    await new Promise((r) => setTimeout(r, 0));

    expect(
      document.querySelector(
        '[data-testid="file-item"][data-path="/demo/draft-renamed.md"]',
      ),
    ).toBeNull();
    await expect(openFile("/demo/draft-renamed.md")).rejects.toMatchObject({
      kind: "NotFound",
    });
  });

  it("rejects invalid file names (empty, /, \\, .., leading .) in create and rename and shows error in status", async () => {
    app = createKalamosApp(document);
    await app.init();
    await app.openFolder("/demo");

    const statusEl = document.querySelector<HTMLElement>('[data-testid="status"]')!;
    const invalidNames = ["", "   ", "../escape.md", "sub/nested.md", "a\\b.md", ".hidden.md"];

    for (const bad of invalidNames) {
      statusEl.textContent = "";
      const created = await app.sidebar.createNewFile("/demo", bad);
      expect(created).toBeNull();
      expect(statusEl.dataset.error).toBe("true");
      expect(statusEl.textContent).toContain("新增檔案失敗");

      statusEl.textContent = "";
      const renamed = await app.sidebar.renameItem("/demo/notes.md", bad);
      expect(renamed).toBe(false);
      expect(statusEl.dataset.error).toBe("true");
      expect(statusEl.textContent).toContain("重新命名失敗");
    }
  });

  it("updates currentPath when renaming open file or its parent folder, and autosaves to new path without recreating old path", async () => {
    vi.useFakeTimers();
    seedMockDir("/demo/note");
    seedMockDir("/demo/notebook");
    seedMockFile("/demo/note/inside.md", "initial folder file");
    seedMockFile("/demo/notebook/ stay.md", "stay untouched");

    app = createKalamosApp(document);
    await app.init();
    await app.openFolder("/demo");

    // 1. Open /demo/notes.md, edit it (scheduling 1s autosave), and immediately rename it
    await app.openDocument("/demo/notes.md");
    userTypeText(app, "\n追加修改內容");
    expect(app.editor.isDirty()).toBe(true);

    const renamedOk = await app.sidebar.renameItem("/demo/notes.md", "notes-v2.md");
    expect(renamedOk).toBe(true);
    expect(app.getCurrentPath()).toBe("/demo/notes-v2.md");

    // After 1s autosave, new path gets the edited content and old path does NOT reappear
    await vi.advanceTimersByTimeAsync(NAMED_AUTOSAVE_DELAY_MS);
    expect(readMockFile("/demo/notes-v2.md")).toContain("追加修改內容");
    expect(readMockFile("/demo/notes.md")).toBeUndefined();
    expect(app.editor.isDirty()).toBe(false);

    // 2. Prefix boundary check: if /demo/notebook/ stay.md is open, renaming /demo/note must NOT affect it
    await app.openDocument("/demo/notebook/ stay.md");
    await app.sidebar.renameItem("/demo/note", "note-renamed");
    expect(app.getCurrentPath()).toBe("/demo/notebook/ stay.md");

    // 3. If /demo/note-renamed/inside.md is open and dirty, renaming folder /demo/note-renamed updates currentPath
    await app.openDocument("/demo/note-renamed/inside.md");
    userTypeText(app, " + folder edit");
    await app.sidebar.renameItem("/demo/note-renamed", "note-final");
    expect(app.getCurrentPath()).toBe("/demo/note-final/inside.md");

    await vi.advanceTimersByTimeAsync(NAMED_AUTOSAVE_DELAY_MS);
    expect(readMockFile("/demo/note-final/inside.md")).toBe(
      "initial folder file + folder edit",
    );
    expect(readMockFile("/demo/note-renamed/inside.md")).toBeUndefined();
  });

  it("converts open file to dirty untitled document when trashed (or parent folder trashed) without writing back to old path", async () => {
    vi.useFakeTimers();
    app = createKalamosApp(document);
    await app.init();
    await app.openFolder("/demo");

    await app.openDocument("/demo/notes.md");
    const originalText = app.editor.getContent();
    userTypeText(app, "\n刪除前未存修改");

    // Trash currently open file while autosave timer is pending
    const trashed = await app.sidebar.trashItem("/demo/notes.md");
    expect(trashed).toBe(true);

    expect(app.getCurrentPath()).toBeNull();
    expect(app.editor.getContent()).toBe(`${originalText}\n刪除前未存修改`);
    expect(app.editor.isDirty()).toBe(true);
    expect(app.getStatusText()).toBe("檔案已移到垃圾桶，內容保留為未命名文件");

    // Advance past 1s autosave delay: old path must NOT be recreated
    await vi.advanceTimersByTimeAsync(NAMED_AUTOSAVE_DELAY_MS * 2);
    expect(readMockFile("/demo/notes.md")).toBeUndefined();

    // Advance to 5s untitled recovery interval: content is saved to recovery
    await vi.advanceTimersByTimeAsync(UNTITLED_RECOVERY_INTERVAL_MS);
    const recoveries = await listRecovery();
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].path).toBeNull();
    expect(recoveries[0].content).toBe(`${originalText}\n刪除前未存修改`);
  });
});
