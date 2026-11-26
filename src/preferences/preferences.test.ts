import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_UI_LOCALE, initUiLocale, t, type UiLocale } from "../i18n";
import {
  createPreferences,
  type PreferencesHost,
  type PreferencesValues,
} from "./preferences";

function makeValues(
  overrides: Partial<PreferencesValues> = {},
): PreferencesValues {
  return {
    uiLocale: "zh-TW",
    startupBehavior: "restoreFolder",
    autoSave: true,
    autoCheckUpdates: true,
    fontSize: 17,
    contentWidth: 720,
    autoPairBrackets: true,
    autoPairMarkdown: false,
    codeLineNumbers: false,
    mathAutoNumber: false,
    theme: "papyros",
    systemDarkTheme: "melan",
    imageRootDir: null,
    uploadOnInsert: false,
    uploadCommand: null,
    uploadArgs: [],
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("preferences language notice", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    initUiLocale(DEFAULT_UI_LOCALE);
    vi.restoreAllMocks();
  });

  it("keeps the save error notice across subsequent sync() calls until cleared", async () => {
    const values = makeValues();
    let shouldFail = true;
    const host: PreferencesHost = {
      getValues: () => ({ ...values }),
      getThemes: () => [{ id: "papyros", label: "Papyros" }],
      applyChange: () => {},
      saveUiLocale: async (locale: UiLocale) => {
        if (shouldFail) throw new Error("disk full");
        values.uiLocale = locale;
      },
      restartApp: async () => {},
      pickImageRootDir: async () => null,
      clearImageRootDir: async () => null,
      openThemesDir: async () => null,
    };

    const prefs = createPreferences(host, document);
    try {
      await prefs.open("general");
      const select = document.querySelector<HTMLSelectElement>(
        '[data-testid="pref-language"]',
      )!;
      const notice = document.querySelector<HTMLElement>(
        "#k-pref-language-notice",
      )!;
      const dialog = document.querySelector<HTMLDialogElement>(
        "dialog.k-pref-restart",
      )!;
      dialog.showModal = vi.fn();

      select.value = "en";
      select.dispatchEvent(new Event("change"));
      await flushMicrotasks();

      expect(select.value).toBe("zh-TW");
      expect(notice.textContent).toBe(t("prefs.languageSaveError"));

      // A follow-up sync (e.g. from scheduleMenuSync after refresh or another control)
      // must not wipe the save failure notice.
      prefs.sync();
      expect(select.value).toBe("zh-TW");
      expect(notice.textContent).toBe(t("prefs.languageSaveError"));

      // Succeeding on retry replaces the error with the restart hint.
      shouldFail = false;
      select.value = "en";
      select.dispatchEvent(new Event("change"));
      await flushMicrotasks();

      expect(select.value).toBe("en");
      expect(notice.textContent).toBe(t("prefs.languageOnRestart"));
      expect(dialog.showModal).toHaveBeenCalledTimes(1);

      // Closing and reopening starts with a clean notice state.
      prefs.close();
      await prefs.open("general");
      const reopenedNotice = document.querySelector<HTMLElement>(
        "#k-pref-language-notice",
      )!;
      expect(reopenedNotice.textContent).toBe(t("prefs.languageOnRestart"));
    } finally {
      prefs.destroy();
    }
  });

  it("keeps the restart failure notice across subsequent sync() calls", async () => {
    const values = makeValues({ uiLocale: "en" });
    const host: PreferencesHost = {
      getValues: () => ({ ...values }),
      getThemes: () => [{ id: "papyros", label: "Papyros" }],
      applyChange: () => {},
      saveUiLocale: async (locale: UiLocale) => {
        values.uiLocale = locale;
      },
      restartApp: async () => {
        throw new Error("restart failed");
      },
      pickImageRootDir: async () => null,
      clearImageRootDir: async () => null,
      openThemesDir: async () => null,
    };

    const prefs = createPreferences(host, document);
    try {
      await prefs.open("general");
      const select = document.querySelector<HTMLSelectElement>(
        '[data-testid="pref-language"]',
      )!;
      const notice = document.querySelector<HTMLElement>(
        "#k-pref-language-notice",
      )!;
      const prompt = document.querySelector<HTMLDialogElement>(
        "dialog.k-pref-restart",
      )!;

      prompt.returnValue = "restart";
      prompt.dispatchEvent(new Event("close"));
      await flushMicrotasks();

      expect(notice.textContent).toBe(t("prefs.restartFailed"));

      prefs.sync();
      expect(notice.textContent).toBe(t("prefs.restartFailed"));

      // Changing the language back clears the restart error.
      select.value = "zh-TW";
      select.dispatchEvent(new Event("change"));
      await flushMicrotasks();

      expect(select.value).toBe("zh-TW");
      expect(notice.textContent).toBe("");
    } finally {
      prefs.destroy();
    }
  });

  it("does not overwrite the select while saveUiLocale is in flight", async () => {
    const values = makeValues();
    let resolveSave!: () => void;
    const host: PreferencesHost = {
      getValues: () => ({ ...values }),
      getThemes: () => [{ id: "papyros", label: "Papyros" }],
      applyChange: () => {},
      saveUiLocale: (locale: UiLocale) =>
        new Promise<void>((resolve) => {
          resolveSave = () => {
            values.uiLocale = locale;
            resolve();
          };
        }),
      restartApp: async () => {},
      pickImageRootDir: async () => null,
      clearImageRootDir: async () => null,
      openThemesDir: async () => null,
    };

    const prefs = createPreferences(host, document);
    try {
      await prefs.open("general");
      const select = document.querySelector<HTMLSelectElement>(
        '[data-testid="pref-language"]',
      )!;
      const dialog = document.querySelector<HTMLDialogElement>(
        "dialog.k-pref-restart",
      )!;
      dialog.showModal = vi.fn();

      select.value = "en";
      select.dispatchEvent(new Event("change"));
      expect(select.disabled).toBe(true);

      prefs.sync();
      expect(select.value).toBe("en");

      resolveSave();
      await flushMicrotasks();

      expect(select.disabled).toBe(false);
      expect(select.value).toBe("en");
    } finally {
      prefs.destroy();
    }
  });

  it("lets the user choose Melan or Nyx for the system dark theme in Appearance", async () => {
    const values = makeValues({ theme: "system", systemDarkTheme: "melan" });
    const applyChange = vi.fn();
    const host: PreferencesHost = {
      getValues: () => ({ ...values }),
      getThemes: () => [
        { id: "system", label: "跟隨系統" },
        { id: "papyros", label: "Papyros（莎草紙）" },
        { id: "melan", label: "Melan（墨）" },
        { id: "nyx", label: "Nyx（夜）" },
      ],
      applyChange,
      saveUiLocale: async () => {},
      restartApp: async () => {},
      pickImageRootDir: async () => null,
      clearImageRootDir: async () => null,
      openThemesDir: async () => null,
    };

    const prefs = createPreferences(host, document);
    try {
      await prefs.open("appearance");
      const darkSelect = document.querySelector<HTMLSelectElement>(
        '[data-testid="pref-system-dark-theme"]',
      )!;
      expect(darkSelect).not.toBeNull();
      expect(darkSelect.value).toBe("melan");
      expect(Array.from(darkSelect.options).map((o) => o.value)).toEqual([
        "melan",
        "nyx",
      ]);

      darkSelect.value = "nyx";
      darkSelect.dispatchEvent(new Event("change"));
      expect(applyChange).toHaveBeenCalledWith({ systemDarkTheme: "nyx" });
    } finally {
      prefs.destroy();
    }
  });
});
