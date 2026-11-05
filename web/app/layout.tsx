import type { JSX, ReactNode } from "react";
import type { Metadata } from "next";
import { Inter_Tight, Source_Serif_4 } from "next/font/google";
import { buildThemeScript, THEME } from "@/config/theme";
import { Toaster } from "@/components/ui/sonner";
import { ThemeBootstrap } from "@/components/theme-bootstrap";
import "./globals.css";

export const metadata: Metadata = {
  title: "Maison Studios",
  applicationName: "Maison Studios",
};

// Self-hosted via next/font at build time — no runtime request to Google
// Fonts, which matters because this builds in Docker and runs behind a
// strict environment with no guarantee of outbound access at request time.
// Inter Tight: a sans built for dense UI — tighter tracking than Inter reads
// better in the operator chrome here (buttons, tables, form labels) at
// small sizes. Source Serif 4: a warm, text-tuned serif for headings only,
// matching the editorial feel without slowing down the UI copy it never
// touches (see globals.css's h1–h4 rule and CardTitle).
const sans = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-inter-tight",
  display: "swap",
});

const serif = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-source-serif",
  display: "swap",
});

// The cookie value is checked against the theme whitelist rather than
// trusted as-is. A cookie is client-writable, and stamping an unrecognised
// value onto data-theme matches none of the `:root[data-theme="…"]` blocks
// in globals.css — except studio-light.css's, which sits on a bare `:root` and so
// renders as the fallback for any unrecognised value, not an unstyled app.
// A stale cookie from a renamed theme would be enough; nothing hostile is
// required. Anything unrecognised is ignored, which leaves the
// server-rendered default in place.

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    // data-theme={THEME} is the server-rendered default (light, "studio-light") —
    // baked in at build time from NEXT_PUBLIC_THEME (config/theme.ts), same
    // as always. It is deliberately NOT read from a cookie here: doing that
    // would need `cookies()`, and calling `cookies()` anywhere in this file
    // forces Next to treat the ENTIRE route as dynamic — every page under
    // this root layout, including /login, would lose static rendering just
    // to know whether to render one HTML attribute. (See app/(app)/layout.tsx
    // for the one place in this app where that dynamic cost IS already
    // being paid, for requireUser() — this file has no such reason to pay
    // it.) Instead, the theme preference (written by ThemeToggle as the
    // `ugc-theme` cookie) is applied by a tiny, dependency-free inline
    // script placed as early as possible in <head>, which runs and
    // overwrites document.documentElement.dataset.theme synchronously
    // before the browser paints anything — the same "avoid a flash of the
    // wrong value" trick used for dark-mode toggles elsewhere on the web,
    // done here with a cookie (readable server-side too, if this ever needs
    // SSR-correct theming) instead of localStorage. If a future change
    // "simplifies" this back into a server-side cookies() read, it will
    // silently make every route in the app dynamic — don't do that.
    // suppressHydrationWarning: React warns on host-attribute mismatches during
    // hydration, it does not patch them — this only silences a warning that
    // goes from rare to routine once three themes exist, not a correctness fix.
    <html
      lang="en"
      data-theme={THEME}
      suppressHydrationWarning
      className={`${sans.variable} ${serif.variable}`}
    >
      <head>
        <ThemeBootstrap script={buildThemeScript()} />
      </head>
      {/* Extensions stamp attributes on <body> before hydration
          (data-smart-converter-loaded); this ignores attribute mismatches on
          this one element only, not on anything inside it. */}
      <body className="antialiased" suppressHydrationWarning>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
