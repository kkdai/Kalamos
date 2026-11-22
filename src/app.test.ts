import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listRecovery,
  openFile,
  readMockFile,
  resetMockState,
  seedMockFile,
  setMockDialogHandlers,
  setMockSaveInterceptor,
  triggerMockCloseRequested,
  writeRecovery,
  type FileMeta,
} from "./ipc";
import {
  createKalamosApp,
  NAMED_AUTOSAVE_DELAY_MS,
  UNTITLED_RECOVERY_INTERVAL_MS,
  type KalamosApp,
} from "./main";

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

describe("Kalamos app — shortcuts, byte-exact save, autosave & crash recovery", () => {
  let app: KalamosApp | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    resetMockState();
    setupDom();
  });

  afterEach(() => {
    app?.destroy();
    app = null;
    vi.useRealTimers();
  });

  it("Cmd+O opens file and Cmd+S saves byte-identical content (including CRLF, CJK, no trailing newline)", async () => {
    const original = "# 標題 Title\r\n\r\n內文含 CRLF 與中文，最後沒有換行";
    seedMockFile("/tmp/crlf-cjk.md", original);
    setMockDialogHandlers({
      open: () => "/tmp/crlf-cjk.md",
    });

    app = createKalamosApp(document);
    await app.init();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "o", metaKey: true, bubbles: true }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(app.getCurrentPath()).toBe("/tmp/crlf-cjk.md");
    expect(app.editor.getContent()).toBe(original);

    // Save without editing via Cmd+S
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }),
    );
    await vi.advanceTimersByTimeAsync(0);

    const saved = await openFile("/tmp/crlf-cjk.md");
    expect(saved).toBe(original);
    expect(
      Array.from(new TextEncoder().encode(saved)),
    ).toEqual(Array.from(new TextEncoder().encode(original)));
  });

  it("Cmd+Shift+S saves as new file and Cmd+N starts a new untitled document", async () => {
    setMockDialogHandlers({
      save: () => "/tmp/save-as.md",
    });

    app = createKalamosApp(document);
    await app.init();

    userTypeText(app, "# 另存新檔測試");
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "S",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(app.getCurrentPath()).toBe("/tmp/save-as.md");
    expect(readMockFile("/tmp/save-as.md")).toBe("# 另存新檔測試");

    // Cmd+N resets to a blank untitled document
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "n", metaKey: true, bubbles: true }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(app.getCurrentPath()).toBeNull();
    expect(app.editor.getContent()).toBe("");
  });

  it("autosaves a named file 1 second after typing stops", async () => {
    seedMockFile("/tmp/autosave.md", "# Initial\n");
    app = createKalamosApp(document);
    await app.init();
    await app.openDocument("/tmp/autosave.md");

    userTypeText(app, "Added line");
    expect(readMockFile("/tmp/autosave.md")).toBe("# Initial\n");

    // Advance 500ms: not yet saved
    await vi.advanceTimersByTimeAsync(500);
    expect(readMockFile("/tmp/autosave.md")).toBe("# Initial\n");

    // Type again to verify debounce resets the 1-second timer
    userTypeText(app, "!");
    await vi.advanceTimersByTimeAsync(500);
    expect(readMockFile("/tmp/autosave.md")).toBe("# Initial\n");

    // Complete 1000ms after last edit
    await vi.advanceTimersByTimeAsync(NAMED_AUTOSAVE_DELAY_MS);
    expect(readMockFile("/tmp/autosave.md")).toBe("# Initial\nAdded line!");
    expect(app.editor.isDirty()).toBe(false);
  });

  it("keeps isDirty() true if user edits while saveFile is in flight, then autosaves 1s later", async () => {
    seedMockFile("/tmp/inflight.md", "v0");
    app = createKalamosApp(document);
    await app.init();
    await app.openDocument("/tmp/inflight.md");

    let resolveInFlightSave!: (meta: FileMeta) => void;
    let firstCall = true;
    setMockSaveInterceptor(async (_path, _content, defaultSave) => {
      if (firstCall) {
        firstCall = false;
        return new Promise<FileMeta>((resolve) => {
          resolveInFlightSave = async () => {
            resolve(await defaultSave());
          };
        });
      }
      return defaultSave();
    });

    userTypeText(app, "-v1");
    const savePromise = app.saveDocument();

    // User types more before first save resolves
    userTypeText(app, "-v2");

    // Resolve first save ("v0-v1")
    await resolveInFlightSave(undefined as unknown as FileMeta);
    await savePromise;

    expect(readMockFile("/tmp/inflight.md")).toBe("v0-v1");
    expect(app.editor.isDirty()).toBe(true);

    // 1 second later, autosave saves the newer content ("v0-v1-v2")
    await vi.advanceTimersByTimeAsync(NAMED_AUTOSAVE_DELAY_MS);
    expect(readMockFile("/tmp/inflight.md")).toBe("v0-v1-v2");
    expect(app.editor.isDirty()).toBe(false);
  });

  it("on saveFile or openFile failure, keeps dirty, writes recovery with path, and shows error in #status", async () => {
    seedMockFile("/tmp/fail-save.md", "hello");
    app = createKalamosApp(document);
    await app.init();

    // Test openFile failure displays status without throwing unhandled rejection
    const openedMissing = await app.openDocument("/tmp/non-existent.md");
    expect(openedMissing).toBe(false);
    const statusEl = document.querySelector<HTMLElement>('[data-testid="status"]')!;
    expect(statusEl.textContent).toContain("開檔失敗");

    // Open valid file, then make saveFile fail during autosave
    await app.openDocument("/tmp/fail-save.md");
    expect(statusEl.textContent).toBe("");

    setMockSaveInterceptor(async () => {
      throw { kind: "PermissionDenied", message: "Read-only file" };
    });

    userTypeText(app, " world");
    await vi.advanceTimersByTimeAsync(NAMED_AUTOSAVE_DELAY_MS);

    expect(app.editor.isDirty()).toBe(true);
    expect(statusEl.textContent).toContain("存檔失敗");
    expect(statusEl.textContent).toContain("Read-only file");

    const recoveries = await listRecovery();
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].path).toBe("/tmp/fail-save.md");
    expect(recoveries[0].content).toBe("hello world");
  });

  it("writes recovery every 5 seconds for untitled documents and restored content stays dirty", async () => {
    app = createKalamosApp(document);
    await app.init();

    const draft = "# 未命名重要草稿\n\n強制結束前寫的內容";
    userTypeText(app, draft);

    await vi.advanceTimersByTimeAsync(UNTITLED_RECOVERY_INTERVAL_MS);

    const entries = await listRecovery();
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe(draft);
    expect(entries[0].path).toBeNull();

    // Simulate force-quit and relaunch
    app.destroy();
    setupDom();
    app = createKalamosApp(document);
    await app.init();

    const banner = document.getElementById("recovery-banner")!;
    expect(banner.dataset.visible).toBe("true");
    expect(app.getPendingRecovery()?.content).toBe(draft);

    // Click restore button
    const restoreBtn = document.getElementById("recovery-restore-btn")!;
    restoreBtn.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(app.editor.getContent()).toBe(draft);
    expect(app.editor.isDirty()).toBe(true);
    expect(banner.dataset.visible).toBe("false");
    expect(await listRecovery()).toHaveLength(0);

    // Because restored untitled doc is dirty, after 5s it writes recovery again
    await vi.advanceTimersByTimeAsync(UNTITLED_RECOVERY_INTERVAL_MS);
    const reSavedRecovery = await listRecovery();
    expect(reSavedRecovery).toHaveLength(1);
    expect(reSavedRecovery[0].content).toBe(draft);
  });

  it("restoring a named recovery entry marks it dirty and triggers autosave after 1s", async () => {
    seedMockFile("/tmp/named-recover.md", "old content");
    await writeRecovery("doc-named", "recovered newer content", "/tmp/named-recover.md");

    app = createKalamosApp(document);
    await app.init();

    await app.restoreRecovery();
    expect(app.getCurrentPath()).toBe("/tmp/named-recover.md");
    expect(app.editor.isDirty()).toBe(true);

    await vi.advanceTimersByTimeAsync(NAMED_AUTOSAVE_DELAY_MS);
    expect(readMockFile("/tmp/named-recover.md")).toBe("recovered newer content");
    expect(app.editor.isDirty()).toBe(false);
  });

  it("#81 B opening a file never replaces unsaved changes: it gets a new tab, or the tab it is already in", async () => {
    app = createKalamosApp(document);
    await app.init();

    userTypeText(app, "unsaved untitled text");
    await vi.advanceTimersByTimeAsync(UNTITLED_RECOVERY_INTERVAL_MS);
    expect(await listRecovery()).toHaveLength(1);
    seedMockFile("/tmp/other.md", "other");

    const ask = vi.fn(() => false);
    setMockDialogHandlers({ ask });
    expect(await app.openDocument("/tmp/other.md")).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(app.getCurrentPath()).toBe("/tmp/other.md");
    expect(app.getTabs().map((t) => t.path)).toEqual([null, "/tmp/other.md"]);
    expect(await listRecovery()).toHaveLength(1);

    // Already open: switched to, not opened again.
    app.cycleTab(1);
    expect(await app.openDocument("/tmp/other.md")).toBe(true);
    expect(app.getTabs()).toHaveLength(2);
    expect(app.getCurrentPath()).toBe("/tmp/other.md");

    // Sidebar click ("current"): replaces a clean tab, opens a new tab next to a dirty one.
    seedMockFile("/tmp/third.md", "third");
    await app.openPath("/tmp/third.md", "current");
    expect(app.getTabs().map((t) => t.path)).toEqual([null, "/tmp/third.md"]);
    userTypeText(app, "!");
    seedMockFile("/tmp/fourth.md", "fourth");
    await app.openPath("/tmp/fourth.md", "current");
    expect(app.getTabs().map((t) => t.path)).toEqual([null, "/tmp/third.md", "/tmp/fourth.md"]);
    // Cmd+click ("newTab"): always a new tab.
    seedMockFile("/tmp/fifth.md", "fifth");
    await app.openPath("/tmp/fifth.md", "newTab");
    expect(app.getTabs()).toHaveLength(4);
  });

  it("#81 B window close: named files are written (autosave on); unsaved untitled text is asked about", async () => {
    app = createKalamosApp(document);
    await app.init();

    seedMockFile("/tmp/closing-named.md", "start");
    await app.openDocument("/tmp/closing-named.md");
    userTypeText(app, " end");
    expect(await triggerMockCloseRequested()).toBe(true);
    expect(readMockFile("/tmp/closing-named.md")).toBe("start end");
    expect(app.editor.isDirty()).toBe(false);

    app.newTab();
    userTypeText(app, "closing untitled draft");
    await vi.advanceTimersByTimeAsync(UNTITLED_RECOVERY_INTERVAL_MS);
    setMockDialogHandlers({ saveChanges: () => "cancel" });
    expect(await triggerMockCloseRequested()).toBe(false);
    expect(await listRecovery()).toHaveLength(1);
    setMockDialogHandlers({ saveChanges: () => "discard" });
    expect(await triggerMockCloseRequested()).toBe(true);
    expect(await listRecovery()).toHaveLength(0);
  });
});
