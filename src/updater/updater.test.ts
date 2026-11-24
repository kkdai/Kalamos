import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_UI_LOCALE, initUiLocale } from "../i18n";
import {
  type AvailableUpdate,
  emitMockMenuAction,
  getMockRestartCount,
  getMockSaveChangesPrompts,
  getMockUpdateCheckCount,
  getSettings,
  listRecovery,
  resetMockState,
  seedMockSettings,
  setMockDialogHandlers,
  setMockRestartError,
  setMockUpdateHandler,
  type UpdateDownloadEvent,
  writeRecovery,
} from "../ipc";
import { createKalamosApp, type KalamosApp } from "../main";
import {
  createUpdater,
  formatBytes,
  isSignatureError,
  renderReleaseNotes,
} from "./updater";

function setupDom(): void {
  document.body.innerHTML = `
    <div id="app">
      <aside id="sidebar" data-visible="false"></aside>
      <main id="editor-container"></main>
      <div id="status" data-testid="status" role="status"></div>
    </div>
  `;
}

async function settle(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeFakeUpdate(
  overrides: Partial<AvailableUpdate> = {},
): AvailableUpdate & {
  downloadCalls: number;
  installCalls: number;
  closeCalls: number;
} {
  const state = {
    downloadCalls: 0,
    installCalls: 0,
    closeCalls: 0,
    version: "0.8.0",
    currentVersion: "0.7.0",
    body: "### Minor Changes\n\n- **自動更新**：支援應用程式內安全檢查與下載更新。\n- 修正 `settings.json` 相容性。",
    async download(onEvent?: (event: UpdateDownloadEvent) => void) {
      state.downloadCalls += 1;
      onEvent?.({ event: "Started", data: { contentLength: 2048 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 1024 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 1024 } });
      onEvent?.({ event: "Finished" });
    },
    async install() {
      state.installCalls += 1;
    },
    async close() {
      state.closeCalls += 1;
    },
    ...overrides,
  };
  return state;
}

describe("#91 updater helpers", () => {
  afterEach(() => {
    initUiLocale(DEFAULT_UI_LOCALE);
  });

  it("formats byte counts cleanly", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("detects signature verification errors", () => {
    expect(
      isSignatureError(new Error("minisign signature verification failed")),
    ).toBe(true);
    expect(isSignatureError(new Error("Invalid pubkey"))).toBe(true);
    expect(isSignatureError(new Error("Signed version mismatch"))).toBe(true);
    expect(isSignatureError(new Error("network timeout"))).toBe(false);
  });

  it("renders release notes via DOM nodes without interpreting raw HTML or scripts", () => {
    const xssNotes = [
      "### Highlights",
      "",
      "- **Safe** `code` and <img src=x onerror=alert(1)>",
      "- <script>window.__xss = true</script>",
      "",
      "Plain paragraph with <a href='javascript:alert(1)'>link</a>.",
    ].join("\n");

    const node = renderReleaseNotes(xssNotes, document);
    expect(node.querySelector("script")).toBeNull();
    expect(node.querySelector("img")).toBeNull();
    expect(node.querySelector("a")).toBeNull();
    expect(node.querySelector("h4")?.textContent).toBe("Highlights");
    expect(node.querySelector("strong")?.textContent).toBe("Safe");
    expect(node.querySelector("code")?.textContent).toBe("code");
    expect(node.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(node.textContent).toContain("<script>window.__xss = true</script>");
    expect(node.textContent).toContain(
      "<a href='javascript:alert(1)'>link</a>",
    );
  });
});

describe("#91 updater dialog workflow", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    initUiLocale(DEFAULT_UI_LOCALE);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("stays silent on background check when up to date or on network error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const upToDateUpdater = createUpdater({
      checkForUpdate: async () => null,
      prepareForRestart: async () => true,
      restartApp: async () => {},
    });
    await upToDateUpdater.checkForUpdates({ manual: false });
    expect(upToDateUpdater.isOpen()).toBe(false);
    expect(document.querySelector('[data-testid="update-dialog"]')).toBeNull();
    upToDateUpdater.destroy();

    const failingUpdater = createUpdater({
      checkForUpdate: async () => {
        throw new Error("network unreachable");
      },
      prepareForRestart: async () => true,
      restartApp: async () => {},
    });
    await failingUpdater.checkForUpdates({ manual: false });
    expect(failingUpdater.isOpen()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    failingUpdater.destroy();
  });

  it("shows explicit up-to-date message on manual check", async () => {
    const updater = createUpdater({
      checkForUpdate: async () => null,
      prepareForRestart: async () => true,
      restartApp: async () => {},
    });
    await updater.checkForUpdates({ manual: true });
    expect(updater.isOpen()).toBe(true);
    expect(updater.getState()).toBe("upToDate");
    expect(
      document.querySelector('[data-testid="update-status-message"]')
        ?.textContent,
    ).toBe("目前使用的已是最新版本。");

    document
      .querySelector<HTMLButtonElement>('[data-testid="update-close"]')!
      .click();
    expect(updater.isOpen()).toBe(false);
    updater.destroy();
  });

  it("asks before downloading, closes cleanly on Later, and never installs silently", async () => {
    const fake = makeFakeUpdate();
    const prepareForRestart = vi.fn(async () => true);
    const restartApp = vi.fn(async () => {});
    const updater = createUpdater({
      checkForUpdate: async () => fake,
      prepareForRestart,
      restartApp,
    });

    await updater.checkForUpdates({ manual: false });
    expect(updater.isOpen()).toBe(true);
    expect(updater.getState()).toBe("available");
    expect(fake.downloadCalls).toBe(0);
    expect(fake.installCalls).toBe(0);
    expect(
      document.querySelector('[data-testid="update-release-notes"]')
        ?.textContent,
    ).toContain("自動更新");

    document
      .querySelector<HTMLButtonElement>('[data-testid="update-later"]')!
      .click();
    expect(updater.isOpen()).toBe(false);
    expect(fake.downloadCalls).toBe(0);
    expect(fake.installCalls).toBe(0);
    expect(fake.closeCalls).toBe(1);
    expect(prepareForRestart).not.toHaveBeenCalled();
    expect(restartApp).not.toHaveBeenCalled();
    updater.destroy();
  });

  it("downloads with progress, checks unsaved documents, then installs and restarts", async () => {
    const order: string[] = [];
    let emitProgress: ((event: UpdateDownloadEvent) => void) | undefined;
    let finishDownload!: () => void;
    const fake = makeFakeUpdate({
      download: (onEvent) => {
        order.push("download:start");
        emitProgress = onEvent;
        onEvent?.({ event: "Started", data: { contentLength: 4096 } });
        onEvent?.({ event: "Progress", data: { chunkLength: 2048 } });
        return new Promise<void>((resolve) => {
          finishDownload = () => {
            onEvent?.({ event: "Progress", data: { chunkLength: 2048 } });
            onEvent?.({ event: "Finished" });
            order.push("download:end");
            resolve();
          };
        });
      },
      install: async () => {
        order.push("install");
      },
    });
    const updater = createUpdater({
      checkForUpdate: async () => fake,
      prepareForRestart: async () => {
        order.push("prepareForRestart");
        return true;
      },
      restartApp: async () => {
        order.push("restartApp");
      },
    });

    await updater.checkForUpdates({ manual: true });
    document
      .querySelector<HTMLButtonElement>('[data-testid="update-now"]')!
      .click();
    await settle(2);

    expect(updater.getState()).toBe("downloading");
    expect(emitProgress).toBeDefined();
    const bar = document.querySelector<HTMLProgressElement>(
      '[data-testid="update-progress-bar"]',
    )!;
    expect(bar.value).toBe(50);
    expect(
      document.querySelector('[data-testid="update-progress-text"]')
        ?.textContent,
    ).toContain("50%");

    // Escape cannot dismiss while downloading.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(updater.isOpen()).toBe(true);

    finishDownload();
    await settle(4);

    expect(order).toEqual([
      "download:start",
      "download:end",
      "prepareForRestart",
      "install",
      "restartApp",
    ]);
    updater.destroy();
  });

  it("refuses installation and shows a clear error when signature verification fails", async () => {
    const install = vi.fn(async () => {});
    const restartApp = vi.fn(async () => {});
    const fake = makeFakeUpdate({
      download: async () => {
        throw new Error("signature verification failed: invalid minisign");
      },
      install,
    });
    const updater = createUpdater({
      checkForUpdate: async () => fake,
      prepareForRestart: async () => true,
      restartApp,
    });

    await updater.checkForUpdates({ manual: true });
    document
      .querySelector<HTMLButtonElement>('[data-testid="update-now"]')!
      .click();
    await settle();

    expect(updater.getState()).toBe("error");
    expect(install).not.toHaveBeenCalled();
    expect(restartApp).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="update-error-message"]')
        ?.textContent,
    ).toContain("簽章驗證失敗");
    updater.destroy();
  });

  it("cancels installation when the user cancels the unsaved-changes prompt", async () => {
    const install = vi.fn(async () => {});
    const restartApp = vi.fn(async () => {});
    const fake = makeFakeUpdate({ install });
    const updater = createUpdater({
      checkForUpdate: async () => fake,
      prepareForRestart: async () => false,
      restartApp,
    });

    await updater.checkForUpdates({ manual: true });
    document
      .querySelector<HTMLButtonElement>('[data-testid="update-now"]')!
      .click();
    await settle();

    expect(install).not.toHaveBeenCalled();
    expect(restartApp).not.toHaveBeenCalled();
    expect(updater.isOpen()).toBe(false);
    expect(fake.closeCalls).toBe(1);
    updater.destroy();
  });

  it("shows a clear error message on manual check network failure", async () => {
    const updater = createUpdater({
      checkForUpdate: async () => {
        throw new Error("connection timed out");
      },
      prepareForRestart: async () => true,
      restartApp: async () => {},
    });

    await updater.checkForUpdates({ manual: true });
    expect(updater.getState()).toBe("error");
    expect(
      document.querySelector('[data-testid="update-error-message"]')
        ?.textContent,
    ).toContain("connection timed out");
    expect(
      document.querySelector('[data-testid="update-retry"]'),
    ).not.toBeNull();
    updater.destroy();
  });
});

