import { syntaxTree } from "@codemirror/language";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureFullSyntaxTree } from "../editor/test-utils";
import { DEFAULT_UI_LOCALE, initUiLocale } from "../i18n";
import {
  DEFAULT_SETTINGS,
  emitMockMenuAction,
  getSettings,
  resetMockState,
  seedMockFirstLaunch,
  seedMockSettings,
} from "../ipc";
import { createKalamosApp, type KalamosApp } from "../main";
import { getWelcomeContent, shouldShowWelcomeOnStartup } from "./welcome";

function setupDom(): void {
  document.body.innerHTML = `
    <div id="app">
      <aside id="sidebar" data-visible="false"></aside>
      <main id="editor-container"></main>
      <div id="status" data-testid="status" role="status"></div>
    </div>
  `;
}

describe("#147 welcome document & first-launch behavior", () => {
  let app: KalamosApp | null = null;

  beforeEach(() => {
    resetMockState();
    initUiLocale(DEFAULT_UI_LOCALE);
    setupDom();
  });

  afterEach(() => {
    app?.destroy();
    app = null;
    initUiLocale(DEFAULT_UI_LOCALE);
  });

  it("renders zh-TW and en welcome content with platform-aware shortcuts and no unresolved placeholders", () => {
    const zhMac = getWelcomeContent("zh-TW", "macos");
    const zhWin = getWelcomeContent("zh-TW", "windows");
    const enMac = getWelcomeContent("en", "macos");
    const enWin = getWelcomeContent("en", "windows");

    for (const content of [zhMac, zhWin, enMac, enWin]) {
      expect(content).not.toMatch(/\{\{.+?\}\}/);
    }
    expect(zhMac).toContain("歡迎使用 Kalamos");
    expect(zhMac).toContain("⌘P");
    expect(zhMac).toContain("⌘T");
    expect(zhMac).toContain("⌥⌘/");
    expect(zhWin).toContain("Ctrl+P");
    expect(zhWin).toContain("Ctrl+T");
    expect(zhWin).toContain("Ctrl+Alt+/");
    expect(enMac).toContain("Welcome to Kalamos");
    expect(enWin).toContain("Ctrl+P");
  });

  it("both zh-TW and en welcome documents parse with all required Markdown features", async () => {
    for (const locale of ["zh-TW", "en"] as const) {
      initUiLocale(locale);
      app?.destroy();
      setupDom();
      app = createKalamosApp(document);
      await app.init();
      app.openWelcomeDocument();

      const state = ensureFullSyntaxTree(app.editor.view.state);
      const nodeNames = new Set<string>();
      const codeLangs = new Set<string>();

      syntaxTree(state).iterate({
        enter(ref) {
          nodeNames.add(ref.name);
          if (ref.name === "CodeInfo") {
            codeLangs.add(
              state.sliceDoc(ref.from, ref.to).trim().toLowerCase(),
            );
          }
        },
      });

      expect(nodeNames.has("FrontMatter"), `${locale}: FrontMatter`).toBe(true);
      expect(nodeNames.has("ATXHeading1"), `${locale}: H1`).toBe(true);
      expect(nodeNames.has("ATXHeading2"), `${locale}: H2`).toBe(true);
      expect(nodeNames.has("StrongEmphasis"), `${locale}: bold`).toBe(true);
      expect(nodeNames.has("Emphasis"), `${locale}: italic`).toBe(true);
      expect(nodeNames.has("InlineCode"), `${locale}: inline code`).toBe(true);
      expect(nodeNames.has("Blockquote"), `${locale}: blockquote`).toBe(true);
      expect(nodeNames.has("Task"), `${locale}: task list`).toBe(true);
      expect(nodeNames.has("Table"), `${locale}: table`).toBe(true);
      expect(nodeNames.has("InlineMath"), `${locale}: inline math`).toBe(true);
      expect(nodeNames.has("BlockMath"), `${locale}: block math`).toBe(true);
      expect(nodeNames.has("FencedCode"), `${locale}: fenced code`).toBe(true);
      expect(codeLangs.has("ts"), `${locale}: ts code block`).toBe(true);
      expect(codeLangs.has("mermaid"), `${locale}: mermaid diagram`).toBe(true);
    }
  });

  it("opens welcome doc once on first launch (untitled, clean, not on disk), not on second launch, and reopens from menu", async () => {
    seedMockFirstLaunch();
    app = createKalamosApp(document);
    await app.init();

    // First launch opens the welcome document in an untitled, clean tab.
    expect(app.getCurrentPath()).toBeNull();
    expect(app.editor.isDirty()).toBe(false);
    expect(app.editor.getContent()).toContain("# 歡迎使用 Kalamos");
    expect(app.getTabs()).toHaveLength(1);
    expect(app.getTabs()[0].label).toBe("歡迎使用 Kalamos");
    expect((await getSettings()).welcomeShown).toBe(true);

    // Second launch does NOT reopen the welcome document.
    app.destroy();
    setupDom();
    app = createKalamosApp(document);
    await app.init();
    expect(app.editor.getContent()).toBe("");
    expect(app.getTabs()[0].label).toBe("未命名");

    // Menu 說明 > 歡迎文件 reopens it in an untitled tab.
    await emitMockMenuAction("help.welcome");
    expect(app.getCurrentPath()).toBeNull();
    expect(app.editor.isDirty()).toBe(false);
    expect(app.editor.getContent()).toContain("# 歡迎使用 Kalamos");
    expect(app.getTabs()).toHaveLength(1);
    expect(app.getTabs()[0].label).toBe("歡迎使用 Kalamos");

    // Triggering help.welcome again while unmodified focuses the same tab instead of duplicating.
    await emitMockMenuAction("help.welcome");
    expect(app.getTabs()).toHaveLength(1);
  });

  it("does not show welcome document for existing users with settings or recent files", async () => {
    // Legacy settings without welcomeShown field.
    seedMockSettings({ theme: "melan", lastFolder: null });
    app = createKalamosApp(document);
    await app.init();
    expect(app.editor.getContent()).toBe("");
    app.destroy();

    // Even if welcomeShown were false, having recent files or a lastFolder skips welcome.
    expect(
      shouldShowWelcomeOnStartup({
        settings: {
          ...DEFAULT_SETTINGS,
          welcomeShown: false,
          recentFiles: ["/tmp/kalamos-test/a.md"],
        },
        hasRecoveryEntries: false,
        openedFilesFromOs: false,
      }),
    ).toBe(false);
    expect(
      shouldShowWelcomeOnStartup({
        settings: {
          ...DEFAULT_SETTINGS,
          welcomeShown: false,
          lastFolder: "/tmp/kalamos-test",
        },
        hasRecoveryEntries: false,
        openedFilesFromOs: false,
      }),
    ).toBe(false);
    expect(
      shouldShowWelcomeOnStartup({
        settings: { ...DEFAULT_SETTINGS, welcomeShown: false },
        hasRecoveryEntries: true,
        openedFilesFromOs: false,
      }),
    ).toBe(false);
    expect(
      shouldShowWelcomeOnStartup({
        settings: { ...DEFAULT_SETTINGS, welcomeShown: false },
        hasRecoveryEntries: false,
        openedFilesFromOs: true,
      }),
    ).toBe(false);
  });
});
