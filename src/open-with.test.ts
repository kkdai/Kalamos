import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetMockState,
  seedMockFile,
  setMockDialogHandlers,
  triggerMockOpenFiles,
} from "./ipc";
import {
  createKalamosApp,
  type KalamosApp,
  openWithStatusMessage,
} from "./main";

function setupDom(): void {
  document.body.innerHTML = `
    <div id="app">
      <div id="recovery-banner" data-visible="false">
        <button type="button" id="recovery-restore-btn">還原</button>
        <button type="button" id="recovery-discard-btn">捨棄</button>
      </div>
      <main id="editor-container"></main>
      <div id="status" data-testid="status"></div>
    </div>
  `;
}

function userTypeText(app: KalamosApp, text: string): void {
  const { view } = app.editor;
  view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
}

describe("#67 open with Kalamos (Finder / Dock / open -a)", () => {
  let app: KalamosApp | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    resetMockState();
    setupDom();
    seedMockFile("/tmp/kalamos-test/a.md", "# A\n");
    seedMockFile("/tmp/kalamos-test/b.md", "# B\n");
  });

  afterEach(() => {
    app?.destroy();
    app = null;
    vi.useRealTimers();
  });

  it("cold launch: a file queued before the frontend is ready opens once init finishes", async () => {
    await triggerMockOpenFiles({ paths: ["/tmp/kalamos-test/a.md"] });
    app = createKalamosApp(document);
    expect(app.getCurrentPath()).toBeNull();
    await app.init();
    expect(app.getCurrentPath()).toBe("/tmp/kalamos-test/a.md");
    expect(app.editor.getContent()).toBe("# A\n");
    expect(app.editor.isDirty()).toBe(false);
  });

  it("app already running: an opened event switches the current window to that file", async () => {
    app = createKalamosApp(document);
    await app.init();
    await triggerMockOpenFiles({ paths: ["/tmp/kalamos-test/b.md"] });
    expect(app.getCurrentPath()).toBe("/tmp/kalamos-test/b.md");
    expect(app.editor.getContent()).toBe("# B\n");
  });

  it("#81 B several files: each opens in its own tab, in order", async () => {
    app = createKalamosApp(document);
    await app.init();
    await triggerMockOpenFiles({
      paths: ["/tmp/kalamos-test/a.md", "/tmp/kalamos-test/b.md"],
    });
    // The blank untitled tab was reused for the first file.
    expect(app.getTabs().map((t) => t.path)).toEqual([
      "/tmp/kalamos-test/a.md",
      "/tmp/kalamos-test/b.md",
    ]);
    expect(app.getCurrentPath()).toBe("/tmp/kalamos-test/b.md");
    expect(app.getStatusText()).toBe("");
  });

  it("#81 B a file that is already open is switched to, not opened twice", async () => {
    app = createKalamosApp(document);
    await app.init();
    await triggerMockOpenFiles({
      paths: ["/tmp/kalamos-test/a.md", "/tmp/kalamos-test/b.md"],
    });
    await triggerMockOpenFiles({ paths: ["/tmp/kalamos-test/a.md"] });
    expect(app.getTabs()).toHaveLength(2);
    expect(app.getCurrentPath()).toBe("/tmp/kalamos-test/a.md");
  });

  it("refused files only: keeps the current document and shows an error", async () => {
    app = createKalamosApp(document);
    await app.init();
    await triggerMockOpenFiles({ rejected: ["notes.txt"] });
    expect(app.getCurrentPath()).toBeNull();
    expect(app.getStatusText()).toContain("無法開啟：notes.txt");
    expect(document.getElementById("status")!.dataset.error).toBe("true");
  });

  it("#81 B unsaved untitled changes: no prompt — the file opens in a new tab and the draft stays", async () => {
    const ask = vi.fn(() => false);
    setMockDialogHandlers({ ask });
    app = createKalamosApp(document);
    await app.init();
    userTypeText(app, "還沒存檔的草稿");

    await triggerMockOpenFiles({ paths: ["/tmp/kalamos-test/a.md"] });
    expect(ask).not.toHaveBeenCalled();
    expect(app.getCurrentPath()).toBe("/tmp/kalamos-test/a.md");
    expect(app.getTabs()).toHaveLength(2);
    app.cycleTab(1);
    expect(app.editor.getContent()).toBe("還沒存檔的草稿");
  });

  it("unsaved changes on cold launch: the queued file opens beside the draft", async () => {
    app = createKalamosApp(document);
    userTypeText(app, "draft");
    await triggerMockOpenFiles({ paths: ["/tmp/kalamos-test/a.md"] });
    await app.init();
    expect(app.getTabs().map((t) => t.path)).toEqual([
      null,
      "/tmp/kalamos-test/a.md",
    ]);
  });

  it("status message lists refused files", () => {
    expect(openWithStatusMessage(["x.txt", "y.pdf"])).toBe(
      "無法開啟：x.txt、y.pdf（只支援一般的 Markdown 檔案）",
    );
    expect(openWithStatusMessage([])).toBe("");
  });
});
