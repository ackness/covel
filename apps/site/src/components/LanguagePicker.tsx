import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Languages } from "lucide-react";
import { LANGS, LANGUAGES, type Lang } from "../copy.js";

/** A select-only combobox: focus stays on the trigger while choosing an option. */
export function LanguagePicker({
  lang,
  label,
  onSelect,
}: {
  lang: Lang;
  label: string;
  onSelect: (lang: Lang) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(lang);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const select = (value: Lang) => {
    onSelect(value);
    setOpen(false);
    trigger.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) select(active);
      else {
        setActive(lang);
        setOpen(true);
      }
      return;
    }
    const index = LANGS.indexOf(open ? active : lang);
    const next =
      event.key === "ArrowDown"
        ? (index + 1) % LANGS.length
        : event.key === "ArrowUp"
          ? (index - 1 + LANGS.length) % LANGS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? LANGS.length - 1
              : undefined;
    if (next !== undefined) {
      event.preventDefault();
      setOpen(true);
      setActive(LANGS[next] ?? lang);
    }
  };

  return (
    <div
      ref={root}
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        onKeyDown={onKeyDown}
        onClick={() => {
          setActive(lang);
          setOpen((value) => !value);
        }}
        className="inline-flex h-9 shrink-0 items-center gap-1 sm:gap-1.5 rounded-full border border-line bg-raised px-2 text-xs sm:px-3 text-ink transition hover:border-accent/50 sm:text-sm"
      >
        <Languages
          size={14}
          aria-hidden
          className="hidden text-muted sm:block"
        />
        <span className="whitespace-nowrap" lang={LANGUAGES[lang].tag}>
          {LANGUAGES[lang].label}
        </span>
        <ChevronDown
          size={13}
          aria-hidden
          className={`text-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <ul
          id={id}
          role="listbox"
          aria-label={label}
          className="language-options absolute right-0 top-full z-50 mt-2 min-w-44 overflow-hidden rounded-xl border border-line bg-raised p-1.5 shadow-xl shadow-black/10"
        >
          {LANGS.map((value) => (
            <li
              key={value}
              id={`${id}-${value}`}
              role="option"
              aria-selected={value === lang}
              lang={LANGUAGES[value].tag}
              onPointerDown={(event) => event.preventDefault()}
              onPointerMove={() => setActive(value)}
              onClick={() => select(value)}
              data-active={active === value}
              className="flex cursor-pointer items-center justify-between gap-6 rounded-lg px-3 py-2.5 text-sm text-ink transition-colors data-[active=true]:bg-ink/5 aria-selected:text-accent"
            >
              {LANGUAGES[value].label}
              {value === lang && <Check size={15} aria-hidden />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
