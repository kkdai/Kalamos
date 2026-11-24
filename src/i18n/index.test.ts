import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  getActiveUiLocale,
  getSettings,
  resetMockState,
  seedMockSettings,
  setSettings,
  setUiLocale,
} from "../ipc";
import { DEFAULT_UI_LOCALE, getUiLocale, initUiLocale, t } from ".";
import en from "./locales/en.json";
import zhTW from "./locales/zh-TW.json";

function placeholders(message: string): string[] {
  return [...message.matchAll(/{{\s*(\w+)\s*}}/g)].map((m) => m[1]).sort();
}

afterEach(async () => {
  resetMockState();
  await initUiLocale(DEFAULT_UI_LOCALE);
});

describe("interface language", () => {
  it("ships the same nonempty keys and interpolation fields in both dictionaries", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhTW).sort());
    for (const key of Object.keys(zhTW) as (keyof typeof zhTW)[]) {
      expect(zhTW[key].trim(), key).not.toBe("");
      expect(en[key].trim(), key).not.toBe("");
      expect(placeholders(en[key]), key).toEqual(placeholders(zhTW[key]));
    }
  });

  it("uses the selected locale and keeps file names as literal text", async () => {
    expect(getUiLocale()).toBe("zh-TW");
    expect(t("prefs.title")).toBe("偏好設定");
    await initUiLocale("en");
    expect(t("prefs.title")).toBe("Preferences");
    expect(
      t("app.confirmCloseTab", { label: "$t(prefs.title) & 報告.md" }),
    ).toBe(
      "“$t(prefs.title) & 報告.md” has unsaved changes. Save before closing?",
    );
  });

  it("keeps saved and active UI locale separate and protects it from stale settings writes", async () => {
    seedMockSettings({
      ...DEFAULT_SETTINGS,
      uiLocale: undefined,
      fontSize: 23,
    });
    expect(await getActiveUiLocale()).toBe("zh-TW");
    const stale = await getSettings();
    await setUiLocale("en");
    expect(await getSettings()).toMatchObject({ uiLocale: "en", fontSize: 23 });
    await setSettings({ ...stale, fontSize: 25 });
    expect(await getSettings()).toMatchObject({ uiLocale: "en", fontSize: 25 });
    expect(await getActiveUiLocale()).toBe("zh-TW");
  });
});
