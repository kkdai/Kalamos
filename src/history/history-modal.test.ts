import { undo } from "@codemirror/commands";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_UI_LOCALE, initUiLocale, t } from "../i18n";
import {
  clearAllHistory,
  getHistoryStats,
  type HistoryVersion,
  listHistory,
  readMockFile,
  resetMockState,
  saveFile,
  seedMockFile,
  seedMockHistoryVersion,
  setMockHistoryThrottleMs,
  triggerMockOpenFilesChanged,
} from "../ipc";
import {
  createKalamosApp,
  type KalamosApp,
  NAMED_AUTOSAVE_DELAY_MS,
} from "../main";
import { createHistoryModal, type HistoryModalHost } from "./history-modal";

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

describe("#148 history modal UI", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    initUiLocale(DEFAULT_UI_LOCALE);
    vi.restoreAllMocks();
  });

  it("shows untitled notice and disables restore when document has no path", async () => {
    const host: HistoryModalHost = {
      getCurrentDocument: () => ({
        path: null,
        label: "未命名",
        content: "# Draft",
      }),
      isHistoryEnabled: () => true,
      listVersions: vi.fn(async () => []),
      readVersion: vi.fn(async () => ""),
      restoreContent: vi.fn(),
    };
    const modal = createHistoryModal(host, document);
    try {
      await modal.open();
      expect(modal.isOpen()).toBe(true);
      expect(
        document.querySelector('[data-testid="history-preview-message"]')
          ?.textContent,
      ).toBe(t("history.untitledNotice"));
      const restoreBtn = document.querySelector<HTMLButtonElement>(
        '[data-testid="history-restore"]',
      )!;
      expect(restoreBtn.disabled).toBe(true);
      expect(host.listVersions).not.toHaveBeenCalled();
    } finally {
      modal.destroy();
    }
  });

  it("shows disabled hint when history is empty and turned off", async () => {
    const host: HistoryModalHost = {
      getCurrentDocument: () => ({
        path: "/tmp/kalamos-test/doc.md",
        label: "doc.md",
        content: "# Doc",
      }),
      isHistoryEnabled: () => false,
      listVersions: async () => [],
      readVersion: async () => "",
      restoreContent: vi.fn(),
    };
    const modal = createHistoryModal(host, document);
    try {
      await modal.open();
      expect(
        document.querySelector('[data-testid="history-preview-message"]')
          ?.textContent,
      ).toBe(t("history.emptyDisabled"));
    } finally {
      modal.destroy();
    }
  });

  it("lists versions, switches selection with clicks and arrow keys, and restores selected content", async () => {
    const versions: HistoryVersion[] = [
      { id: "2000", savedAtMs: 1_764_300_000_000, size: 18 },
      { id: "1000", savedAtMs: 1_764_299_000_000, size: 12 },
    ];
    const contents: Record<string, string> = {
      "2000": "# Title\n\nSecond draft",
      "1000": "# Title\n\nFirst draft",
    };
    const restoreContent = vi.fn();
    const host: HistoryModalHost = {
      getCurrentDocument: () => ({
        path: "/tmp/kalamos-test/article.md",
        label: "article.md",
        content: "# Title\n\nCurrent draft\nExtra line",
      }),
      isHistoryEnabled: () => true,
      listVersions: async () => versions,
      readVersion: async (_path, id) => contents[id],
      restoreContent,
    };

    const modal = createHistoryModal(host, document);
    try {
      await modal.open();
      const items = document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="history-item"]',
      );
      expect(items.length).toBe(2);
      expect(items[0].getAttribute("aria-selected")).toBe("true");
      expect(
        document.querySelector('[data-testid="history-diff-added"]')
          ?.textContent,
      ).toBe("+2");
      expect(
        document.querySelector('[data-testid="history-diff-removed"]')
          ?.textContent,
      ).toBe("−1");
      expect(
        document.querySelector('[data-testid="history-diff"]')?.textContent,
      ).toContain("Second draft");

      // Navigate down to older version using ArrowDown
      items[0].dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
      await flushMicrotasks();
      expect(items[1].getAttribute("aria-selected")).toBe("true");
      expect(
        document.querySelector('[data-testid="history-diff"]')?.textContent,
      ).toContain("First draft");

      // Restore selected version
      const restoreBtn = document.querySelector<HTMLButtonElement>(
        '[data-testid="history-restore"]',
      )!;
      expect(restoreBtn.disabled).toBe(false);
      restoreBtn.click();

      expect(restoreContent).toHaveBeenCalledWith("# Title\n\nFirst draft");
      expect(modal.isOpen()).toBe(false);
    } finally {
      modal.destroy();
    }
  });

  it("ignores stale out-of-order readVersion responses", async () => {
    const versions: HistoryVersion[] = [
      { id: "2000", savedAtMs: 1_764_300_000_000, size: 10 },
      { id: "1000", savedAtMs: 1_764_299_000_000, size: 10 },
    ];
    let resolveFirst!: (val: string) => void;
    let resolveSecond!: (val: string) => void;
    const host: HistoryModalHost = {
      getCurrentDocument: () => ({
        path: "/tmp/kalamos-test/race.md",
        label: "race.md",
        content: "current",
      }),
      isHistoryEnabled: () => true,
      listVersions: async () => versions,
      readVersion: (_path, id) =>
        new Promise<string>((resolve) => {
          if (id === "2000") resolveFirst = resolve;
          else resolveSecond = resolve;
        }),
      restoreContent: vi.fn(),
    };

    const modal = createHistoryModal(host, document);
    try {
      const openPromise = modal.open();
      await flushMicrotasks();
      const items = document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="history-item"]',
      );
      // Click the second version before the first one finishes loading
      items[1].click();
      await flushMicrotasks();
      resolveSecond("older-winner");
      await flushMicrotasks();
      resolveFirst("newer-stale");
      await openPromise;
      await flushMicrotasks();

      expect(
        document.querySelector('[data-testid="history-diff"]')?.textContent,
      ).toContain("older-winner");
      expect(
        document.querySelector('[data-testid="history-diff"]')?.textContent,
      ).not.toContain("newer-stale");
    } finally {
      modal.destroy();
    }
  });
});

