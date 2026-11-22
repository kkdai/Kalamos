import { describe, expect, it, vi } from "vitest";
import {
  createMenuDispatcher,
  DUPLICATE_WINDOW_MS,
  MENU_SPEC,
  MENU_THEN_KEY_WINDOW_MS,
  matchesKey,
  menuActions,
  parseAccelerator,
} from "./menu-dispatch";

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
}

function setup(
  commands: Record<string, () => unknown>,
  extra: Partial<Parameters<typeof createMenuDispatcher>[0]> = {},
) {
  let clock = 1000;
  const target = document.createElement("div");
  document.body.append(target);
  const dispatcher = createMenuDispatcher({
    commands,
    target,
    now: () => clock,
    ...extra,
  });
  return {
    target,
    dispatcher,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("#74 menu accelerators", () => {
  it("parses every accelerator in menu-spec.json", () => {
    const actions = menuActions(MENU_SPEC);
    expect(actions.length).toBeGreaterThan(30);
    for (const a of actions) {
      if (a.accel) expect(() => parseAccelerator(a.accel!)).not.toThrow();
    }
  });

  it("parses modifiers and keys", () => {
    expect(parseAccelerator("CmdOrCtrl+Shift+S")).toEqual({
      code: "KeyS",
      cmdOrCtrl: true,
      meta: false,
      ctrl: false,
      alt: false,
      shift: true,
    });
    expect(parseAccelerator("CmdOrCtrl+,")).toMatchObject({
      code: "Comma",
      cmdOrCtrl: true,
    });
    expect(parseAccelerator("F8")).toMatchObject({
      key: "F8",
      cmdOrCtrl: false,
    });
    expect(parseAccelerator("CmdOrCtrl+Shift+[").code).toBe("BracketLeft");
    expect(parseAccelerator("CmdOrCtrl+Shift+`").code).toBe("Backquote");
    expect(() => parseAccelerator("Hyper+K")).toThrow();
  });

  it("#81 Ctrl+Tab matches Ctrl only, not Cmd", () => {
    const m = parseAccelerator("Ctrl+Shift+Tab");
    expect(m).toMatchObject({
      code: "Tab",
      ctrl: true,
      shift: true,
      cmdOrCtrl: false,
    });
    expect(
      matchesKey(
        m,
        key({ code: "Tab", key: "Tab", ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(true);
    expect(
      matchesKey(
        m,
        key({ code: "Tab", key: "Tab", metaKey: true, shiftKey: true }),
      ),
    ).toBe(false);
  });

  it("CmdOrCtrl matches Cmd or Ctrl, but not both or neither", () => {
    const m = parseAccelerator("CmdOrCtrl+S");
    expect(matchesKey(m, key({ code: "KeyS", metaKey: true }))).toBe(true);
    expect(matchesKey(m, key({ code: "KeyS", ctrlKey: true }))).toBe(true);
    expect(
      matchesKey(m, key({ code: "KeyS", metaKey: true, ctrlKey: true })),
    ).toBe(false);
    expect(matchesKey(m, key({ code: "KeyS" }))).toBe(false);
    expect(
      matchesKey(parseAccelerator("F8"), key({ key: "F8", metaKey: true })),
    ).toBe(false);
  });

  it("matches keydowns by physical key and exact modifiers", () => {
    const m = parseAccelerator("CmdOrCtrl+Alt+E");
    // Option changes event.key on macOS; event.code is what counts.
    expect(
      matchesKey(
        m,
        key({ key: "´", code: "KeyE", metaKey: true, altKey: true }),
      ),
    ).toBe(true);
    expect(matchesKey(m, key({ key: "e", code: "KeyE", metaKey: true }))).toBe(
      false,
    );
    expect(
      matchesKey(
        m,
        key({
          key: "e",
          code: "KeyE",
          metaKey: true,
          altKey: true,
          shiftKey: true,
        }),
      ),
    ).toBe(false);
  });
});

describe("#74 menu dispatcher", () => {
  it("runs the command for a menu click and passes the argument", () => {
    const save = vi.fn();
    const setTheme = vi.fn();
    const afterRun = vi.fn();
    const { dispatcher } = setup(
      { "file.save": save, "view.setTheme": setTheme },
      { afterRun },
    );
    expect(dispatcher.dispatch("file.save")).toBe(true);
    expect(dispatcher.dispatch("view.setTheme", "melan")).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(setTheme).toHaveBeenCalledWith("melan");
    expect(afterRun).toHaveBeenCalledTimes(2);
    expect(dispatcher.dispatch("nope")).toBe(false);
  });

  it("drops the menu event when the page already handled the same key press", () => {
    const save = vi.fn();
    const { target, dispatcher } = setup({ "file.save": save });
    const ev = key({ key: "s", code: "KeyS", metaKey: true });
    target.addEventListener("keydown", (e) => {
      save();
      e.preventDefault();
    });
    target.dispatchEvent(ev);
    // WebKit then also offers the key equivalent to the menu.
    expect(dispatcher.dispatch("file.save")).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    // A later click on the menu item runs normally.
    expect(dispatcher.dispatch("file.save")).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("runs the menu command when the page did not handle the key", () => {
    const find = vi.fn();
    const { target, dispatcher } = setup({ "edit.find": find });
    target.dispatchEvent(key({ key: "f", code: "KeyF", metaKey: true }));
    expect(dispatcher.dispatch("edit.find")).toBe(true);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it("does not treat an unrelated handled key as the same press", () => {
    const save = vi.fn();
    const { target, dispatcher } = setup({ "file.save": save });
    target.addEventListener("keydown", (e) => e.preventDefault());
    target.dispatchEvent(key({ key: "Enter", code: "Enter" }));
    expect(dispatcher.dispatch("file.save")).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("only drops events inside the duplicate window", () => {
    const save = vi.fn();
    const { target, dispatcher, advance } = setup({ "file.save": save });
    target.addEventListener("keydown", (e) => e.preventDefault());
    target.dispatchEvent(key({ key: "s", code: "KeyS", metaKey: true }));
    advance(DUPLICATE_WINDOW_MS + 1);
    expect(dispatcher.dispatch("file.save")).toBe(true);
  });

  it("swallows the keydown that follows a menu accelerator that already ran", () => {
    const toggleFocus = vi.fn();
    const pageHandler = vi.fn();
    const { target, dispatcher } = setup({ "view.focusMode": toggleFocus });
    const inner = document.createElement("span");
    target.append(inner);
    inner.addEventListener("keydown", pageHandler);
    expect(dispatcher.dispatch("view.focusMode")).toBe(true);
    const ev = key({ key: "F8", code: "F8" });
    inner.dispatchEvent(ev);
    expect(pageHandler).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
    // The guard is used up: the next F8 press reaches the page.
    inner.dispatchEvent(key({ key: "F8", code: "F8" }));
    expect(pageHandler).toHaveBeenCalledTimes(1);
    expect(toggleFocus).toHaveBeenCalledTimes(1);
  });

  it("a key press well after a menu click is a new press", () => {
    const page = vi.fn();
    const { target, dispatcher, advance } = setup({
      "view.focusMode": vi.fn(),
    });
    target.addEventListener("keydown", page);
    dispatcher.dispatch("view.focusMode");
    advance(MENU_THEN_KEY_WINDOW_MS + 1);
    target.dispatchEvent(key({ key: "F8", code: "F8" }));
    expect(page).toHaveBeenCalledTimes(1);
  });

  it("key repeat alternating between menu and page never doubles a press", () => {
    let runs = 0;
    const { target, dispatcher } = setup({ "fmt.bold": () => runs++ });
    target.addEventListener("keydown", (e) => {
      runs++;
      e.preventDefault();
    });
    for (let i = 0; i < 3; i++) {
      target.dispatchEvent(key({ key: "b", code: "KeyB", metaKey: true }));
      dispatcher.dispatch("fmt.bold");
    }
    expect(runs).toBe(3);
  });

  it("canRun can block an action", () => {
    const bold = vi.fn();
    const { dispatcher } = setup(
      { "fmt.bold": bold },
      { canRun: (a) => a !== "fmt.bold" },
    );
    expect(dispatcher.dispatch("fmt.bold")).toBe(false);
    expect(bold).not.toHaveBeenCalled();
  });

  it("stops watching keys after destroy", () => {
    const toggle = vi.fn();
    const page = vi.fn();
    const { target, dispatcher } = setup({ "view.focusMode": toggle });
    target.addEventListener("keydown", page);
    dispatcher.dispatch("view.focusMode");
    dispatcher.destroy();
    target.dispatchEvent(key({ key: "F8", code: "F8" }));
    expect(page).toHaveBeenCalledTimes(1);
  });
});
