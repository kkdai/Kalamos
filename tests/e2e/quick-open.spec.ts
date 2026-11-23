import { expect, type Page, test } from "@playwright/test";
import {
  boot,
  getDoc,
  getSelection,
  MOD,
  newPlatformContext,
  nextFrames,
  setDoc,
  withIpc,
} from "./helpers";

/**
 * #104: Cmd+P Quick Open (fuzzy search + recent files) — full flow, tab rules,
 * caching, IME composition, missing recent file recovery, and Windows UX.
 */

const VAULT = "/tmp/kalamos-test/vault";

async function seedVault(page: Page): Promise<void> {
  await withIpc(
    page,
    `ipc.seedMockDir(arg.root);
     ipc.seedMockFile(arg.root + '/README.md', '# Vault Readme\\n\\nWelcome');
     ipc.seedMockFile(arg.root + '/notes.md', '# Architecture Notes\\n\\nBody');
     ipc.seedMockFile(arg.root + '/guides/shortcuts.md', '# Keyboard Shortcuts');
     ipc.seedMockFile(arg.root + '/guides/quick-open.md', '# Quick Open Spec');
     ipc.seedMockFile(arg.root + '/設計規格.md', '# 設計規格');
     ipc.seedMockFile(arg.root + '/.hidden/secret.md', '# Hidden');
     ipc.seedMockFile(arg.root + '/node_modules/pkg/readme.md', '# NPM');
     ipc.seedMockFile(arg.root + '/plain.txt', 'not markdown');
     ipc.seedMockFile('/tmp/kalamos-test/outside/memo.md', '# External Memo');`,
    { root: VAULT },
  );
}

async function openVault(page: Page): Promise<void> {
  await page.evaluate(async (root) => {
    const main = await import("/src/main.ts" as string);
    await main.getActiveApp().openFolder(root);
  }, VAULT);
  await nextFrames(page, 3);
}

test("#104 Cmd+P fuzzy search, highlights, keyboard nav, tab rules, and focus restore", async ({
  page,
}) => {
  await boot(page);
  await seedVault(page);
  await openVault(page);

  // Set cursor in editor so we can verify Esc restores focus & exact selection.
  await setDoc(page, "Hello Kalamos", 6);
  const callsAfterOpen = await withIpc<number>(
    page,
    "return ipc.getMockListMarkdownPathsCallCount();",
  );
  expect(callsAfterOpen).toBe(1);

  // Cmd+P opens Quick Open with focus in input; Esc closes and restores cursor.
  await page.keyboard.press(`${MOD}+KeyP`);
  const input = page.getByTestId("quick-open-input");
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(input).toBeHidden();
  expect(await getSelection(page)).toEqual({ anchor: 6, head: 6 });
  const editorFocused = await page.evaluate(async () => {
    const main = await import("/src/main.ts" as string);
    return main.getActiveApp().editor.view.hasFocus;
  });
  expect(editorFocused).toBe(true);

  // Opening Quick Open again does NOT re-scan the folder.
  await page.keyboard.press(`${MOD}+KeyP`);
  await expect(input).toBeVisible();
  expect(
    await withIpc<number>(
      page,
      "return ipc.getMockListMarkdownPathsCallCount();",
    ),
  ).toBe(1);

  // Type fuzzy query "qo" -> quick-open.md ranks first with highlighted marks.
  await page.keyboard.type("qo");
  const items = page.getByTestId("quick-open-item");
  await expect(items.first()).toHaveAttribute(
    "data-path",
    `${VAULT}/guides/quick-open.md`,
  );
  await expect(items.first().locator("mark.k-qo-match")).toHaveText(["q", "o"]);
  await expect(items.first().getByTestId("quick-open-item-dir")).toHaveText(
    "guides",
  );

  // Enter opens in a new tab because active tab has text ("Hello Kalamos").
  await page.keyboard.press("Enter");
  await expect(input).toBeHidden();
  await expect.poll(() => getDoc(page)).toBe("# Quick Open Spec");
  await expect(page.getByTestId("tab")).toHaveCount(2);

  // Search "md", move with ArrowDown, open with Enter, then re-open existing file -> switches tab.
  await page.keyboard.press(`${MOD}+KeyP`);
  await page.keyboard.type("notes");
  await expect(items.first()).toHaveAttribute("data-path", `${VAULT}/notes.md`);
  await page.keyboard.press("Enter");
  await expect.poll(() => getDoc(page)).toBe("# Architecture Notes\n\nBody");
  await expect(page.getByTestId("tab")).toHaveCount(3);

  // Re-opening quick-open.md switches to existing tab without duplicating.
  await page.keyboard.press(`${MOD}+KeyP`);
  await page.keyboard.type("quick-open");
  await page.keyboard.press("Enter");
  await expect.poll(() => getDoc(page)).toBe("# Quick Open Spec");
  await expect(page.getByTestId("tab")).toHaveCount(3);

  // Blank untitled tab + Cmd+Enter -> always opens a new tab instead of reusing blank tab.
  await page.keyboard.press(`${MOD}+KeyT`);
  await expect(page.getByTestId("tab")).toHaveCount(4);
  await page.keyboard.press(`${MOD}+KeyP`);
  await page.keyboard.type("readme");
  await page.keyboard.press(`${MOD}+Enter`);
  await expect.poll(() => getDoc(page)).toBe("# Vault Readme\n\nWelcome");
  await expect(page.getByTestId("tab")).toHaveCount(5);

  // Mouse click on a result item opens it.
  await page.keyboard.press(`${MOD}+KeyP`);
  await page.keyboard.type("short");
  await items.first().click();
  await expect.poll(() => getDoc(page)).toBe("# Keyboard Shortcuts");
});

