import { expect, type Page, test } from "@playwright/test";
import type { UiLocale } from "../../src/i18n";
import {
  boot,
  getDoc,
  getSelection,
  MOD,
  newPlatformContext,
  setDoc,
} from "./helpers";

/**
 * #147: Keyboard shortcuts cheatsheet & first-launch welcome document.
 */

async function menuAction(
  page: Page,
  action: string,
  arg: string | null = null,
): Promise<void> {
  await page.evaluate(
    async ({ action, arg }) => {
      const ipc = await import("/src/ipc.ts" as string);
      await ipc.emitMockMenuAction(action, arg);
    },
    { action, arg },
  );
}

async function bootWithSeed(page: Page, seedScript: string): Promise<void> {
  await page.route(
    "**/src/main.ts",
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: `${seedScript}\n${await response.text()}`,
      });
    },
    { times: 1 },
  );
  await boot(page);
}

for (const platform of ["macos", "windows"] as const) {
  test(`#147 keyboard shortcuts cheatsheet opens via shortcut & menu, filters, and closes (${platform})`, async ({
    browser,
  }) => {
    const context = await newPlatformContext(browser, platform);
    const page = await context.newPage();
    try {
      await boot(page);
      await setDoc(page, "Hello Kalamos", 5);

      // Open via Cmd+Opt+/ (macOS) or Ctrl+Alt+/ (Windows).
      await page.keyboard.press(`${MOD}+Alt+Slash`);
      const dialog = page.getByTestId("shortcuts-dialog");
      await expect(dialog).toBeVisible();
      const search = page.getByTestId("shortcuts-search");
      await expect(search).toBeFocused();

      // All 7 categories appear.
      for (const cat of [
        "file",
        "edit",
        "paragraph",
        "format",
        "view",
        "tabs",
        "search",
      ]) {
        await expect(page.getByTestId(`shortcuts-group-${cat}`)).toBeVisible();
      }

      // Platform-specific formatting check.
      const quickOpenKey = dialog
        .locator(
          '[data-shortcut-id="file.quickOpen"] [data-testid="shortcut-key"]',
        )
        .first();
      const selfKey = dialog
        .locator(
          '[data-shortcut-id="help.shortcuts"] [data-testid="shortcut-key"]',
        )
        .first();
      if (platform === "macos") {
        await expect(quickOpenKey).toHaveText("⌘P");
        await expect(selfKey).toHaveText("⌥⌘/");
      } else {
        await expect(quickOpenKey).toHaveText("Ctrl+P");
        await expect(selfKey).toHaveText("Ctrl+Alt+/");
        const allKeys = await dialog
          .getByTestId("shortcut-key")
          .allTextContents();
        for (const text of allKeys) {
          expect(text).not.toMatch(/[⌘⌥⇧⌃⇥⌫↩]/);
        }
      }

      // Search filters rows; clear button restores all rows.
      await search.fill("快速開啟");
      await expect(dialog.getByTestId("shortcut-row")).toHaveCount(1);
      await expect(
        dialog.locator('[data-shortcut-id="file.quickOpen"]'),
      ).toBeVisible();

      await search.fill("no-such-shortcut-xyz");
      await expect(page.getByTestId("shortcuts-empty")).toBeVisible();

      await page.getByTestId("shortcuts-clear").click();
      await expect(search).toHaveValue("");
      await expect(page.getByTestId("shortcuts-empty")).toHaveCount(0);

      // Esc closes and restores cursor/focus to the editor.
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      expect(await getSelection(page)).toEqual({ anchor: 5, head: 5 });
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const main = await import("/src/main.ts" as string);
            return main.getActiveApp().editor.view.hasFocus;
          }),
        )
        .toBe(true);

      // Menu action (說明 > 鍵盤快捷鍵) also opens and toggles it closed.
      await menuAction(page, "help.shortcuts");
      await expect(dialog).toBeVisible();
      await page.getByTestId("shortcuts-close").click();
      await expect(dialog).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
}

