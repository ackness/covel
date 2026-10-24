import { LanguagePicker } from "./LanguagePicker.js";
import { useEffect, useState } from "react";
import { Menu, Moon, Sun, X } from "lucide-react";
import { type Lang, type Copy } from "../copy.js";
import { asset, DOCS_URL } from "../links.js";
import { container } from "./ui.js";

type Theme = "light" | "dark";
const THEME_KEY = "covel-site:theme";

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function Header({
  copy,
  lang,
  onSelectLang,
}: {
  copy: Copy;
  lang: Lang;
  onSelectLang: (lang: Lang) => void;
}) {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [active, setActive] = useState("top");

  useEffect(() => {
    const update = () => {
      const sections = [
        "top",
        "features",
        "plugins",
        "create",
        "worlds",
        "downloads",
      ];
      const current = sections
        .filter((id) => {
          const section = document.getElementById(id);
          return section && section.getBoundingClientRect().top <= 160;
        })
        .at(-1);
      setActive(current ?? "top");
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Not remembered; the page still switches.
    }
    setTheme(next);
  };

  const links = [
    { href: "#features", label: copy.nav.features },
    { href: "#plugins", label: copy.nav.plugins },
    { href: "#create", label: copy.nav.create },
    { href: "#worlds", label: copy.nav.worlds },
    { href: "#downloads", label: copy.nav.download },
  ];

  const iconButton =
    "inline-flex h-9 min-w-9 items-center justify-center rounded-full px-2 text-sm text-muted transition hover:bg-ink/5 hover:text-ink";

  return (
    <header
      className={`sticky top-0 z-40 transition-colors ${
        scrolled || menuOpen
          ? "border-b border-line bg-page/80 backdrop-blur-xl"
          : "border-b border-transparent"
      }`}
    >
      <div className={`${container} flex h-16 items-center gap-2 sm:gap-6`}>
        <a href="#top" className="flex shrink-0 items-center gap-2.5">
          <img src={asset("icon.png")} alt="" className="h-7 w-7 rounded-lg" />
          <span className="font-display text-xl font-semibold tracking-tight">
            Covel
          </span>
        </a>
        <nav className="hidden items-center gap-1 lg:flex" aria-label="Main">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              aria-current={
                active === link.href.slice(1) ? "location" : undefined
              }
              className="rounded-full px-3 py-1.5 text-sm text-muted transition hover:text-ink aria-[current=location]:bg-ink/5 aria-[current=location]:text-accent"
            >
              {link.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <LanguagePicker
            lang={lang}
            label={copy.nav.languageLabel}
            onSelect={onSelectLang}
          />
          <button
            type="button"
            onClick={toggleTheme}
            className={iconButton}
            aria-label={theme === "dark" ? copy.nav.toLight : copy.nav.toDark}
          >
            {theme === "dark" ? (
              <Sun className="h-4 w-4" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
          </button>
          <a
            href={`${DOCS_URL}${copy.meta.docsPath}`}
            className="ml-2 hidden h-9 items-center rounded-full border border-line px-4 text-sm font-medium transition hover:bg-ink/5 sm:inline-flex"
          >
            {copy.nav.docs}
          </a>
          <button
            type="button"
            className={`${iconButton} lg:hidden`}
            aria-label={copy.nav.menu}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? (
              <X className="h-5 w-5" />
            ) : (
              <Menu className="h-5 w-5" />
            )}
          </button>
        </div>
      </div>
      {!menuOpen && (
        <nav
          aria-label={copy.nav.quick}
          className="flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden border-t border-line px-4 py-2 lg:hidden"
        >
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              aria-current={
                active === link.href.slice(1) ? "location" : undefined
              }
              className="shrink-0 rounded-full px-3 py-2 text-xs text-muted transition hover:text-ink aria-[current=location]:bg-ink/5 aria-[current=location]:text-accent"
            >
              {link.label}
            </a>
          ))}
        </nav>
      )}
      {menuOpen ? (
        <nav
          className={`${container} flex flex-col pb-4 lg:hidden`}
          aria-label="Main"
        >
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              onClick={() => setMenuOpen(false)}
              className="border-b border-line py-3 text-base"
            >
              {link.label}
            </a>
          ))}
          <a
            href={`${DOCS_URL}${copy.meta.docsPath}`}
            onClick={() => setMenuOpen(false)}
            className="py-3 text-base text-accent"
          >
            {copy.nav.docs}
          </a>
        </nav>
      ) : null}
    </header>
  );
}
