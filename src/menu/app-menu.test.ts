import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitMockMenuAction,
  getMockMenuState,
  getMockQuitCount,
  getMockSaveChangesPrompts,
  getMockThemesDirOpenCount,
  getMockZoom,
  getSettings,
  resetMockState,
  seedMockSettings,
  setMockDialogHandlers,
} from "../ipc";
import {
  createKalamosApp,
  type KalamosApp,
  nextZoomLevel,
  WHEEL_ZOOM_RESET_MS,
  ZOOM_LEVELS,
} from "../main";
import { MENU_THEN_KEY_WINDOW_MS, menuActions } from "./menu-dispatch";

function setupDom(): void {
  document.body.innerHTML = `
    <div id="app">
      <aside id="sidebar" data-visible="false"></aside>
      <main id="editor-container"></main>
      <div id="status" data-testid="status" role="status"></div>
    </div>
  `;
}

function dispatchWheel(target: EventTarget, init?: WheelEventInit): WheelEvent {
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    deltaY: -100,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 5));
}

describe("#74 native menu → app handlers", () => {
  let app: KalamosApp | null = null;

  beforeEach(async () => {
    resetMockState();
    setupDom();
    app = createKalamosApp(document);
    await app.init();
    await settle();
  });

  afterEach(() => {
    app?.destroy();
    app = null;
    document.documentElement.removeAttribute("style");
  });

  it("every menu item in menu-spec.json has a handler", () => {
    for (const action of menuActions()) {
      expect(app!.menu.hasCommand(action.id), action.id).toBe(true);
    }
    expect(app!.menu.hasCommand("view.setTheme")).toBe(true);
  });

  it("a menu-action event runs the same toggle as the shortcut, once, and syncs the check mark", async () => {
    expect(getMockMenuState()?.checks["view.focusMode"]).toBe(false);
    await emitMockMenuAction("view.focusMode");
    await settle();
    expect(app!.editor.isFocusMode()).toBe(true);
    expect(getMockMenuState()?.checks["view.focusMode"]).toBe(true);
    expect((await getSettings()).focusMode).toBe(true);

    // The F8 shortcut (pressed later) toggles it back; the menu follows.
    await new Promise((r) => setTimeout(r, MENU_THEN_KEY_WINDOW_MS + 30));
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F8", code: "F8", cancelable: true }),
    );
    await settle();
    expect(app!.editor.isFocusMode()).toBe(false);
    expect(getMockMenuState()?.checks["view.focusMode"]).toBe(false);
  });

  it("a shortcut the page handled is not run again by the menu", async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "/",
        code: "Slash",
        metaKey: true,
        cancelable: true,
      }),
    );
    expect(app!.editor.isSourceMode()).toBe(true);
    await emitMockMenuAction("view.sourceMode");
    await settle();
    expect(app!.editor.isSourceMode()).toBe(true);
    expect(getMockMenuState()?.checks["view.sourceMode"]).toBe(true);
  });

  it("theme items select the theme and mark it", async () => {
    await emitMockMenuAction("view.setTheme", "melan");
    await settle();
    expect(app!.themeMenu.getCurrentTheme()).toBe("melan");
    const state = getMockMenuState()!;
    expect(state.theme).toBe("melan");
    expect(state.themes.map((t) => t.id)).toEqual(
      expect.arrayContaining(["system", "papyros", "melan"]),
    );
  });

  it("大綱 shows the outline tab and hides the sidebar the second time", async () => {
    await emitMockMenuAction("view.outline");
    await settle();
    expect(app!.sidebar.isVisible()).toBe(true);
    expect(app!.sidebar.getTab()).toBe("outline");
    expect(getMockMenuState()?.checks["view.outline"]).toBe(true);
    await emitMockMenuAction("view.outline");
    await settle();
    expect(app!.sidebar.isVisible()).toBe(false);
    expect(getMockMenuState()?.checks["view.outline"]).toBe(false);
  });

  it("formatting and paragraph items edit the document", async () => {
    app!.editor.setContent("hello", { dirty: false });
    app!.editor.view.dispatch({ selection: { anchor: 0, head: 5 } });
    await emitMockMenuAction("fmt.bold");
    expect(app!.editor.getContent()).toBe("**hello**");
    await emitMockMenuAction("para.heading2");
    expect(app!.editor.getContent()).toBe("## **hello**");
  });

  it("zoom items step through the zoom levels", async () => {
    await emitMockMenuAction("view.zoomIn");
    expect(getMockZoom()).toBe(1.1);
    await emitMockMenuAction("view.zoomOut");
    await emitMockMenuAction("view.zoomOut");
    expect(getMockZoom()).toBe(0.9);
    await emitMockMenuAction("view.actualSize");
    expect(getMockZoom()).toBe(1);
    expect(nextZoomLevel(3, 1)).toBe(3);
    expect(nextZoomLevel(0.5, -1)).toBe(0.5);
  });

  it("Ctrl+wheel shares zoom with the menu and keyboard", async () => {
    const scroller = app!.editor.view.scrollDOM;
    expect(dispatchWheel(scroller).defaultPrevented).toBe(true);
    expect(getMockZoom()).toBe(1.1);
    expect(dispatchWheel(scroller, { deltaY: 100 }).defaultPrevented).toBe(
      true,
    );
    expect(getMockZoom()).toBe(1);
    dispatchWheel(scroller, { deltaY: 100 });
    expect(getMockZoom()).toBe(0.9);
    expect(app!.getStatusText()).toBe("縮放 90%");

    await emitMockMenuAction("view.zoomIn");
    expect(getMockZoom()).toBe(1);
    dispatchWheel(document.querySelector("#sidebar")!);
    expect(getMockZoom()).toBe(1.1);
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "Digit0",
        ctrlKey: true,
        shiftKey: true,
        cancelable: true,
      }),
    );
    expect(getMockZoom()).toBe(1);
    expect(app!.getStatusText()).toBe("縮放 100%");
  });

  it("consumes Ctrl+wheel at the existing zoom limits", () => {
    const scroller = app!.editor.view.scrollDOM;
    for (let i = 0; i < ZOOM_LEVELS.length; i++) dispatchWheel(scroller);
    expect(getMockZoom()).toBe(3);
    expect(dispatchWheel(scroller).defaultPrevented).toBe(true);
    expect(getMockZoom()).toBe(3);

    for (let i = 0; i < ZOOM_LEVELS.length; i++) {
      dispatchWheel(scroller, { deltaY: 100 });
    }
    expect(getMockZoom()).toBe(0.5);
    expect(dispatchWheel(scroller, { deltaY: 100 }).defaultPrevented).toBe(
      true,
    );
    expect(getMockZoom()).toBe(0.5);
  });

  it("accumulates small wheel deltas before stepping and still prevents default", () => {
    const scroller = app!.editor.view.scrollDOM;
    for (let i = 0; i < 9; i++) {
      expect(dispatchWheel(scroller, { deltaY: -10 }).defaultPrevented).toBe(
        true,
      );
      expect(app!.getZoom()).toBe(1);
    }
    expect(dispatchWheel(scroller, { deltaY: -10 }).defaultPrevented).toBe(
      true,
    );
    expect(app!.getZoom()).toBe(1.1);
    expect(getMockZoom()).toBe(1.1);
  });

  it("steps one level for a single deltaY of -100", () => {
    const scroller = app!.editor.view.scrollDOM;
    expect(dispatchWheel(scroller, { deltaY: -100 }).defaultPrevented).toBe(
      true,
    );
    expect(app!.getZoom()).toBe(1.1);
    expect(getMockZoom()).toBe(1.1);
  });

  it("resets accumulated wheel delta on direction reversal and idle timeout", () => {
    const scroller = app!.editor.view.scrollDOM;
    let now = 10_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      for (let i = 0; i < 8; i++) dispatchWheel(scroller, { deltaY: -10 });
      expect(app!.getZoom()).toBe(1);

      for (let i = 0; i < 9; i++) dispatchWheel(scroller, { deltaY: 10 });
      expect(app!.getZoom()).toBe(1);
      dispatchWheel(scroller, { deltaY: 10 });
      expect(app!.getZoom()).toBe(0.9);
      expect(getMockZoom()).toBe(0.9);

      for (let i = 0; i < 8; i++) dispatchWheel(scroller, { deltaY: -10 });
      expect(app!.getZoom()).toBe(0.9);
      now += WHEEL_ZOOM_RESET_MS;
      for (let i = 0; i < 5; i++) dispatchWheel(scroller, { deltaY: -10 });
      expect(app!.getZoom()).toBe(0.9);
      for (let i = 0; i < 5; i++) dispatchWheel(scroller, { deltaY: -10 });
      expect(app!.getZoom()).toBe(1);
      expect(getMockZoom()).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("normalizes LINE and PAGE wheel delta modes", () => {
    const scroller = app!.editor.view.scrollDOM;
    dispatchWheel(scroller, {
      deltaY: -1,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
    });
    dispatchWheel(scroller, {
      deltaY: -1,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
    });
    expect(app!.getZoom()).toBe(1);
    dispatchWheel(scroller, {
      deltaY: -1,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
    });
    expect(app!.getZoom()).toBe(1.1);
    expect(getMockZoom()).toBe(1.1);

    dispatchWheel(scroller, {
      deltaY: 1,
      deltaMode: WheelEvent.DOM_DELTA_PAGE,
    });
    expect(app!.getZoom()).toBe(1);
    expect(getMockZoom()).toBe(1);
  });

  it("ignores unrelated, non-cancelable, or already handled wheel events", () => {
    const scroller = app!.editor.view.scrollDOM;
    for (const init of [
      { ctrlKey: false },
      { altKey: true },
      { metaKey: true },
      { shiftKey: true },
      { deltaX: 100, deltaY: 0 },
      { cancelable: false },
    ]) {
      expect(dispatchWheel(scroller, init).defaultPrevented).toBe(false);
      expect(app!.getZoom()).toBe(1);
    }
    scroller.addEventListener("wheel", (event) => event.preventDefault(), {
      once: true,
      passive: false,
    });
    expect(dispatchWheel(scroller).defaultPrevented).toBe(true);
    expect(app!.getZoom()).toBe(1);
  });

  it("stops handling Ctrl+wheel when the app is destroyed", () => {
    const sidebar = document.querySelector("#sidebar")!;
    const destroyedApp = app!;
    destroyedApp.destroy();
    app = null;

    expect(dispatchWheel(sidebar).defaultPrevented).toBe(false);
    expect(destroyedApp.getZoom()).toBe(1);
  });

  it("偏好設定 opens the modal; editing items are ignored while it is open", async () => {
    await emitMockMenuAction("app.preferences");
    await settle();
    expect(app!.preferences.isOpen()).toBe(true);
    expect(
      document.querySelector('[data-testid="preferences"]'),
    ).not.toBeNull();
    app!.editor.setContent("x", { dirty: false });
    await emitMockMenuAction("para.heading1");
    expect(app!.editor.getContent()).toBe("x");
    app!.preferences.close();
  });

  it("#89 window keydown handles menu-only & paragraph shortcuts once (deduped with menu)", async () => {
    app!.editor.setContent("hello", { dirty: false });
    app!.editor.view.dispatch({ selection: { anchor: 0, head: 5 } });

    // Ctrl+1..6 / Ctrl+0 / Ctrl+Alt+Q / Ctrl+Shift+D work via window keydown even outside CM focus.
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "2",
        code: "Digit2",
        ctrlKey: true,
        cancelable: true,
      }),
    );
    await emitMockMenuAction("para.heading2");
    expect(app!.editor.getContent()).toBe("## hello");

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "q",
        code: "KeyQ",
        ctrlKey: true,
        altKey: true,
        cancelable: true,
      }),
    );
    await emitMockMenuAction("para.quote");
    expect(app!.editor.getContent()).toBe("> ## hello");

    // Ctrl+Shift+1 toggles outline and is deduped against menu-action.
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "!",
        code: "Digit1",
        ctrlKey: true,
        shiftKey: true,
        cancelable: true,
      }),
    );
    await settle();
    await emitMockMenuAction("view.outline");
    await settle();
    expect(app!.sidebar.isVisible()).toBe(true);
    expect(app!.sidebar.getTab()).toBe("outline");

    // Zoom shortcuts: Ctrl+Shift+= / - / 0.
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "+",
        code: "Equal",
        ctrlKey: true,
        shiftKey: true,
        cancelable: true,
      }),
    );
    await emitMockMenuAction("view.zoomIn");
    expect(getMockZoom()).toBe(1.1);
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "_",
        code: "Minus",
        ctrlKey: true,
        shiftKey: true,
        cancelable: true,
      }),
    );
    expect(getMockZoom()).toBe(1);
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "+",
        code: "Equal",
        ctrlKey: true,
        shiftKey: true,
        cancelable: true,
      }),
    );
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: ")",
        code: "Digit0",
        ctrlKey: true,
        shiftKey: true,
        cancelable: true,
      }),
    );
    expect(getMockZoom()).toBe(1);

    // Ctrl+Q checks unsaved changes across tabs before quitting, and is deduped with menu.
    app!.editor.markDirty();
    setMockDialogHandlers({ saveChanges: () => "cancel" });
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "q",
        code: "KeyQ",
        ctrlKey: true,
        cancelable: true,
      }),
    );
    await emitMockMenuAction("app.quit");
    await settle();
    expect(getMockQuitCount()).toBe(0);
    expect(getMockSaveChangesPrompts()).toHaveLength(1);
  });
});

