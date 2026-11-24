import { expect, type Page, test } from "@playwright/test";
import type { UiLocale } from "../../src/i18n";
import { boot, getDoc, MOD, newPlatformContext, setDoc } from "./helpers";

// The browser IPC mock is in memory. Carry only its saved locale into the
// next page load so the real App bootstrap exercises a fresh startup.
async function bootWithSavedLocale(page: Page, locale: UiLocale) {
  await page.route(
    "**/src/main.ts",
    async (route) => {
      const response = await route.fetch();
      const seed = `import { seedMockSettings as seedLocale } from '/src/ipc.ts';\nseedLocale({ uiLocale: ${JSON.stringify(locale)} });\n`;
      await route.fulfill({ response, body: seed + (await response.text()) });
    },
    { times: 1 },
  );
  await boot(page);
}

function savedLocale(page: Page): Promise<UiLocale> {
  return page.evaluate(async () => {
    const ipc = await import("/src/ipc.ts" as string);
    return (await ipc.getSettings()).uiLocale;
  });
}

for (const platform of ["macos", "windows"] as const) {
  test(`applies a saved language on next launch (${platform})`, async ({
    browser,
  }) => {
    const context = await newPlatformContext(browser, platform);
    const page = await context.newPage();
    try {
      await boot(page);
      await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW");
      const text = "# 未儲存 draft\n\nHello";
      await setDoc(page, text, text.length);
      await page.keyboard.insertText("!");
      await expect.poll(() => getDoc(page)).toBe(`${text}!`);
      await page.keyboard.press(`${MOD}+Comma`);
      const dialog = page.getByRole("dialog", { name: "偏好設定" });
      const language = dialog.getByLabel("介面語言");
      await expect(language).toHaveValue("zh-TW");
      await language.selectOption("en");
      await expect(dialog.getByRole("status")).toHaveText(
        "下次開啟 Kalamos 時生效。",
      );
      expect(await savedLocale(page)).toBe("en");
      expect(await getDoc(page)).toBe(`${text}!`);
      await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW");

      await bootWithSavedLocale(page, await savedLocale(page));
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expect(
        page.getByRole("main", { name: "Markdown Editor" }),
      ).toBeVisible();
      await page.keyboard.press(`${MOD}+Comma`);
      const englishDialog = page.getByRole("dialog", { name: "Preferences" });
      await expect(
        englishDialog.getByRole("tab", { name: "General" }),
      ).toBeVisible();
      await expect(englishDialog.getByLabel("Interface language")).toHaveValue(
        "en",
      );
      await englishDialog
        .getByLabel("Interface language")
        .selectOption("zh-TW");
      await expect(englishDialog.getByRole("status")).toHaveText(
        "Takes effect the next time you open Kalamos.",
      );
      expect(await savedLocale(page)).toBe("zh-TW");
      await bootWithSavedLocale(page, await savedLocale(page));
      await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW");
    } finally {
      await context.close();
    }
  });
}

test("restores the saved selection if writing the language fails", async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(async () => {
    const ipc = await import("/src/ipc.ts" as string);
    ipc.setMockSettingsWriteError(new Error("disk full"));
  });
  await page.keyboard.press(`${MOD}+Comma`);
  const dialog = page.getByRole("dialog", { name: "偏好設定" });
  const language = dialog.getByLabel("介面語言");
  await language.selectOption("en");
  await expect(dialog.getByRole("status")).toHaveText(
    "無法儲存介面語言，請再試一次。",
  );
  await expect(language).toHaveValue("zh-TW");
  expect(await savedLocale(page)).toBe("zh-TW");
});
