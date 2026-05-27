import { defaultLocale, type Locale } from "./config";

export const normalizeLocale = (value?: string | null): Locale | null => {
  if (!value) {
    return null;
  }
  const lower = value.toLowerCase();
  if (lower === "en") {
    return "en";
  }
  if (lower === "zh" || lower === "zh-cn") {
    return "zh-CN";
  }
  return null;
};

export const isLocale = (value?: string | null): value is Locale =>
  normalizeLocale(value) !== null;

export const getLocaleFromAcceptLanguage = (header?: string | null): Locale => {
  if (!header) {
    return defaultLocale;
  }
  const lower = header.toLowerCase();
  if (lower.includes("zh")) {
    return "zh-CN";
  }
  return "en";
};
