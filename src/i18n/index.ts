import en from "./locales/en.json";
import zhTW from "./locales/zh-TW.json";

export const UI_LOCALES = ["zh-TW", "en"] as const;
export type UiLocale = (typeof UI_LOCALES)[number];
export const DEFAULT_UI_LOCALE: UiLocale = "zh-TW";

export type MessageKey = keyof typeof zhTW;
export type MessageValues = Record<string, string | number | undefined>;

const DICTIONARIES: Record<UiLocale, Record<string, string>> = {
  "zh-TW": zhTW,
  en,
};

let activeLocale: UiLocale = DEFAULT_UI_LOCALE;

export function parseUiLocale(locale: unknown): UiLocale | undefined {
  if (locale === "zh-TW" || locale === "en") return locale;
  return undefined;
}

export function normalizeUiLocale(
  locale: unknown,
  fallback: UiLocale = DEFAULT_UI_LOCALE,
): UiLocale {
  return parseUiLocale(locale) ?? fallback;
}

/**
 * Default UI language for a system locale tag when the user has not saved one:
 * any Chinese tag (`zh`, `zh-TW`, `zh-Hant-TW`, `zh_CN.UTF-8`, …) uses `zh-TW`;
 * all other or unknown tags use `en`.
 */
export function defaultUiLocaleForTag(
  tag: string | null | undefined,
): UiLocale {
  if (!tag) return "en";
  const lower = tag.trim().toLowerCase();
  if (
    lower === "zh" ||
    lower.startsWith("zh-") ||
    lower.startsWith("zh_") ||
    lower.startsWith("zh.")
  ) {
    return "zh-TW";
  }
  return "en";
}

export function hasMessageKey(key: string): key is MessageKey {
  return Object.hasOwn(zhTW, key);
}

export function getUiLocale(): UiLocale {
  return activeLocale;
}

export function initUiLocale(locale: UiLocale): void {
  activeLocale = normalizeUiLocale(locale);
}

function warnMissingKey(key: string, locale: UiLocale): void {
  if (import.meta.env?.DEV) {
    console.warn(
      `[i18n] Missing translation key "${key}" for locale "${locale}"`,
    );
  }
}

/**
 * Looks up a flat dictionary key for the active UI locale and interpolates
 * `{{var}}` placeholders in a single pass (values are never re-parsed).
 *
 * IMPORTANT (equivalent to `escapeValue: false`): this function does NOT
 * HTML-escape interpolated values or templates. The returned string is plain
 * text and must only be written to `textContent` or DOM attributes, or
 * explicitly passed through `escapeHtml()` before inserting into HTML strings.
 */
export function t(key: MessageKey, values?: MessageValues): string {
  const dict = DICTIONARIES[activeLocale];
  let template: string | undefined;
  if (Object.hasOwn(dict, key)) {
    template = dict[key];
  } else {
    warnMissingKey(key, activeLocale);
    if (activeLocale !== DEFAULT_UI_LOCALE && Object.hasOwn(zhTW, key)) {
      template = zhTW[key];
    }
  }
  if (template === undefined) {
    return key;
  }
  if (!values) {
    return template;
  }
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => {
    if (!Object.hasOwn(values, name)) return match;
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}