describe("#148 app integration: save, restore without disk write, and undo", () => {
  let app: KalamosApp | null = null;

  beforeEach(async () => {
    resetMockState();
    document.body.innerHTML = `
      <div id="app">
        <aside id="sidebar" data-visible="false"></aside>
        <main id="editor-container"></main>
        <div id="status" data-testid="status" role="status"></div>
      </div>
    `;
    app = createKalamosApp(document);
    await app.init();
  });

  afterEach(() => {
    app?.destroy();
    app = null;
    document.body.innerHTML = "";
  });

  it("snapshots on save, throttles autosave, restores as undoable edit without writing disk", async () => {
    const filePath = "/tmp/kalamos-test/story.md";
    seedMockFile(filePath, "# Chapter 1\n\nOriginal paragraph.");
    setMockHistoryThrottleMs(60_000);

    // Save v2 manually -> snapshots v1
    await saveFile(filePath, "# Chapter 1\n\nSecond paragraph.", {
      isAutosave: false,
    });
    // Immediate autosave v3 -> throttled (no new snapshot)
    await saveFile(filePath, "# Chapter 1\n\nThird paragraph.", {
      isAutosave: true,
    });
    // Manual save v4 -> bypasses throttle, snapshots v3
    await saveFile(filePath, "# Chapter 1\n\nFourth paragraph.", {
      isAutosave: false,
    });
    // Identical manual save -> no duplicate snapshot
    await saveFile(filePath, "# Chapter 1\n\nFourth paragraph.", {
      isAutosave: false,
    });

    const versions = await listHistory(filePath);
    expect(versions.length).toBe(2);

    await app!.openPath(filePath, "tab");
    expect(app!.editor.getContent()).toBe("# Chapter 1\n\nFourth paragraph.");
    expect(app!.editor.isDirty()).toBe(false);

    // Open history modal and restore oldest version (v1)
    await app!.openVersionHistory();
    const items = document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="history-item"]',
    );
    expect(items.length).toBe(2);
    items[1].click();
    await flushMicrotasks();

    const restoreBtn = document.querySelector<HTMLButtonElement>(
      '[data-testid="history-restore"]',
    )!;
    restoreBtn.click();

    // Content loaded in editor, marked dirty, disk NOT overwritten!
    expect(app!.editor.getContent()).toBe("# Chapter 1\n\nOriginal paragraph.");
    expect(app!.editor.isDirty()).toBe(true);
    expect(readMockFile(filePath)).toBe("# Chapter 1\n\nFourth paragraph.");

    // Single undo reverts back to Fourth paragraph and restores clean state
    undo(app!.editor.view);
    expect(app!.editor.getContent()).toBe("# Chapter 1\n\nFourth paragraph.");
    expect(app!.editor.isDirty()).toBe(false);
    expect(readMockFile(filePath)).toBe("# Chapter 1\n\nFourth paragraph.");

    // Clear all history resets stats to zero
    seedMockHistoryVersion("/tmp/kalamos-test/other.md", "other");
    expect((await getHistoryStats()).totalVersions).toBeGreaterThanOrEqual(3);
    await clearAllHistory();
    expect(await getHistoryStats()).toEqual({
      totalBytes: 0,
      totalVersions: 0,
      fileCount: 0,
    });
  });

  it("interacts cleanly with #145 external-change detection on restore, focus check, and save conflict", async () => {
    vi.useFakeTimers();
    try {
      const filePath = "/tmp/kalamos-test/ext-history.md";
      seedMockFile(filePath, "# V1");
      await saveFile(filePath, "# V2", { isAutosave: false });
      await saveFile(filePath, "# V3", { isAutosave: false });

      await app!.openPath(filePath, "tab");
      expect(app!.getTabs()[0].externalStatus).toBe("synced");

      // Restore V1 from history modal
      await app!.openVersionHistory();
      const items = document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="history-item"]',
      );
      expect(items.length).toBe(2);
      items[1].click();
      await flushMicrotasks();
      document
        .querySelector<HTMLButtonElement>('[data-testid="history-restore"]')!
        .click();

      expect(app!.editor.getContent()).toBe("# V1");
      expect(app!.editor.isDirty()).toBe(true);
      expect(readMockFile(filePath)).toBe("# V3");

      // Waiting past autosave delay must NOT auto-write the restored content to disk
      await vi.advanceTimersByTimeAsync(NAMED_AUTOSAVE_DELAY_MS + 500);
      expect(readMockFile(filePath)).toBe("# V3");

      // Disk check / file-watcher notification must NOT misclassify restored content as external change
      await triggerMockOpenFilesChanged([filePath]);
      expect(app!.getTabs()[0].externalStatus).toBe("synced");
      expect(app!.editor.getContent()).toBe("# V1");
      expect(
        document.querySelector<HTMLElement>(
          '[data-testid="external-change-banner"]',
        )?.dataset.visible,
      ).toBe("false");

      // If disk genuinely changes externally while restored content is unsaved,
      // saveDocument detects conflict, does NOT overwrite disk, and does NOT snapshot history.
      const countBeforeConflict = (await listHistory(filePath)).length;
      seedMockFile(filePath, "# External Edit");
      const saved = await app!.saveDocument();
      expect(saved).toBe(false);
      expect(app!.getTabs()[0].externalStatus).toBe("conflict");
      expect(readMockFile(filePath)).toBe("# External Edit");
      expect((await listHistory(filePath)).length).toBe(countBeforeConflict);

      // Clicking "Keep My Version" force-saves V1 and snapshots "# External Edit" into history.
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="external-change-keep-mine"]',
        )!
        .click();
      await flushMicrotasks();
      expect(app!.getTabs()[0].externalStatus).toBe("synced");
      expect(readMockFile(filePath)).toBe("# V1");
      expect((await listHistory(filePath)).length).toBe(
        countBeforeConflict + 1,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
