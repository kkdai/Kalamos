import { createInstance, type TOptions } from "i18next";
import en from "./locales/en.json";
import zhTW from "./locales/zh-TW.json";

export const UI_LOCALES = ["zh-TW", "en"] as const;
export type UiLocale = (typeof UI_LOCALES)[number];
export const DEFAULT_UI_LOCALE: UiLocale = "zh-TW";

const messages = createInstance();
void messages.init({
  lng: DEFAULT_UI_LOCALE,
  fallbackLng: DEFAULT_UI_LOCALE,
  supportedLngs: [...UI_LOCALES],
  load: "currentOnly",
  resources: { "zh-TW": { translation: zhTW }, en: { translation: en } },
  initAsync: false,
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false, skipOnVariables: true },
});

export function normalizeUiLocale(locale: unknown): UiLocale {
  return locale === "en" ? "en" : DEFAULT_UI_LOCALE;
}

export function getUiLocale(): UiLocale {
  return normalizeUiLocale(messages.language);
}

export async function initUiLocale(locale: UiLocale): Promise<void> {
  if (locale !== getUiLocale()) await messages.changeLanguage(locale);
}

export function t(key: string, values: TOptions = {}): string {
  return messages.t(key, values);
}
