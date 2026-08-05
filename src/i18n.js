import { en } from "./i18n/en.js";
import { nl } from "./i18n/nl.js";

export const DEFAULT_LANGUAGE = "nl";
export const SUPPORTED_LANGUAGES = Object.freeze(["nl", "en"]);
export const TRANSLATIONS = Object.freeze({ nl, en });

let currentLanguage = DEFAULT_LANGUAGE;

export function setLanguage(language) {
  currentLanguage = SUPPORTED_LANGUAGES.includes(language) ? language : DEFAULT_LANGUAGE;
  return currentLanguage;
}

export function getLanguage() {
  return currentLanguage;
}

export function localeFor(language = currentLanguage) {
  return language === "en" ? "en-GB" : "nl-BE";
}

function interpolate(value, parameters) {
  return value.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
    Object.hasOwn(parameters, name) ? String(parameters[name]) : match
  ));
}

export function t(key, parameters = {}, language = currentLanguage) {
  const supportedLanguage = SUPPORTED_LANGUAGES.includes(language) ? language : DEFAULT_LANGUAGE;
  let value = TRANSLATIONS[supportedLanguage][key] ?? TRANSLATIONS[DEFAULT_LANGUAGE][key] ?? key;
  if (typeof value === "object") {
    const pluralCategory = new Intl.PluralRules(localeFor(supportedLanguage)).select(Number(parameters.count));
    value = value[pluralCategory] ?? value.other;
  }
  return interpolate(value, parameters);
}

export function formatScore(value, language = currentLanguage) {
  if (value === 9999) return t("score.noScore", {}, language);
  if (!Number.isFinite(value)) return t("value.notAvailable", {}, language);
  return new Intl.NumberFormat(localeFor(language), {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatNumber(value, maximumFractionDigits = 2, language = currentLanguage) {
  if (!Number.isFinite(value)) return t("value.notAvailable", {}, language);
  return new Intl.NumberFormat(localeFor(language), {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(value);
}

export function formatDate(value, language = currentLanguage) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return t("value.notAvailable", {}, language);
  return new Intl.DateTimeFormat(localeFor(language), {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function applyDocumentTranslations(root = document) {
  root.documentElement.lang = currentLanguage;
  root.title = t("document.title");
  const description = root.querySelector('meta[name="description"]');
  if (description) description.setAttribute("content", t("document.description"));
  root.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  const translatedAttributes = [
    ["i18nAriaLabel", "aria-label"],
    ["i18nPlaceholder", "placeholder"],
    ["i18nTitle", "title"],
  ];
  translatedAttributes.forEach(([datasetKey, attribute]) => {
    root.querySelectorAll(`[data-${datasetKey.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}]`).forEach((element) => {
      element.setAttribute(attribute, t(element.dataset[datasetKey]));
    });
  });
}
