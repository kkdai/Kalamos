import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_UI_LOCALE, initUiLocale } from "../i18n";
import {
  deleteMockFile,
  getMockSaveChangesPrompts,
  getMockWatchedOpenFiles,
  readMockFile,
  renamePath,
  resetMockState,
  seedMockFile,
  setMockDialogHandlers,
  triggerMockFsChanged,
  triggerMockOpenFilesChanged,
} from "../ipc";
import {
  createKalamosApp,
  type KalamosApp,
  NAMED_AUTOSAVE_DELAY_MS,
} from "../main";

function setupDom(): void {
  document.body.innerHTML = `
    <div id="app">
      <div id="recovery-banner" role="alert" data-visible="false">
        <span id="recovery-message"></span>
        <div id="recovery-actions">
          <button type="button" id="recovery-restore-btn"></button>
          <button type="button" id="recovery-discard-btn"></button>
        </div>
      </div>
      <aside id="sidebar" data-visible="false"></aside>
      <main id="editor-container"></main>
      <footer id="statusbar">
        <div id="status" data-testid="status" role="status" aria-live="polite"></div>
      </footer>
    </div>
  `;
}

function userType(app: KalamosApp, text: string): void {
  const { view } = app.editor;
  view.dispatch({
    changes: { from: view.state.doc.length, insert: text },
    userEvent: "input.type",
  });
}

function bannerEl(): HTMLElement {
  return document.querySelector<HTMLElement>(
    '[data-testid="external-change-banner"]',
  )!;
}

