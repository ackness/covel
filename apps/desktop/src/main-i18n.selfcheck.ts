import assert from "node:assert/strict";
import {
  normalizeDesktopLocale,
  setDesktopLocaleFromSettings,
  t,
} from "./main-i18n.js";

assert.equal(normalizeDesktopLocale("ru-BY"), "ru-RU");
assert.equal(normalizeDesktopLocale("ru_UA"), "ru-RU");
assert.equal(normalizeDesktopLocale("en-GB"), "en-US");
assert.equal(normalizeDesktopLocale("zh-Hans"), "zh-CN");
assert.equal(normalizeDesktopLocale("zh-TW"), "zh-TW");
assert.equal(normalizeDesktopLocale("zh-Hant-TW"), "zh-Hant-TW");
assert.equal(normalizeDesktopLocale("../../etc/passwd"), null);

setDesktopLocaleFromSettings({ "ui.locale": "ru-BY" });
assert.equal(t("menu.file"), "Файл");

setDesktopLocaleFromSettings({ "ui.locale": "zh-TW" });
assert.equal(t("menu.file"), "File");

console.log("main-i18n selfcheck: OK");
