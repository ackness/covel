import { resolveI18nText } from "@covel/shared";
import i18n, { i18nReady } from "@/i18n";
import { localeRegistry } from "@/i18n/catalog-registry.js";
import { applyAppearance, applyColorScheme } from "@/lib/appearance.js";
import { getBuiltinThemes } from "@/theme-system/builtins.js";
import { syncThemeStyles } from "@/theme-system/runtime.js";
import { resolveThemeSelection } from "@/theme-system/selection.js";

const themeSelect =
  document.querySelector<HTMLSelectElement>("#showcase-theme")!;
const localeSelect =
  document.querySelector<HTMLSelectElement>("#showcase-locale")!;
const sampleLocale =
  document.querySelector<HTMLSelectElement>("#sample-locale")!;
const schemeButtons =
  document.querySelectorAll<HTMLButtonElement>("[data-scheme-btn]");
const schemeHint = document.querySelector<HTMLElement>("#scheme-locked-hint")!;
const themeExamples =
  document.querySelectorAll<HTMLButtonElement>("[data-apply-theme]");
const swatches = document.querySelector<HTMLElement>("#swatch-grid")!;
const tokenList = document.querySelector<HTMLElement>("#token-list")!;
const root = document.documentElement;

const sharedLabels: Record<string, string> = {
  theme: "appearance.styleTitle",
  language: "onboarding.language",
  light: "settings.themeScheme.light",
  dark: "settings.themeScheme.dark",
  continue: "onboarding.continue",
  enter: "session.enter",
  actionPlaceholder: "session.inputPlaceholder",
  storyInput: "session.inputAriaLabel",
  send: "catalog.candidateList.send",
  you: "interaction.playerLabel",
  world: "nav.world",
  game: "nav.session",
  debug: "nav.debug",
  previewNavigation: "nav.primary",
  characters: "session.characters",
  images: "mediaLibrary.kind.image",
  provider: "settings.providerLabel",
  gallery: "world.gallery",
  open: "catalog.mediaGallery.open",
  download: "catalog.mediaGallery.download",
  rerun: "catalog.jobList.rerun",
  done: "session.jobStatus.done",
  pending: "session.jobStatus.pending",
  appearance: "settings.appearanceNavLabel",
  importTheme: "appearance.importTheme",
  providers: "settings.providerConnections",
  parameters: "settings.llmAdvanced",
  plugins: "settings.groupPlugins",
  data: "settings.groupData",
  trace: "debugger.title",
  traces: "debugger.traces",
  saveData: "debugger.sessionData",
  cost: "debugger.cost.tab",
  builtIn: "session.storage.builtIn",
};

const swatchTokens = [
  "--surface-page",
  "--surface-rail",
  "--surface-inset",
  "--surface-elevated",
  "--color-foreground",
  "--color-muted-foreground",
  "--rule-color",
  "--rule-strong-color",
  "--accent-primary",
  "--accent-secondary",
  "--accent-warning",
  "--accent-success",
  "--accent-danger",
];
const referenceTokens = [
  ...swatchTokens,
  "--rule-style",
  "--type-display",
  "--type-body",
  "--type-mono",
  "--ambience-image",
  "--noise-opacity",
  "--radius-card",
  "--radius-control",
  "--radius-dialog",
  "--ui-gap-label",
  "--ui-gap-inline",
  "--ui-gap-field",
  "--ui-gap-group",
  "--ui-gap-section",
  "--ui-gutter",
  "--ui-control-compact",
  "--ui-control-standard",
  "--ui-control-touch",
];

function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(`covel-showcase:${key}`);
  } catch {
    return null;
  }
}

function savePreference(key: string, value: string): void {
  try {
    localStorage.setItem(`covel-showcase:${key}`, value);
  } catch {}
}

function translate(key: string) {
  return i18n.t(sharedLabels[key] ?? `designShowcase.${key}`);
}