describe("#145 external file change detection (app integration)", () => {
  let app: KalamosApp;

  beforeEach(async () => {
    vi.useFakeTimers();
    resetMockState();
    initUiLocale(DEFAULT_UI_LOCALE);
    setupDom();
    app = createKalamosApp(document);
    await app.init();
  });

  afterEach(() => {
    app.destroy();
    initUiLocale(DEFAULT_UI_LOCALE);
    vi.useRealTimers();
  });

  it("AC1: auto-reloads a clean file on external edit, preserves cursor line/col, and updates status", async () => {
    const file = "/tmp/kalamos-test/clean.md";
    seedMockFile(file, "Line 1\nLine 2 hello\nLine 3");
    await app.openDocument(file);
    expect(getMockWatchedOpenFiles()).toContain(file);

    // Place cursor on line 2, column 6 ("Line 2| hello")
    const line2 = app.editor.view.state.doc.line(2);
    app.editor.setCursor(line2.from + 6);

    seedMockFile(file, "Line 1 updated\nLine 2 world!!\nLine 3");
    await triggerMockOpenFilesChanged([file]);

    expect(app.editor.getContent()).toBe(
      "Line 1 updated\nLine 2 world!!\nLine 3",
    );
    expect(app.editor.isDirty()).toBe(false);
    expect(app.getStatusText()).toBe("已從磁碟重新載入");
    expect(bannerEl().dataset.visible).toBe("false");

    const pos = app.editor.view.state.selection.main.head;
    const newLine = app.editor.view.state.doc.lineAt(pos);
    expect(newLine.number).toBe(2);
    expect(pos - newLine.from).toBe(6);
  });

  it("AC1: auto-reloads a clean background tab via fs-changed without losing active tab", async () => {
    const bgFile = "/tmp/kalamos-test/bg.md";
    const fgFile = "/tmp/kalamos-test/fg.md";
    seedMockFile(bgFile, "# BG v1");
    seedMockFile(fgFile, "# FG v1");

    await app.openDocument(bgFile);
    await app.openDocument(fgFile);
    expect(app.getCurrentPath()).toBe(fgFile);

    seedMockFile(bgFile, "# BG v2 external");
    await triggerMockFsChanged({ root: "/tmp/kalamos-test", paths: [bgFile] });

    // Switch back to bg tab: already updated cleanly
    app.activateTab(app.getTabs()[0].id);
    expect(app.editor.getContent()).toBe("# BG v2 external");
    expect(app.editor.isDirty()).toBe(false);
    expect(bannerEl().dataset.visible).toBe("false");
  });

  it("AC2: pauses autosave on conflict and lets user keep local version or load disk version", async () => {
    const file = "/tmp/kalamos-test/conflict.md";
    seedMockFile(file, "# Initial");
    await app.openDocument(file);

    userType(app, "\nLocal draft");
    // External edit happens before the 1s autosave timer fires
    seedMockFile(file, "# External revision");
    await triggerMockOpenFilesChanged([file]);

    expect(bannerEl().dataset.visible).toBe("true");
    expect(bannerEl().dataset.kind).toBe("conflict");
    expect(app.getTabs()[0].externalStatus).toBe("conflict");

    // Advance well past autosave delay: disk MUST NOT be overwritten
    await vi.advanceTimersByTimeAsync(NAMED_AUTOSAVE_DELAY_MS * 5);
    expect(readMockFile(file)).toBe("# External revision");

    // Pressing Cmd+S directly while in conflict MUST NOT silently overwrite
    expect(await app.saveDocument()).toBe(false);
    expect(readMockFile(file)).toBe("# External revision");

    // Choice 1: Keep My Version (Overwrite Disk)
    document
      .querySelector<HTMLButtonElement>(
        '[data-testid="external-change-keep-mine"]',
      )!
      .click();
    await vi.advanceTimersByTimeAsync(0);

    expect(readMockFile(file)).toBe("# Initial\nLocal draft");
    expect(app.editor.isDirty()).toBe(false);
    expect(bannerEl().dataset.visible).toBe("false");
    expect(app.getTabs()[0].externalStatus).toBe("synced");

    // Trigger a second conflict and choose Load Disk Version
    userType(app, "\nMore local edits");
    seedMockFile(file, "# External v2 wins");
    await triggerMockOpenFilesChanged([file]);
    expect(bannerEl().dataset.visible).toBe("true");
    expect(bannerEl().dataset.kind).toBe("conflict");

    document
      .querySelector<HTMLButtonElement>(
        '[data-testid="external-change-load-disk"]',
      )!
      .click();
    await vi.advanceTimersByTimeAsync(0);

    expect(app.editor.getContent()).toBe("# External v2 wins");
    expect(app.editor.isDirty()).toBe(false);
    expect(bannerEl().dataset.visible).toBe("false");
    expect(app.getStatusText()).toBe("已從磁碟重新載入");
  });

  it("AC3: detects external delete/rename, pauses autosave, preserves content, and supports Save As or Recreate", async () => {
    const file = "/tmp/kalamos-test/vanished.md";
    seedMockFile(file, "# Important notes");
    await app.openDocument(file);

    deleteMockFile(file);
    await triggerMockOpenFilesChanged([file]);

    expect(bannerEl().dataset.visible).toBe("true");
    expect(bannerEl().dataset.kind).toBe("missing");
    expect(app.editor.getContent()).toBe("# Important notes");
    expect(app.getTabs()[0].externalStatus).toBe("missing");

    // Typing while missing does NOT silently recreate the deleted file via autosave
    userType(app, "\nStill writing");
    await vi.advanceTimersByTimeAsync(NAMED_AUTOSAVE_DELAY_MS * 3);
    expect(readMockFile(file)).toBeUndefined();

    // Closing tab while missing prompts instead of silently discarding
    setMockDialogHandlers({ saveChanges: () => "cancel" });
    expect(await app.closeTab()).toBe(false);
    expect(getMockSaveChangesPrompts()).toHaveLength(1);

    // Recreate at original path
    document
      .querySelector<HTMLButtonElement>(
        '[data-testid="external-change-recreate"]',
      )!
      .click();
    await vi.advanceTimersByTimeAsync(0);

    expect(readMockFile(file)).toBe("# Important notes\nStill writing");
    expect(bannerEl().dataset.visible).toBe("false");
    expect(app.getTabs()[0].externalStatus).toBe("synced");

    // External rename away -> missing banner, Cmd+S redirects to Save As
    await renamePath(file, "/tmp/kalamos-test/renamed-away.md");
    await triggerMockOpenFilesChanged([file]);
    expect(bannerEl().dataset.visible).toBe("true");
    expect(bannerEl().dataset.kind).toBe("missing");

    setMockDialogHandlers({
      save: () => "/tmp/kalamos-test/saved-copy.md",
    });
    expect(await app.saveDocument()).toBe(true);
    expect(app.getCurrentPath()).toBe("/tmp/kalamos-test/saved-copy.md");
    expect(readMockFile("/tmp/kalamos-test/saved-copy.md")).toBe(
      "# Important notes\nStill writing",
    );
    expect(readMockFile(file)).toBeUndefined();
    expect(bannerEl().dataset.visible).toBe("false");
  });

  it("AC4: self-save updates baseline and never triggers false-positive reload or conflict", async () => {
    const file = "/tmp/kalamos-test/self-save.md";
    seedMockFile(file, "# Start");
    await app.openDocument(file);

    userType(app, "\nSelf edit");
    expect(await app.saveDocument()).toBe(true);
    expect(readMockFile(file)).toBe("# Start\nSelf edit");
    expect(app.getStatusText()).toBe("");

    // Even if a delayed watch event arrives for our own save, it is ignored
    await triggerMockOpenFilesChanged([file]);
    await triggerMockFsChanged({ root: "/tmp/kalamos-test", paths: [file] });
    expect(app.getStatusText()).toBe("");
    expect(bannerEl().dataset.visible).toBe("false");
    expect(app.getTabs()[0].externalStatus).toBe("synced");
  });

  it("pre-save last line of defense blocks autosave & manual save when disk diverged silently", async () => {
    const file = "/tmp/kalamos-test/stealth.md";
    seedMockFile(file, "# Base");
    await app.openDocument(file);

    userType(app, "\nMy edit");
    // Disk modified without emitting any watch event
    seedMockFile(file, "# Stealth external edit");

    // Autosave fires -> pre-save hash mismatch catches it and enters conflict without overwriting
    await vi.advanceTimersByTimeAsync(NAMED_AUTOSAVE_DELAY_MS);
    expect(readMockFile(file)).toBe("# Stealth external edit");
    expect(bannerEl().dataset.visible).toBe("true");
    expect(bannerEl().dataset.kind).toBe("conflict");

    // Same for silent deletion before save on another tab
    const file2 = "/tmp/kalamos-test/stealth-del.md";
    seedMockFile(file2, "# Base 2");
    await app.openDocument(file2);
    userType(app, "\nMy edit 2");
    deleteMockFile(file2);

    await vi.advanceTimersByTimeAsync(NAMED_AUTOSAVE_DELAY_MS);
    expect(readMockFile(file2)).toBeUndefined();
    expect(bannerEl().dataset.visible).toBe("true");
    expect(bannerEl().dataset.kind).toBe("missing");
  });

  it("checks open tabs on window focus and scopes banner to the active tab", async () => {
    const fileA = "/tmp/kalamos-test/tab-a.md";
    const fileB = "/tmp/kalamos-test/tab-b.md";
    seedMockFile(fileA, "# A");
    seedMockFile(fileB, "# B");

    await app.openDocument(fileA);
    userType(app, " local");
    await app.openDocument(fileB);

    // Edit fileA externally without firing watcher, then focus window
    seedMockFile(fileA, "# A external");
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);

    // Active tab is B -> banner stays hidden; tab A has conflict status
    expect(bannerEl().dataset.visible).toBe("false");
    expect(app.getTabs()[0].externalStatus).toBe("conflict");
    expect(app.getTabs()[1].externalStatus).toBe("synced");

    // Switching to tab A displays its conflict banner
    app.activateTab(app.getTabs()[0].id);
    expect(bannerEl().dataset.visible).toBe("true");
    expect(bannerEl().dataset.kind).toBe("conflict");

    // Switching back to tab B hides it again
    app.activateTab(app.getTabs()[1].id);
    expect(bannerEl().dataset.visible).toBe("false");
  });

  it("localizes banner messages and buttons in English", async () => {
    initUiLocale("en");
    const file = "/tmp/kalamos-test/english.md";
    seedMockFile(file, "# Hello");
    await app.openDocument(file);

    userType(app, " world");
    seedMockFile(file, "# External");
    await triggerMockOpenFilesChanged([file]);

    expect(
      document.querySelector('[data-testid="external-change-message"]')
        ?.textContent,
    ).toContain("modified externally");
    expect(
      document.querySelector('[data-testid="external-change-keep-mine"]')
        ?.textContent,
    ).toBe("Keep My Version (Overwrite Disk)");
    expect(
      document.querySelector('[data-testid="external-change-load-disk"]')
        ?.textContent,
    ).toBe("Load Disk Version (Discard Mine)");
  });
});