test("#104 recent files when input is empty, missing file cleanup, watch refresh, and IME", async ({
  page,
}) => {
  await boot(page);
  await seedVault(page);

  // Open an external file (no folder opened yet) -> shows up in recent files.
  await page.evaluate(async () => {
    const main = await import("/src/main.ts" as string);
    await main
      .getActiveApp()
      .openPath("/tmp/kalamos-test/outside/memo.md", "tab");
  });
  await openVault(page);
  await page.evaluate(async (root) => {
    const main = await import("/src/main.ts" as string);
    await main.getActiveApp().openPath(`${root}/notes.md`, "tab");
  }, VAULT);

  // Empty Quick Open lists recent files newest-first (including outside folder).
  await page.keyboard.press(`${MOD}+KeyP`);
  const items = page.getByTestId("quick-open-item");
  await expect(page.getByTestId("quick-open-section")).toContainText(
    "最近開啟",
  );
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveAttribute("data-path", `${VAULT}/notes.md`);
  await expect(items.nth(1)).toHaveAttribute(
    "data-path",
    "/tmp/kalamos-test/outside/memo.md",
  );
  await page.keyboard.press(`${MOD}+KeyP`);
  await expect(page.getByTestId("quick-open")).toBeHidden();

  // Close memo.md's tab, delete it from disk, then open it from recent list -> clear error & removed.
  await page.evaluate(async () => {
    const main = await import("/src/main.ts" as string);
    const app = main.getActiveApp();
    const tab = app
      .getTabs()
      .find(
        (t: { path: string | null }) =>
          t.path === "/tmp/kalamos-test/outside/memo.md",
      );
    if (tab) await app.closeTab(tab.id);
  });
  await withIpc(
    page,
    "await ipc.trashPath('/tmp/kalamos-test/outside/memo.md');",
  );
  await page.keyboard.press(`${MOD}+KeyP`);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status")).toContainText("找不到檔案");

  // Reopen Quick Open: deleted file is gone from recent list.
  await page.keyboard.press(`${MOD}+KeyP`);
  await expect(items).toHaveCount(1);
  await expect(items.nth(0)).toHaveAttribute("data-path", `${VAULT}/notes.md`);
  await page.keyboard.press("Escape");

  // Watch event picks up newly created file.
  await withIpc(
    page,
    `ipc.seedMockFile(arg.root + '/brand-new.md', '# Brand New');
     await ipc.triggerMockFsChanged({ root: arg.root, paths: [arg.root + '/brand-new.md'] });`,
    { root: VAULT },
  );
  await nextFrames(page, 3);
  await page.keyboard.press(`${MOD}+KeyP`);
  await page.keyboard.type("brand-new");
  await expect(items.first()).toHaveAttribute(
    "data-path",
    `${VAULT}/brand-new.md`,
  );
  await page.keyboard.press("Escape");

  // IME composition: composing Enter must not open; compositionend triggers search.
  await page.keyboard.press(`${MOD}+KeyP`);
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="quick-open-input"]',
    )!;
    input.dispatchEvent(new Event("compositionstart"));
    input.value = "ㄕㄜˋ";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(page.getByTestId("quick-open")).toBeVisible();
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="quick-open-input"]',
    )!;
    input.value = "設計";
    input.dispatchEvent(new Event("compositionend"));
  });
  await expect(items).toHaveCount(1);
  await expect(items.first()).toHaveAttribute(
    "data-path",
    `${VAULT}/設計規格.md`,
  );
  await page.keyboard.press("Enter");
  await expect.poll(() => getDoc(page)).toBe("# 設計規格");
});

