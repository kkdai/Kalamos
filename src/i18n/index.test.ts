import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  getActiveUiLocale,
  getSettings,
  resetMockState,
  seedMockSettings,
  setMockSystemLocale,
  setSettings,
  setUiLocale,
} from "../ipc";
import {
  DEFAULT_UI_LOCALE,
  defaultUiLocaleForTag,
  getUiLocale,
  initUiLocale,
  type MessageKey,
  t,
} from ".";
import en from "./locales/en.json";
import zhTW from "./locales/zh-TW.json";

function placeholders(message: string): string[] {
  return [...message.matchAll(/{{\s*(\w+)\s*}}/g)].map((m) => m[1]).sort();
}

afterEach(() => {
  vi.restoreAllMocks();
  resetMockState();
  initUiLocale(DEFAULT_UI_LOCALE);
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

  it("uses the selected locale and keeps file names as literal text", () => {
    expect(getUiLocale()).toBe("zh-TW");
    expect(t("prefs.title")).toBe("偏好設定");
    initUiLocale("en");
    expect(t("prefs.title")).toBe("Preferences");
    expect(
      t("app.confirmCloseTab", {
        label: "$t(prefs.title) & {{other}} & $& 報告.md",
      }),
    ).toBe(
      "“$t(prefs.title) & {{other}} & $& 報告.md” has unsaved changes. Save before closing?",
    );
  });

  it("falls back to zh-TW and warns in dev when a key is missing in the active locale", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    initUiLocale("en");
    const enDict = en as Record<string, string | undefined>;
    const saved = enDict["prefs.title"];
    delete enDict["prefs.title"];
    try {
      expect(t("prefs.title")).toBe("偏好設定");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      enDict["prefs.title"] = saved;
    }

    expect(t("missing.runtime.key" as MessageKey)).toBe("missing.runtime.key");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("maps system locale tags to zh-TW for zh* and en for all others", () => {
    for (const tag of [
      "zh",
      "zh-TW",
      "zh-Hant",
      "zh-Hant-TW",
      "zh-CN",
      "zh_HK.UTF-8",
      "ZH-tw",
    ]) {
      expect(defaultUiLocaleForTag(tag), tag).toBe("zh-TW");
    }
    for (const tag of ["en", "en-US", "ja", "ja-JP", "ko-KR", "fr", "", null]) {
      expect(defaultUiLocaleForTag(tag), String(tag)).toBe("en");
    }
  });

  it("follows system locale when uiLocale is unset and respects saved uiLocale", async () => {
    setMockSystemLocale("en-US");
    expect(await getActiveUiLocale()).toBe("en");

    setMockSystemLocale("zh-Hant-TW");
    expect(await getActiveUiLocale()).toBe("zh-TW");

    setMockSystemLocale("ja-JP");
    expect(await getActiveUiLocale()).toBe("en");

    seedMockSettings({ ...DEFAULT_SETTINGS, uiLocale: "zh-TW" });
    setMockSystemLocale("en-US");
    expect(await getActiveUiLocale()).toBe("zh-TW");
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
