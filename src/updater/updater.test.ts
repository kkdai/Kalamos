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
  classifyUpdaterError,
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
    expect(
      isSignatureError(
        "The signature was created with a different key than the one provided",
      ),
    ).toBe(true);
    expect(
      isSignatureError(
        new Error(
          "The update was signed for version 0.7.0 but the update endpoint announced version 0.8.1.",
        ),
      ),
    ).toBe(true);
    expect(isSignatureError(new Error("network timeout"))).toBe(false);
  });

  it("classifies updater errors into localized user-friendly categories and preserves technical detail", () => {
    const fetchCases = [
      "Could not fetch a valid release JSON from the remote",
      new Error("Updater does not have any endpoints set."),
      new Error(
        "error sending request for url (https://github.com/kkdai/Kalamos/releases/latest/download/latest.json): dns error",
      ),
      new Error("connection timed out"),
      new Error(
        "the platform `darwin-aarch64` was not found in the response `platforms` object",
      ),
      new Error("expected value at line 1 column 1"),
      new Error("HTTP status server error (502 Bad Gateway)"),
    ];
    for (const err of fetchCases) {
      const result = classifyUpdaterError(err, "check");
      expect(result.kind).toBe("fetch");
      expect(result.message).toBe(
        "目前無法取得更新資訊，請檢查網路連線後再試一次。",
      );
      expect(result.detail).not.toBe("");
    }

    const sigErr = classifyUpdaterError(
      new Error("The signature verification failed"),
      "download",
    );
    expect(sigErr.kind).toBe("signature");
    expect(sigErr.message).toBe(
      "更新檔的簽章驗證失敗，已取消安裝。請到 GitHub Releases 手動下載。",
    );
    expect(sigErr.detail).toBe("The signature verification failed");

    const dlErr = classifyUpdaterError(
      new Error("connection reset by peer"),
      "download",
    );
    expect(dlErr.kind).toBe("download");
    expect(dlErr.message).toBe("下載更新檔失敗，請檢查網路連線後再試一次。");
    expect(dlErr.detail).toBe("connection reset by peer");

    const installErr = classifyUpdaterError(
      new Error("temp directory is not on the same mount point as the app"),
      "install",
    );
    expect(installErr.kind).toBe("install");
    expect(installErr.message).toBe(
      "安裝更新失敗，請稍後再試，或到 GitHub Releases 手動下載。",
    );
    expect(installErr.detail).toBe(
      "temp directory is not on the same mount point as the app",
    );

    const restartErr = classifyUpdaterError(
      new Error("spawn failed"),
      "restart",
    );
    expect(restartErr.kind).toBe("restart");
    expect(restartErr.message).toBe(
      "更新已安裝，但無法自動重新啟動 Kalamos，請手動重新開啟。",
    );
    expect(restartErr.detail).toBe("spawn failed");

    const unknownErr = classifyUpdaterError(
      new Error("unexpected internal panic"),
      "check",
    );
    expect(unknownErr.kind).toBe("unknown");
    expect(unknownErr.message).toBe(
      "更新時發生未預期的錯誤，請稍後再試，或到 GitHub Releases 手動下載。",
    );
    expect(unknownErr.detail).toBe("unexpected internal panic");

    // Stage-less classification covers all categories too.
    expect(classifyUpdaterError("Download failed: unexpected EOF").kind).toBe(
      "download",
    );
    expect(classifyUpdaterError("Permission denied (os error 13)").kind).toBe(
      "install",
    );
    expect(classifyUpdaterError(null).detail).toBe("");

    // English locale messages.
    initUiLocale("en");
    expect(
      classifyUpdaterError(
        "Could not fetch a valid release JSON from the remote",
        "check",
      ).message,
    ).toBe(
      "Could not fetch update information right now. Please check your internet connection and try again.",
    );
    expect(
      classifyUpdaterError("Invalid encoding in minisign data", "download")
        .message,
    ).toBe(
      "Update signature verification failed, so installation was cancelled. Please download it manually from GitHub Releases.",
    );
    expect(classifyUpdaterError("unexpected", "check").message).toBe(
      "An unexpected error occurred while updating. Please try again later, or download it manually from GitHub Releases.",
    );
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
        throw new Error("Could not fetch a valid release JSON from the remote");
      },
      prepareForRestart: async () => true,
      restartApp: async () => {},
    });
    await failingUpdater.checkForUpdates({ manual: false });
    expect(failingUpdater.isOpen()).toBe(false);
    expect(document.querySelector('[data-testid="update-dialog"]')).toBeNull();
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
    const errorMsg = document.querySelector(
      '[data-testid="update-error-message"]',
    )?.textContent;
    expect(errorMsg).toBe(
      "更新檔的簽章驗證失敗，已取消安裝。請到 GitHub Releases 手動下載。",
    );
    expect(errorMsg).not.toContain("minisign");
    expect(
      document.querySelector('[data-testid="update-error-detail"]')
        ?.textContent,
    ).toBe("signature verification failed: invalid minisign");
    expect(document.querySelector('[data-testid="update-retry"]')).toBeNull();
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

  it("shows localized fetch error with collapsed technical details on manual check failure", async () => {
    const rawDetail =
      "Could not fetch a valid release JSON from the remote <script>alert(1)</script>";
    const updater = createUpdater({
      checkForUpdate: async () => {
        throw new Error(rawDetail);
      },
      prepareForRestart: async () => true,
      restartApp: async () => {},
    });

    await updater.checkForUpdates({ manual: true });
    expect(updater.getState()).toBe("error");
    expect(
      document.querySelector('[data-testid="update-error-message"]')
        ?.textContent,
    ).toBe("目前無法取得更新資訊，請檢查網路連線後再試一次。");

    const details = document.querySelector<HTMLDetailsElement>(
      '[data-testid="update-error-details"]',
    )!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(
      document.querySelector('[data-testid="update-error-details-summary"]')
        ?.textContent,
    ).toBe("詳細資訊");
    expect(
      document.querySelector('[data-testid="update-error-detail"]')
        ?.textContent,
    ).toBe(rawDetail);
    expect(details.querySelector("script")).toBeNull();
    expect(
      document.querySelector('[data-testid="update-retry"]'),
    ).not.toBeNull();
    updater.destroy();
  });

  it("shows localized download, install, and unknown errors with technical details", async () => {
    // Download failure
    const dlFake = makeFakeUpdate({
      download: async () => {
        throw new Error("HTTP status server error (503 Service Unavailable)");
      },
    });
    const dlUpdater = createUpdater({
      checkForUpdate: async () => dlFake,
      prepareForRestart: async () => true,
      restartApp: async () => {},
    });
    await dlUpdater.checkForUpdates({ manual: true });
    document
      .querySelector<HTMLButtonElement>('[data-testid="update-now"]')!
      .click();
    await settle();
    expect(dlUpdater.getState()).toBe("error");
    expect(
      document.querySelector('[data-testid="update-error-message"]')
        ?.textContent,
    ).toBe("下載更新檔失敗，請檢查網路連線後再試一次。");
    expect(
      document.querySelector('[data-testid="update-error-detail"]')
        ?.textContent,
    ).toBe("HTTP status server error (503 Service Unavailable)");
    expect(
      document.querySelector('[data-testid="update-retry"]'),
    ).not.toBeNull();
    dlUpdater.destroy();

    // Install failure
    const installFake = makeFakeUpdate({
      install: async () => {
        throw new Error("Permission denied (os error 13)");
      },
    });
    const installUpdater = createUpdater({
      checkForUpdate: async () => installFake,
      prepareForRestart: async () => true,
      restartApp: async () => {},
    });
    await installUpdater.checkForUpdates({ manual: true });
    document
      .querySelector<HTMLButtonElement>('[data-testid="update-now"]')!
      .click();
    await settle();
    expect(installUpdater.getState()).toBe("error");
    expect(
      document.querySelector('[data-testid="update-error-message"]')
        ?.textContent,
    ).toBe("安裝更新失敗，請稍後再試，或到 GitHub Releases 手動下載。");
    expect(
      document.querySelector('[data-testid="update-error-detail"]')
        ?.textContent,
    ).toBe("Permission denied (os error 13)");
    expect(document.querySelector('[data-testid="update-retry"]')).toBeNull();
    installUpdater.destroy();

    // Unknown error with empty detail omits the details block
    const unknownUpdater = createUpdater({
      checkForUpdate: async () => {
        throw new Error("");
      },
      prepareForRestart: async () => true,
      restartApp: async () => {},
    });
    await unknownUpdater.checkForUpdates({ manual: true });
    expect(unknownUpdater.getState()).toBe("error");
    expect(
      document.querySelector('[data-testid="update-error-message"]')
        ?.textContent,
    ).toBe(
      "更新時發生未預期的錯誤，請稍後再試，或到 GitHub Releases 手動下載。",
    );
    expect(
      document.querySelector('[data-testid="update-error-details"]'),
    ).toBeNull();
    unknownUpdater.destroy();
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
