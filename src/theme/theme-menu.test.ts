import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_UI_LOCALE, initUiLocale } from "../i18n";
import { getSettings, resetMockState, seedMockCustomTheme } from "../ipc";
import { createKalamosApp, type KalamosApp } from "../main";
import {
  applySystemDarkTheme,
  CUSTOM_THEME_STYLE_ID,
  detectBaseThemeForCustomCss,
} from "./theme-menu";

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

describe("Theme Menu & Custom CSS (TH-01)", () => {
  let app: KalamosApp | null = null;

  beforeEach(() => {
    resetMockState();
    initUiLocale(DEFAULT_UI_LOCALE);
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-custom-theme");
    document.documentElement.removeAttribute("data-system-dark-theme");
    document.getElementById(CUSTOM_THEME_STYLE_ID)?.remove();
    setupDom();
  });

  afterEach(() => {
    app?.destroy();
    app = null;
    initUiLocale(DEFAULT_UI_LOCALE);
  });

  it("lists system, Papyros, Melan, Nyx, and custom themes in theme-menu and applies selected theme immediately", async () => {
    seedMockCustomTheme(
      "sepia",
      ":root[data-custom-theme] { color-scheme: light; --k-bg: #f4ecd8; --k-font-size: 19px; }",
    );

    app = createKalamosApp(document);
    await app.init();

    const menuBtn = document.querySelector<HTMLButtonElement>(
      '[data-testid="theme-menu-button"]',
    )!;
    const menuEl = document.querySelector<HTMLElement>(
      '[data-testid="theme-menu"]',
    )!;
    expect(menuBtn).not.toBeNull();
    expect(menuEl).not.toBeNull();
    expect(menuEl.dataset.visible).toBe("false");

    // Click theme button to open menu
    menuBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(menuEl.dataset.visible).toBe("true");

    const options = Array.from(
      menuEl.querySelectorAll<HTMLButtonElement>(
        '[data-testid="theme-option"]',
      ),
    );
    // Menu option buttons must not carry `data-theme`, which would trigger
    // `[data-theme="papyros"|"melan"]` CSS variable overrides on the button itself.
    expect(options.every((o) => !o.hasAttribute("data-theme"))).toBe(true);
    expect(
      options.map(
        (o) => `${o.dataset.themeId}:${o.textContent?.replace("✓", "").trim()}`,
      ),
    ).toEqual([
      "system:跟隨系統",
      "papyros:Papyros（莎草紙）",
      "melan:Melan（墨）",
      "nyx:Nyx（夜）",
      "custom:night:night",
      "custom:sepia:sepia",
    ]);

    // Select Melan
    const melanOpt = menuEl.querySelector<HTMLButtonElement>(
      '[data-theme-id="melan"]',
    )!;
    melanOpt.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(document.documentElement.getAttribute("data-theme")).toBe("melan");
    expect(document.getElementById(CUSTOM_THEME_STYLE_ID)).toBeNull();
    expect((await getSettings()).theme).toBe("melan");

    // Select Nyx
    const nyxOpt = menuEl.querySelector<HTMLButtonElement>(
      '[data-theme-id="nyx"]',
    )!;
    nyxOpt.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(document.documentElement.getAttribute("data-theme")).toBe("nyx");
    expect(document.getElementById(CUSTOM_THEME_STYLE_ID)).toBeNull();
    expect((await getSettings()).theme).toBe("nyx");

    // Select custom:sepia -> injects <style id="k-custom-theme"> and sets base theme
    const sepiaOpt = menuEl.querySelector<HTMLButtonElement>(
      '[data-theme-id="custom:sepia"]',
    )!;
    sepiaOpt.click();
    await new Promise((r) => setTimeout(r, 0));

    const customStyle = document.getElementById(
      CUSTOM_THEME_STYLE_ID,
    ) as HTMLStyleElement | null;
    expect(customStyle).not.toBeNull();
    expect(customStyle!.textContent).toContain(":root[data-custom-theme]");
    expect(customStyle!.textContent).toContain("--k-bg: #f4ecd8;");
    expect(document.documentElement.getAttribute("data-theme")).toBe("papyros");
    expect(document.documentElement.getAttribute("data-custom-theme")).toBe(
      "custom:sepia",
    );
    expect((await getSettings()).theme).toBe("custom:sepia");

    // Select system -> removes custom style and data-theme
    const systemOpt = menuEl.querySelector<HTMLButtonElement>(
      '[data-theme-id="system"]',
    )!;
    systemOpt.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(document.getElementById(CUSTOM_THEME_STYLE_ID)).toBeNull();
    expect((await getSettings()).theme).toBe("system");
  });

  it("keeps <style id='k-custom-theme'> as the last child of <head> even after dynamic <style> insertion", async () => {
    seedMockCustomTheme(
      "sage",
      ":root[data-custom-theme] { color-scheme: light; --k-bg: #e8f0e4; }",
    );

    app = createKalamosApp(document);
    await app.init();

    await app.themeMenu.selectTheme("custom:night");
    const customStyleEl = document.getElementById(CUSTOM_THEME_STYLE_ID)!;
    expect(customStyleEl).not.toBeNull();
    expect(document.head.lastElementChild).toBe(customStyleEl);
    expect(customStyleEl.textContent).toContain(":root[data-custom-theme]");

    // Dynamically append another <style> element to <head>
    const extraStyle = document.createElement("style");
    extraStyle.id = "dynamic-other-style";
    extraStyle.textContent = ".some-other-rule { color: red; }";
    document.head.appendChild(extraStyle);
    expect(document.head.lastElementChild).toBe(extraStyle);

    // Re-apply custom theme -> k-custom-theme must move back to the end of <head>
    await app.themeMenu.selectTheme("custom:sage");
    const updatedCustomStyle = document.getElementById(CUSTOM_THEME_STYLE_ID)!;
    expect(document.head.lastElementChild).toBe(updatedCustomStyle);
    expect(updatedCustomStyle.textContent).toContain("--k-bg: #e8f0e4;");

    extraStyle.remove();
  });

  it("cycles through themes via Cmd+Shift+T shortcut and persists choice", async () => {
    app = createKalamosApp(document);
    await app.init();

    expect(app.themeMenu.getCurrentTheme()).toBe("system");

    // 1st Cmd+Shift+T: system -> papyros
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "T",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(app.themeMenu.getCurrentTheme()).toBe("papyros");
    expect(document.documentElement.getAttribute("data-theme")).toBe("papyros");
    expect((await getSettings()).theme).toBe("papyros");

    // 2nd Cmd+Shift+T: papyros -> melan
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "T",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(app.themeMenu.getCurrentTheme()).toBe("melan");
    expect(document.documentElement.getAttribute("data-theme")).toBe("melan");
    expect((await getSettings()).theme).toBe("melan");

    // 3rd Cmd+Shift+T: melan -> nyx
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "T",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(app.themeMenu.getCurrentTheme()).toBe("nyx");
    expect(document.documentElement.getAttribute("data-theme")).toBe("nyx");
    expect((await getSettings()).theme).toBe("nyx");

    // 4th Cmd+Shift+T: nyx -> custom:night
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "T",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(app.themeMenu.getCurrentTheme()).toBe("custom:night");
    expect(
      document.getElementById(CUSTOM_THEME_STYLE_ID)?.textContent,
    ).toContain(":root[data-custom-theme]");
    expect((await getSettings()).theme).toBe("custom:night");
  });

  it("supports data-base-theme: nyx for custom themes (even with color-scheme: dark) and localized English names", async () => {
    expect(
      detectBaseThemeForCustomCss(
        "/* data-base-theme: nyx */\n:root[data-custom-theme] { color-scheme: dark; --k-accent: #7aa2f7; }",
      ),
    ).toBe("nyx");
    expect(
      detectBaseThemeForCustomCss(
        "/* data-base-theme: melan */\n:root[data-custom-theme] { color-scheme: dark; }",
      ),
    ).toBe("melan");
    expect(
      detectBaseThemeForCustomCss(
        ":root[data-custom-theme] { color-scheme: dark; }",
      ),
    ).toBe("melan");

    seedMockCustomTheme(
      "obsidian",
      "/* data-base-theme: nyx */\n:root[data-custom-theme] { color-scheme: dark; --k-accent: #a6d189; }",
    );

    initUiLocale("en");
    app = createKalamosApp(document);
    await app.init();

    await app.themeMenu.openMenu();
    const labels = app.themeMenu
      .getAvailableOptions()
      .map((o) => `${o.id}:${o.label}`);
    expect(labels).toEqual([
      "system:Follow System",
      "papyros:Papyros",
      "melan:Melan",
      "nyx:Nyx",
      "custom:night:night",
      "custom:obsidian:obsidian",
    ]);

    await app.themeMenu.selectTheme("custom:obsidian");
    expect(document.documentElement.getAttribute("data-theme")).toBe("nyx");
    expect(document.documentElement.getAttribute("data-custom-theme")).toBe(
      "custom:obsidian",
    );

    applySystemDarkTheme("nyx");
    expect(
      document.documentElement.getAttribute("data-system-dark-theme"),
    ).toBe("nyx");
    applySystemDarkTheme("melan");
    expect(
      document.documentElement.hasAttribute("data-system-dark-theme"),
    ).toBe(false);
  });
});
