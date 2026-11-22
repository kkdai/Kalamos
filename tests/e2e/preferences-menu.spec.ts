import { expect, type Page, test } from "@playwright/test";
import { boot, getDoc, MOD, nextFrames, selectRange, setDoc } from "./helpers";

/**
 * #74: native menu bar + 偏好設定. The native menu cannot be clicked in the
 * browser, so menu items are simulated through the IPC mock's `menu-action`
 * event — the same path the Rust side emits on.
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
  await nextFrames(page);
}

async function menuChecks(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(async () => {
    const ipc = await import("/src/ipc.ts" as string);
    return ipc.getMockMenuState()?.checks ?? {};
  });
}

async function savedSettings(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async () => {
    const ipc = await import("/src/ipc.ts" as string);
    return ipc.getSettings();
  });
}

test.describe("#74 preferences window", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
  });

  test("Cmd+, opens the modal with four tabs; Escape closes it", async ({
    page,
  }) => {
    await setDoc(page, "hello");
    await page.keyboard.press(`${MOD}+Comma`);
    const dialog = page.getByTestId("preferences");
    await expect(dialog).toBeVisible();
    for (const tab of ["general", "editor", "appearance", "images"]) {
      await expect(page.getByTestId(`pref-tab-${tab}`)).toBeVisible();
    }
    const tabs = ["general", "editor", "appearance", "images"];
    const onlyVisible = async (shown: string) => {
      for (const tab of tabs) {
        const panel = page.getByTestId(`pref-panel-${tab}`);
        if (tab === shown) await expect(panel).toBeVisible();
        else await expect(panel).toBeHidden();
      }
    };
    await onlyVisible("general");
    for (const tab of ["editor", "appearance", "images", "general"]) {
      await page.getByTestId(`pref-tab-${tab}`).click();
      await onlyVisible(tab);
    }
    await page.getByTestId("pref-tab-images").click();
    await expect(page.getByTestId("pref-upload-command")).toHaveText("未設定");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("editor preferences apply at once and survive a reload of the settings", async ({
    page,
  }) => {
    await menuAction(page, "app.preferences");
    await page.getByTestId("pref-tab-editor").click();

    await page.getByTestId("pref-font-size").fill("21");
    await expect(page.getByTestId("pref-font-size-value")).toHaveText("21 px");
    await page.getByTestId("pref-content-width").fill("960");
    const vars = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return [
        cs.getPropertyValue("--k-font-size").trim(),
        cs.getPropertyValue("--k-max-width").trim(),
      ];
    });
    expect(vars).toEqual(["21px", "960px"]);
    const lineFont = await page
      .locator(".cm-content")
      .evaluate((el) => getComputedStyle(el).fontSize);
    expect(lineFont).toBe("21px");

    await page.getByTestId("pref-code-line-numbers").check();
    await page.getByTestId("pref-auto-pair-brackets").uncheck();

    await expect
      .poll(() => savedSettings(page))
      .toMatchObject({
        fontSize: 21,
        contentWidth: 960,
        codeLineNumbers: true,
        autoPairBrackets: false,
      });
    await expect
      .poll(() => menuChecks(page))
      .toMatchObject({ "view.codeLineNumbers": true });

    // A fresh app reads them back (same mock settings file).
    await page.getByTestId("pref-close").click();
    await page.evaluate(async () => {
      const main = await import("/src/main.ts" as string);
      const app = main.getActiveApp();
      app.destroy();
      document.documentElement.removeAttribute("style");
      const fresh = main.createKalamosApp(document);
      await fresh.init();
      (window as unknown as { __freshApp: unknown }).__freshApp = fresh;
    });
    const restored = await page.evaluate(() => {
      const fresh = (
        window as unknown as {
          __freshApp: {
            editor: {
              isCodeLineNumbers(): boolean;
              isAutoPairBrackets(): boolean;
            };
          };
        }
      ).__freshApp;
      return {
        font: document.documentElement.style.getPropertyValue("--k-font-size"),
        width: document.documentElement.style.getPropertyValue("--k-max-width"),
        lines: fresh.editor.isCodeLineNumbers(),
        pairs: fresh.editor.isAutoPairBrackets(),
      };
    });
    expect(restored).toEqual({
      font: "21px",
      width: "960px",
      lines: true,
      pairs: false,
    });
  });

  test("appearance: theme select switches the theme and the menu marks it", async ({
    page,
  }) => {
    await menuAction(page, "app.preferences");
    await page.getByTestId("pref-tab-appearance").click();
    await page.getByTestId("pref-theme").selectOption("melan");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "melan");
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const ipc = await import("/src/ipc.ts" as string);
          return ipc.getMockMenuState()?.theme;
        }),
      )
      .toBe("melan");
    await expect
      .poll(() => savedSettings(page))
      .toMatchObject({ theme: "melan" });
  });

  test("general: autosave off is saved", async ({ page }) => {
    await page.keyboard.press(`${MOD}+Comma`);
    await page.getByTestId("pref-auto-save").uncheck();
    await page.getByTestId("pref-startup").selectOption("blank");
    await expect
      .poll(() => savedSettings(page))
      .toMatchObject({ autoSave: false, startupBehavior: "blank" });
  });
});

test.describe("#74 menu actions", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
  });

  test("view toggles run once and keep the check marks in sync with shortcuts", async ({
    page,
  }) => {
    await setDoc(page, "text");
    await menuAction(page, "view.focusMode");
    await expect
      .poll(() => menuChecks(page))
      .toMatchObject({ "view.focusMode": true });
    await page.waitForTimeout(250);
    await page.keyboard.press("F8");
    await expect
      .poll(() => menuChecks(page))
      .toMatchObject({ "view.focusMode": false });

    await page.keyboard.press(`${MOD}+Slash`);
    await expect
      .poll(() => menuChecks(page))
      .toMatchObject({ "view.sourceMode": true });
    // A menu click well after the key press (inside 500 ms it counts as the same press).
    await page.waitForTimeout(600);
    await menuAction(page, "view.sourceMode");
    await expect
      .poll(() => menuChecks(page))
      .toMatchObject({ "view.sourceMode": false });
  });

  test("a shortcut handled by the page is not repeated by the menu event", async ({
    page,
  }) => {
    await setDoc(page, "word");
    await selectRange(page, 0, 4);
    await page.keyboard.press(`${MOD}+b`);
    // WebKit hands the same key equivalent to the menu afterwards.
    await menuAction(page, "fmt.bold");
    expect(await getDoc(page)).toBe("**word**");
  });

  test("paragraph and format items edit the document", async ({ page }) => {
    await setDoc(page, "Title", 2);
    await menuAction(page, "para.heading1");
    expect(await getDoc(page)).toBe("# Title");
    await page.keyboard.press(`${MOD}+3`);
    expect(await getDoc(page)).toBe("### Title");
    await selectRange(page, 4, 9);
    await menuAction(page, "fmt.strike");
    expect(await getDoc(page)).toBe("### ~~Title~~");
  });

  test("編輯 > 尋找 opens the find panel and 在資料夾中尋找 the sidebar search", async ({
    page,
  }) => {
    await setDoc(page, "alpha beta");
    await menuAction(page, "edit.find");
    await expect(page.locator(".k-search").first()).toBeVisible();
    await menuAction(page, "edit.findInFolder");
    await expect(page.getByTestId("sidebar")).toHaveAttribute(
      "data-visible",
      "true",
    );
    await expect
      .poll(() => menuChecks(page))
      .toMatchObject({ "view.sidebar": true });
  });

  test("表格儲存格 keeps undo working (edit items stay predefined)", async ({
    page,
  }) => {
    await setDoc(page, "intro\n\n| a | b |\n| - | - |\n| c | d |\n\nend", 0);
    const cell = page
      .getByTestId("table-widget")
      .locator('[data-row="1"][data-col="0"] .k-table-cell-content');
    await cell.click();
    await page.keyboard.press("End");
    await page.keyboard.type("X");
    await expect(cell).toHaveText("cX");
    await page.keyboard.press(`${MOD}+z`);
    await expect(cell).toHaveText("c");
  });
});
