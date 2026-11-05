import type { JSX } from "react";
import type { Theme } from "@/config/theme";

// Three dots that paint themselves in the theme they name.
//
// The nested data-theme is the whole trick: globals.css's `@theme inline`
// block maps every colour utility to `hsl(var(--token))`, and a var()
// resolves AT THE ELEMENT — so `bg-primary` inside a
// `<span data-theme="dracula">` reads dracula's --primary, no matter what
// <html> is set to. The swatch therefore needs no per-theme colour table of
// its own; config/themes/<id>.css is the single source, including for a
// theme added after this file was written.
//
// FOUR LITERAL CLASS STRINGS, IDENTICAL FOR EVERY THEME. Never build one
// from `id`: Tailwind's build only generates CSS for class names it finds as
// complete strings in the source, so an interpolated class works in dev and
// silently produces no rule in the production build — see
// components/initials-avatar.tsx, which documents this repo hitting exactly
// that. `id` is a runtime attribute the scanner never has to see.
export function ThemeSwatch({ id }: { id: Theme }): JSX.Element {
  return (
    <span
      data-theme={id}
      aria-hidden="true"
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-background px-2 py-1"
    >
      <span className="size-2 rounded-full bg-primary" />
      <span className="size-2 rounded-full bg-muted-foreground" />
      <span className="size-2 rounded-full bg-foreground" />
    </span>
  );
}