for (const [locale, expectedTitle, expectedHeading] of [
  ["zh-TW", "歡迎使用 Kalamos", "# 歡迎使用 Kalamos"],
  ["en", "Welcome to Kalamos", "# Welcome to Kalamos"],
] as ReadonlyArray<[UiLocale, string, string]>) {
  test(`#147 first launch opens welcome doc once (${locale}), renders live blocks, and menu reopens it`, async ({
    page,
  }) => {
    const systemLocale = locale === "zh-TW" ? "zh-TW" : "en-US";
    await bootWithSeed(
      page,
      `import { seedMockFirstLaunch, setMockSystemLocale } from '/src/ipc.ts';
       setMockSystemLocale(${JSON.stringify(systemLocale)});
       seedMockFirstLaunch();`,
    );

    // Welcome tab opens untitled and clean on first launch.
    await expect(page).toHaveTitle(expectedTitle);
    await expect.poll(() => getDoc(page)).toContain(expectedHeading);

    const state = await page.evaluate(async () => {
      const main = await import("/src/main.ts" as string);
      const ipc = await import("/src/ipc.ts" as string);
      const app = main.getActiveApp();
      return {
        path: app.getCurrentPath(),
        dirty: app.editor.isDirty(),
        tabs: app.getTabs().map((t) => ({ label: t.label, path: t.path })),
        welcomeShown: (await ipc.getSettings()).welcomeShown,
      };
    });
    expect(state).toEqual({
      path: null,
      dirty: false,
      tabs: [{ label: expectedTitle, path: null }],
      welcomeShown: true,
    });

    // Every demonstrated block renders cleanly in live preview (wait on explicit DOM states).
    await expect(page.getByTestId("front-matter-preview")).toBeVisible();
    await expect(page.locator(".k-table-wrapper table")).toBeVisible();
    await expect(page.getByTestId("math-inline").first()).toBeVisible();

    // Scroll to the bottom so CodeMirror mounts the virtualized math, code, and diagram blocks.
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller");
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    await expect(
      page.locator('[data-testid="math-block"] svg').first(),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="diagram"] .k-diagram-svg svg').first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("math-error")).toHaveCount(0);
    await expect(page.getByTestId("diagram-error")).toHaveCount(0);

    // Relaunching with the persisted settings does NOT reopen the welcome doc.
    await page.evaluate(async () => {
      const main = await import("/src/main.ts" as string);
      const app = main.getActiveApp();
      app.destroy();
      const fresh = main.createKalamosApp(document);
      await fresh.init();
      (window as unknown as { __freshWelcomeApp: unknown }).__freshWelcomeApp =
        fresh;
    });
    const afterRelaunch = await page.evaluate(() => {
      const fresh = (
        window as unknown as {
          __freshWelcomeApp: {
            editor: { getContent(): string };
            getTabs(): Array<{ label: string }>;
          };
        }
      ).__freshWelcomeApp;
      return {
        content: fresh.editor.getContent(),
        tabLabel: fresh.getTabs()[0]?.label ?? "",
      };
    });
    expect(afterRelaunch.content).toBe("");
    expect(afterRelaunch.tabLabel).not.toBe(expectedTitle);

    // Menu 說明 > 歡迎文件 reopens the welcome document.
    await menuAction(page, "help.welcome");
    await expect(page).toHaveTitle(expectedTitle);
    const reopenedContent = await page.evaluate(() => {
      const fresh = (
        window as unknown as {
          __freshWelcomeApp: { editor: { getContent(): string } };
        }
      ).__freshWelcomeApp;
      return fresh.editor.getContent();
    });
    expect(reopenedContent).toContain(expectedHeading);
  });
}

test("#147 existing user with settings file does not see welcome document on startup", async ({
  page,
}) => {
  await bootWithSeed(
    page,
    `import { seedMockSettings } from '/src/ipc.ts';
     seedMockSettings({ theme: 'melan', lastFolder: null });`,
  );

  await expect.poll(() => getDoc(page)).toBe("");
  await expect(page).toHaveTitle("未命名");
});