test("#104 Windows simulation: Ctrl+P, Ctrl shortcut labels, and backslash relative paths", async ({
  browser,
}) => {
  const ctx = await newPlatformContext(browser, "windows");
  const page = await ctx.newPage();
  try {
    await boot(page);

    // Without folder or recent files: empty state & footer show Ctrl shortcuts (no ⌘/⇧).
    await page.keyboard.press("Control+p");
    const panel = page.getByTestId("quick-open");
    await expect(panel).toBeVisible();
    const footerText = await page.getByTestId("quick-open-footer").innerText();
    expect(footerText).toContain("Ctrl+Enter 新分頁");
    expect(footerText).not.toMatch(/[⌘⌥⇧⌃]|Cmd\+|Opt\+/);

    const emptyText = await page.getByTestId("quick-open-empty").innerText();
    expect(emptyText).toContain("Ctrl+O");
    expect(emptyText).toContain("Ctrl+Shift+O");
    expect(emptyText).not.toMatch(/[⌘⌥⇧⌃]|Cmd\+|Opt\+/);

    // Ctrl+P again closes it.
    await page.keyboard.press("Control+p");
    await expect(panel).toBeHidden();

    // Windows drive paths show backslashes in Quick Open dir & tooltip.
    await withIpc(
      page,
      `ipc.seedMockFile('C:/work/notes/guides/sub/windows-tip.md', '# Win Tip');`,
    );
    await page.evaluate(async () => {
      const main = await import("/src/main.ts" as string);
      await main.getActiveApp().openFolder("C:/work/notes");
    });
    await nextFrames(page, 3);

    await page.keyboard.press("Control+p");
    await page.keyboard.type("wintip");
    const item = page.getByTestId("quick-open-item").first();
    await expect(item).toHaveAttribute(
      "title",
      "C:\\work\\notes\\guides\\sub\\windows-tip.md",
    );
    await expect(item.getByTestId("quick-open-item-dir")).toHaveText(
      "guides\\sub",
    );

    // Ctrl+Enter opens in a new tab even when active tab is blank.
    await page.keyboard.press("Control+Enter");
    await expect(panel).toBeHidden();
    await expect.poll(() => getDoc(page)).toBe("# Win Tip");
    await expect(page.getByTestId("tab")).toHaveCount(2);
  } finally {
    await ctx.close();
  }
});