function applyTheme(id: string, requestedScheme: string | null) {
  const { theme, scheme } = resolveThemeSelection(
    getBuiltinThemes(),
    id,
    requestedScheme,
  );
  if (!theme) return;
  applyAppearance(theme.id);
  applyColorScheme(scheme);
  themeSelect.value = theme.id;
  for (const button of schemeButtons) {
    button.disabled = !theme.schemes.some(
      (entry) => entry === button.dataset.schemeBtn,
    );
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.schemeBtn === scheme),
    );
  }
  for (const button of themeExamples) {
    const selected = button.dataset.applyTheme === theme.id;
    button.setAttribute("aria-pressed", String(selected));
    button.textContent = translate(selected ? "current" : "apply");
    button.closest<HTMLElement>(".ui-band")!.dataset.tone = selected
      ? ""
      : "muted";
  }
  schemeHint.hidden = theme.schemes.length !== 1;
  schemeHint.textContent =
    theme.schemes.length === 1 ? translate(`${scheme}Only`) : "";
  savePreference("theme", theme.id);
  savePreference("scheme", scheme);
}

function updateTokenValues() {
  const style = getComputedStyle(root);
  for (const value of tokenList.querySelectorAll<HTMLElement>("[data-token]")) {
    const token = value.dataset.token!;
    const labelKey = `appearance.tokenEditor.tokens.${token}.label`;
    const raw = style.getPropertyValue(token).trim();
    const label = i18n.exists(labelKey) ? i18n.t(labelKey) : "";
    value.textContent =
      label || (raw.length > 56 ? `${raw.slice(0, 56)}…` : raw);
    value.title = raw;
  }
}

function renderLocale(locale: string) {
  root.lang = locale;
  localeSelect.value = locale;
  sampleLocale.value = locale;
  themeSelect.replaceChildren(
    ...getBuiltinThemes().map(
      ({ id, label }) => new Option(resolveI18nText(label, locale) ?? id, id),
    ),
  );
  for (const element of document.querySelectorAll<HTMLElement>("[data-copy]")) {
    element.textContent = translate(element.dataset.copy!);
  }
  for (const element of document.querySelectorAll<HTMLElement>(
    "[data-copy-label]",
  )) {
    element.setAttribute("aria-label", translate(element.dataset.copyLabel!));
  }
  for (const input of document.querySelectorAll<HTMLInputElement>(
    "[data-copy-placeholder]",
  )) {
    input.placeholder = translate(input.dataset.copyPlaceholder!);
  }
  document.title = `Covel · ${translate("pageTitle")}`;
  applyTheme(root.dataset.theme!, root.dataset.scheme!);
  updateTokenValues();
}

swatches.innerHTML = swatchTokens
  .map(
    (token) =>
      `<div class="swatch"><div class="swatch-chip" style="background:var(${token})"></div><code class="swatch-token">${token}</code></div>`,
  )
  .join("");
tokenList.innerHTML = referenceTokens
  .map(
    (token) =>
      `<div class="token-entry"><code class="key">${token}</code><span class="val" data-token="${token}"></span></div>`,
  )
  .join("");
for (const select of [localeSelect, sampleLocale]) {
  select.replaceChildren(
    ...localeRegistry.definitions.map(
      ({ code }) =>
        new Option(
          new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code,
          code,
        ),
    ),
  );
  select.addEventListener("change", () => {
    savePreference("locale", select.value);
    void i18n.changeLanguage(select.value);
  });
}

await i18nReady;
const savedLocale = localeRegistry.match(readPreference("locale") ?? "")?.code;
if (savedLocale) await i18n.changeLanguage(savedLocale);
syncThemeStyles(getBuiltinThemes());
applyTheme(readPreference("theme") ?? "paper", readPreference("scheme"));
renderLocale(i18n.language);
i18n.on("languageChanged", renderLocale);

themeSelect.addEventListener("change", () => {
  applyTheme(themeSelect.value, root.dataset.scheme!);
  updateTokenValues();
});
for (const button of schemeButtons) {
  button.addEventListener("click", () => {
    applyTheme(themeSelect.value, button.dataset.schemeBtn!);
    updateTokenValues();
  });
}
for (const button of themeExamples) {
  button.addEventListener("click", () => {
    applyTheme(button.dataset.applyTheme!, root.dataset.scheme!);
    updateTokenValues();
  });
}
