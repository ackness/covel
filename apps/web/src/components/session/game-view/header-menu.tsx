import { useDismissibleMenu } from "@/hooks/use-dismissible-menu.js";
import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button.js";

const MENU_VIEWPORT_GUTTER = 12;
const MENU_MAX_WIDTH = `calc(100vw - ${MENU_VIEWPORT_GUTTER * 2}px)`;

/** A square icon-only header button. */
export const HEADER_ICON_BUTTON = "h-10 w-10 md:h-8 md:w-8";
/**
 * A header button with words beside its icon: square while the words are
 * hidden on phones, then as wide as its content.
 */
export const HEADER_TEXT_BUTTON =
  "h-10 min-w-10 justify-center gap-1.5 px-2 md:h-8 md:min-w-8";

/** A click-away menu kept within the viewport when toolbar controls wrap. */
export function HeaderMenu({
  label,
  active,
  children,
  icon: Icon = MoreHorizontal,
  text,
  inGroup = false,
  triggerClassName,
}: {
  readonly icon?: ComponentType<{ className?: string }>;
  readonly label: string;
  /**
   * Visible words beside the icon from the `sm` width up; the label stays the
   * accessible name. The trigger then grows with the words instead of keeping
   * the icon button's fixed width.
   */
  readonly text?: string;
  /**
   * The trigger is one segment of a grouped control (such as the Read / Stage
   * switch), so it takes the group's shape instead of a standalone header
   * button's (round glass in the stage appearance).
   */
  readonly inGroup?: boolean;
  /** Size and shape of the trigger; replaces the default size. */
  readonly triggerClassName?: string;
  /** Marks the trigger when an option inside is switched on. */
  readonly active: boolean;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [menuLeft, setMenuLeft] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const { containerRef, triggerRef } = useDismissibleMenu(open, setOpen, true);
  useLayoutEffect(() => {
    const wrapper = containerRef.current;
    const menu = menuRef.current;
    if (!open || !wrapper || !menu) return;
    const position = () => {
      const anchor = wrapper.getBoundingClientRect();
      const width = menu.getBoundingClientRect().width;
      const left = Math.max(
        MENU_VIEWPORT_GUTTER,
        Math.min(
          anchor.right - width,
          window.innerWidth - width - MENU_VIEWPORT_GUTTER,
        ),
      );
      setMenuLeft(left - anchor.left);
    };
    position();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(position);
    observer?.observe(wrapper);
    observer?.observe(menu);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, containerRef, children]);

  return (
    <div
      ref={containerRef}
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <Button
        ref={triggerRef}
        variant="ghost"
        size={text ? "sm" : "icon"}
        className={`shrink-0 ${inGroup ? "" : "ui-session-action"} ${triggerClassName ?? (text ? HEADER_TEXT_BUTTON : HEADER_ICON_BUTTON)} ${open || active ? "bg-accent text-accent-foreground" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={label}
        title={label}
      >
        <Icon className="w-4 h-4" />
        {text && <span className="hidden text-xs sm:inline">{text}</span>}
      </Button>
      {open && (
        <div
          ref={menuRef}
          role="group"
          aria-label={label}
          data-covel-host-controls=""
          className="ui-dialog-shell absolute top-full z-30 mt-1.5 w-max p-1"
          style={{
            left: menuLeft,
            minWidth: `min(12rem, ${MENU_MAX_WIDTH})`,
            maxWidth: MENU_MAX_WIDTH,
          }}
          // Any choice closes the menu; the items handle their own action.
          onClick={() => {
            setOpen(false);
            triggerRef.current?.focus();
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  icon: Icon,
  label,
  secondary,
  checked,
  disabled,
  onSelect,
}: {
  readonly icon: ComponentType<{ className?: string }>;
  readonly label: string;
  readonly secondary?: string;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      disabled={disabled}
      onClick={onSelect}
      className={`ui-menu-item flex h-9 w-full items-center gap-2.5 rounded-(--radius-control) px-2.5 text-left text-[13px] hover:bg-muted/60 disabled:pointer-events-none disabled:opacity-50 ${
        checked ? "text-(--accent-primary) font-medium" : ""
      }`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span>{label}</span>
      {secondary && (
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {secondary}
        </span>
      )}
    </button>
  );
}

/** A small caption above one section of a menu. */
export function MenuHeading({ children }: { readonly children: ReactNode }) {
  return (
    <p className="ui-meta px-2.5 pb-0.5 pt-2 text-[10px] text-muted-foreground">
      {children}
    </p>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-(--rule-color)" />;
}
