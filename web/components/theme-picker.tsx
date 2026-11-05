"use client";

// The theme picker: a sidebar-footer trigger and a search-and-arrow dialog,
// replacing the binary light/dark ThemeToggle now that config/theme.ts is a
// registry rather than two constants.
//
// HIGHLIGHT MEANS "WHAT YOU WOULD GET", CHECKMARK MEANS "WHAT YOU HAVE".
// Moving the cursor previews by writing data-theme and nothing else; only
// Enter or a tap writes the cookie. Closing puts the committed theme back.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JSX, KeyboardEvent } from "react";
import { Check, Palette } from "lucide-react";
import { THEME_LIST } from "@/config/theme";
import type { Theme } from "@/config/theme";
import { ThemeSwatch } from "@/components/theme-swatch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  applyTheme,
  commitTheme,
  getCommittedTheme,
  getServerCommittedTheme,
  subscribe,
} from "@/lib/theme-store";
import { cn } from "@/lib/utils";

function optionDomId(id: string): string {
  return `theme-option-${id}`;
}

export function ThemePicker({ collapsed }: { collapsed: boolean }): JSX.Element {
  const committed = useSyncExternalStore(subscribe, getCommittedTheme, getServerCommittedTheme);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // scrollIntoView on a mouse-driven cursor move yanks the list out from
  // under the pointer, so only keyboard moves scroll.
  const lastMoveWasKeyboard = useRef(false);

  const needle = query.trim().toLowerCase();
  const filtered = THEME_LIST.filter(
    (theme) =>
      theme.label.toLowerCase().includes(needle) || theme.id.toLowerCase().includes(needle),
  );
  const active = filtered[cursor];
  const activeId = active?.id;

  // Preview. Deliberately not commitTheme: the cookie is untouched, so the
  // checkmark stays on the theme the user actually has.
  useEffect(() => {
    if (!open || !activeId) return;
    applyTheme(activeId);
  }, [open, activeId]);

  useEffect(() => {
    if (!open || !activeId || !lastMoveWasKeyboard.current) return;
    lastMoveWasKeyboard.current = false;
    document.getElementById(optionDomId(activeId))?.scrollIntoView({ block: "nearest" });
  }, [open, activeId]);

  // Unmount paths that never run onOpenChange — Fast Refresh, an error
  // boundary — would otherwise leave the last preview on screen forever.
  useEffect(() => {
    return (): void => {
      applyTheme(getCommittedTheme());
    };
  }, []);

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (next) {
      // Radix unmounts only DialogContent; this component stays mounted in
      // the sidebar, so without an explicit reset the next open shows the
      // previous session's filter text and cursor.
      setQuery("");
      const index = THEME_LIST.findIndex((theme) => theme.id === committed);
      setCursor(index === -1 ? 0 : index);
      return;
    }
    // Read the STORE, never a theme captured when the dialog opened: Radix
    // routes Enter-then-close through this same callback, and a captured
    // value would repaint the old theme over the commit that just happened —
    // cookie says dracula, screen says studio, the choice "appears" only after
    // a reload.
    applyTheme(getCommittedTheme());
  }

  function choose(id: Theme): void {
    commitTheme(id);
    handleOpenChange(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    const { key } = event;
    // Escape is absent on purpose: it falls through to Radix, which closes
    // the dialog through onOpenChange like every other close.
    if (
      key !== "ArrowDown" &&
      key !== "ArrowUp" &&
      key !== "Home" &&
      key !== "End" &&
      key !== "Enter"
    ) {
      return;
    }
    event.preventDefault();

    // A query matching nothing leaves no row to preview or commit, so these
    // keys do nothing rather than reading `.id` off undefined.
    if (!active) return;

    if (key === "Enter") {
      choose(active.id);
      return;
    }

    lastMoveWasKeyboard.current = true;
    if (key === "ArrowDown") setCursor((c) => (c + 1) % filtered.length);
    else if (key === "ArrowUp") setCursor((c) => (c - 1 + filtered.length) % filtered.length);
    else if (key === "Home") setCursor(0);
    else setCursor(filtered.length - 1);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-haspopup="dialog"
          // The label is display:none at md width when collapsed, which
          // takes it out of the accessible name too — hence the aria-label,
          // matching what it says on screen when there is room for it.
          aria-label="Theme"
          className={cn(
            // Same shape as the footer's other rows (see
            // report-issue-dialog.tsx): full width so `justify-center`
            // means something when collapsed.
            "group/theme inline-flex w-full items-center gap-2 rounded-md p-1.5 text-sidebar-foreground/70 outline-none transition-[background-color,color,transform] duration-200 ease-out hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring motion-safe:hover:translate-x-0.5 motion-safe:active:scale-[0.98] motion-reduce:transition-none",
            collapsed && "md:justify-center",
          )}
        >
          <Palette
            aria-hidden="true"
            className="size-4 shrink-0 transition-transform duration-200 motion-safe:group-hover/theme:rotate-12 motion-safe:group-hover/theme:scale-110 motion-reduce:transition-none"
          />
          {/* STATIC, never the active theme's name: on a hard load the
              cookie is read by the inline script but this label would render
              from the build-time default first, so a live label would show
              the wrong theme for a frame on every page load. */}
          <span className={cn("text-sm", collapsed && "md:hidden")}>Theme</span>
        </button>
      </DialogTrigger>

      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">Theme</DialogTitle>
        <DialogDescription className="sr-only">
          Search, then arrow through the list to preview a theme. Enter keeps it.
        </DialogDescription>

        {/* pr-12 leaves the close button its corner: dialog.tsx renders the
            ✕ as `absolute top-4 right-4` AFTER children, so on a p-0 content
            a full-width input runs underneath it. */}
        <div className="border-b border-border py-3 pr-12 pl-4">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              // Reset on EVERY query change: a cursor left at index 2 while
              // the filter narrows to one row is out of range on the next
              // keypress.
              setCursor(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search themes…"
            role="combobox"
            aria-expanded="true"
            aria-controls="theme-listbox"
            aria-autocomplete="list"
            // Dropped entirely when nothing matches — an activedescendant
            // pointing at an element that is not rendered is worse than none.
            aria-activedescendant={activeId ? optionDomId(activeId) : undefined}
            // text-base below sm or iOS zooms the whole page on focus.
            className="w-full bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm"
          />
        </div>

        {/* Rendered even when empty, with the no-match line INSIDE it, so
            the input's aria-controls never points at a missing element. */}
        <ul
          id="theme-listbox"
          role="listbox"
          aria-label="Themes"
          className="max-h-[min(60svh,20rem)] overflow-y-auto p-2"
        >
          {filtered.length === 0 ? (
            <li role="presentation" className="px-2 py-6 text-center text-sm text-muted-foreground">
              No themes match “{query}”.
            </li>
          ) : (
            filtered.map((theme, index) => (
              <li
                key={theme.id}
                id={optionDomId(theme.id)}
                role="option"
                // aria-selected tracks the CURSOR, per the ARIA APG combobox
                // pattern — the committed theme is announced by "current" in
                // its name instead.
                aria-selected={index === cursor}
                // Spelled out rather than composed from a visually-hidden
                // span: name computation trims each node it concatenates, so
                // an appended " current" is announced as "studio lightcurrent".
                aria-label={theme.id === committed ? `${theme.label} current` : theme.label}
                // onMouseMove, not onMouseEnter: mouseenter fires on its own
                // when the list scrolls under a pointer that never moved,
                // stealing the cursor mid-arrow-navigation.
                onMouseMove={() => {
                  lastMoveWasKeyboard.current = false;
                  setCursor(index);
                }}
                // From theme.id, never filtered[cursor]: a touch tap has no
                // hover to move the cursor first.
                onClick={() => choose(theme.id)}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-2 text-sm",
                  index === cursor && "bg-accent text-accent-foreground",
                )}
              >
                <span className="truncate">{theme.label}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <ThemeSwatch id={theme.id} />
                  {theme.id === committed ? (
                    <Check aria-hidden="true" className="size-4 shrink-0" />
                  ) : null}
                </span>
              </li>
            ))
          )}
        </ul>

        {/* A filter that quietly empties the list is this codebase's
            silent-refusal bug in the one place a sighted user still sees the
            "no themes match" line and a screen reader user would not. */}
        <div role="status" className="sr-only">
          {filtered.length === 1 ? "1 theme matches" : `${filtered.length} themes match`}
        </div>
      </DialogContent>
    </Dialog>
  );
}