describe("#74 preferences apply immediately and persist", () => {
  let app: KalamosApp | null = null;

  afterEach(() => {
    app?.destroy();
    app = null;
    document.documentElement.removeAttribute("style");
  });

  async function boot(): Promise<KalamosApp> {
    setupDom();
    app = createKalamosApp(document);
    await app.init();
    await settle();
    return app;
  }

  it("font size and width change the CSS variables and are saved", async () => {
    resetMockState();
    const a = await boot();
    await a.preferences.open("editor");
    const font = document.querySelector<HTMLInputElement>(
      '[data-testid="pref-font-size"]',
    )!;
    font.value = "20";
    font.dispatchEvent(new Event("input"));
    const width = document.querySelector<HTMLInputElement>(
      '[data-testid="pref-content-width"]',
    )!;
    width.value = "900";
    width.dispatchEvent(new Event("input"));
    await settle();
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--k-font-size")).toBe("20px");
    expect(style.getPropertyValue("--k-max-width")).toBe("900px");
    const saved = await getSettings();
    expect(saved.fontSize).toBe(20);
    expect(saved.contentWidth).toBe(900);
  });

  it("editor toggles in the modal drive the editor and the menu", async () => {
    resetMockState();
    const a = await boot();
    await a.preferences.open("editor");
    const box = document.querySelector<HTMLInputElement>(
      '[data-testid="pref-code-line-numbers"]',
    )!;
    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await settle();
    expect(a.editor.isCodeLineNumbers()).toBe(true);
    expect(getMockMenuState()?.checks["view.codeLineNumbers"]).toBe(true);
    expect((await getSettings()).codeLineNumbers).toBe(true);

    // Toggled elsewhere (Cmd+Opt+L) while the modal is open: the box follows.
    a.editor.toggleCodeLineNumbers();
    await settle();
    expect(box.checked).toBe(false);
  });

  it("autosave off stops the timer-based save", async () => {
    resetMockState();
    const a = await boot();
    await a.preferences.open("general");
    const box = document.querySelector<HTMLInputElement>(
      '[data-testid="pref-auto-save"]',
    )!;
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    await settle();
    expect((await getSettings()).autoSave).toBe(false);
  });

  it("an old settings file loads with defaults; start blank skips the last folder", async () => {
    resetMockState();
    // v0.1.1 file: none of the #74 keys.
    seedMockSettings({
      theme: "melan",
      lastFolder: "/demo",
      sidebarVisible: true,
      sidebarTab: "tree",
      sourceMode: false,
    });
    let a = await boot();
    expect(a.sidebar.getCurrentFolder()).toBe("/demo");
    expect(
      document.documentElement.style.getPropertyValue("--k-font-size"),
    ).toBe("17px");
    await a.preferences.open("general");
    const startup = document.querySelector<HTMLSelectElement>(
      '[data-testid="pref-startup"]',
    )!;
    expect(startup.value).toBe("restoreFolder");
    startup.value = "blank";
    startup.dispatchEvent(new Event("change"));
    await settle();
    expect((await getSettings()).startupBehavior).toBe("blank");
    a.destroy();

    a = await boot();
    expect(a.sidebar.getCurrentFolder()).toBeNull();
    expect(a.themeMenu.getCurrentTheme()).toBe("melan");
  });

  it("開啟自訂 CSS 資料夾 asks the backend to reveal the folder", async () => {
    resetMockState();
    const a = await boot();
    await a.preferences.open("appearance");
    document
      .querySelector<HTMLButtonElement>('[data-testid="pref-open-themes-dir"]')!
      .click();
    await settle();
    expect(getMockThemesDirOpenCount()).toBe(1);
  });
});
