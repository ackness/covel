import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initDesktopI18n,
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

setDesktopLocaleFromSettings({ "ui.locale": "en-US" });
setDesktopLocaleFromSettings({ ui: { locale: "ru-RU" } });
assert.equal(t("menu.file"), "File");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-i18n-"));
try {
  const file = path.join(home, "settings.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ entries: { ui: { locale: "ru-RU" } } }),
  );
  assert.equal(initDesktopI18n(file, "zh-CN"), "zh-CN");
  fs.writeFileSync(file, JSON.stringify({ entries: { "ui.locale": "ru-RU" } }));
  assert.equal(initDesktopI18n(file, "zh-CN"), "ru-RU");
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
