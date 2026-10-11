import { useEffect, useState } from "react";
import { Menu, Moon, Sun, X } from "lucide-react";
import type { Copy } from "../copy.js";
import { RELEASES_URL } from "../links.js";
import { container } from "./ui.js";

type Theme = "light" | "dark";
const THEME_KEY = "covel-site:theme";

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function Header({
  copy,
  onToggleLang,
}: {
  copy: Copy;
  onToggleLang: () => void;
}) {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

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
    { href: "#play", label: copy.nav.play },
    { href: "#worlds", label: copy.nav.worlds },
    { href: "#features", label: copy.nav.features },
    { href: "#creators", label: copy.nav.creators },
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
      <div className={`${container} flex h-16 items-center gap-6`}>
        <a href="#top" className="flex items-center gap-2.5">
          <img src="/icon.png" alt="" className="h-7 w-7 rounded-lg" />
          <span className="font-display text-xl font-semibold tracking-tight">
            Covel
          </span>
        </a>
        <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="rounded-full px-3 py-1.5 text-sm text-muted transition hover:text-ink"
            >
              {link.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onToggleLang}
            className={`${iconButton} font-medium`}
            aria-label={copy.nav.languageLabel}
          >
            {copy.nav.language}
          </button>
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
            href={RELEASES_URL}
            className="ml-2 hidden h-9 items-center rounded-full bg-ink px-4 text-sm font-medium text-page transition hover:opacity-90 sm:inline-flex"
          >
            {copy.nav.download}
          </a>
          <button
            type="button"
            className={`${iconButton} md:hidden`}
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
      {menuOpen ? (
        <nav
          className={`${container} flex flex-col pb-4 md:hidden`}
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
          <a href={RELEASES_URL} className="py-3 text-base text-accent">
            {copy.nav.download}
          </a>
        </nav>
      ) : null}
    </header>
  );
}