describe("#91 app integration (startup check, menu, preferences, unsaved tabs)", () => {
  let app: KalamosApp | null = null;

  beforeEach(() => {
    resetMockState();
    initUiLocale(DEFAULT_UI_LOCALE);
    setupDom();
  });

  afterEach(() => {
    app?.destroy();
    app = null;
    document.documentElement.removeAttribute("style");
  });

  it("runs a delayed background check on startup when autoCheckUpdates is enabled", async () => {
    const fake = makeFakeUpdate();
    setMockUpdateHandler(async () => fake);

    app = createKalamosApp(document, { startupUpdateCheckDelayMs: 20 });
    await app.init();
    expect(getMockUpdateCheckCount()).toBe(0);

    await new Promise((r) => setTimeout(r, 60));
    expect(getMockUpdateCheckCount()).toBe(1);
    expect(app.updater.isOpen()).toBe(true);
    expect(app.updater.getState()).toBe("available");
  });

  it("skips startup background check when autoCheckUpdates is disabled in settings", async () => {
    seedMockSettings({
      theme: "system",
      lastFolder: null,
      sidebarVisible: false,
      sidebarTab: "tree",
      sourceMode: false,
      autoCheckUpdates: false,
    });
    const fake = makeFakeUpdate();
    setMockUpdateHandler(async () => fake);

    app = createKalamosApp(document, { startupUpdateCheckDelayMs: 15 });
    await app.init();
    await new Promise((r) => setTimeout(r, 50));

    expect(getMockUpdateCheckCount()).toBe(0);
    expect(app.updater.isOpen()).toBe(false);

    // Manual menu check still works even when autoCheckUpdates is off.
    await emitMockMenuAction("app.checkForUpdates");
    await settle();
    expect(getMockUpdateCheckCount()).toBe(1);
    expect(app.updater.isOpen()).toBe(true);
  });

  it("persists the autoCheckUpdates toggle in Preferences > General", async () => {
    app = createKalamosApp(document, { startupUpdateCheckDelayMs: 60_000 });
    await app.init();
    await app.preferences.open("general");

    const box = document.querySelector<HTMLInputElement>(
      '[data-testid="pref-auto-check-updates"]',
    )!;
    expect(box.checked).toBe(true);

    box.checked = false;
    box.dispatchEvent(new Event("change"));
    await settle();
    expect((await getSettings()).autoCheckUpdates).toBe(false);
  });

  it("prompts for unsaved tabs before installing and restores recovery if restart fails", async () => {
    const fake = makeFakeUpdate();
    setMockUpdateHandler(async () => fake);
    app = createKalamosApp(document, { startupUpdateCheckDelayMs: 60_000 });
    await app.init();

    // Create two unsaved untitled tabs
    app.editor.setContent("# Draft 1", { dirty: true });
    app.newTab();
    app.editor.setContent("# Draft 2", { dirty: true });
    await writeRecovery(app.getDocId(), "# Draft 2", null);

    // First attempt: user cancels the unsaved prompt -> no install or restart
    setMockDialogHandlers({ saveChanges: () => "cancel" });
    await emitMockMenuAction("app.checkForUpdates");
    await settle();
    document
      .querySelector<HTMLButtonElement>('[data-testid="update-now"]')!
      .click();
    await settle();

    expect(getMockSaveChangesPrompts()).toHaveLength(1);
    expect(fake.installCalls).toBe(0);
    expect(getMockRestartCount()).toBe(0);

    // Second attempt: user chooses Don't Save, but restart fails -> recovery preserved
    setMockDialogHandlers({ saveChanges: () => "discard" });
    setMockRestartError(new Error("restart failed"));
    await emitMockMenuAction("app.checkForUpdates");
    await settle();
    document
      .querySelector<HTMLButtonElement>('[data-testid="update-now"]')!
      .click();
    await settle();

    expect(fake.installCalls).toBe(1);
    expect(app.updater.getState()).toBe("error");
    const recoveries = await listRecovery();
    expect(recoveries.length).toBeGreaterThanOrEqual(2);
  });
});
