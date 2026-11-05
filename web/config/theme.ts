// Three themes are reachable at runtime, all through the theme picker (the
// successor to components/theme-toggle.tsx): "studio" (navy),
// "studio-light" and "higgsfield". globals.css imports all three statically as
// `:root[data-theme="…"]` blocks (studio-light.css's block sits on a bare `:root`,
// so it also doubles as the fallback for any unrecognised value), and
// app/layout.tsx stamps THEME onto <html data-theme> as the server-rendered
// default, overridden at runtime via the `ugc-theme` cookie by the
// blocking inline script in app/layout.tsx's <head> (built by
// buildThemeScript below).
//
// THEME_LIST's `id`s are a wire format, not display text: they are what
// lives in every user's cookie today and what render.yaml, web/Dockerfile,
// docker-compose.yml, .env.example and ci.yml pass as NEXT_PUBLIC_THEME.
// Renaming one breaks all of those. Labels are free to change.
export type ThemeEntry = { id: string; label: string };

export const THEME_LIST = [
  // Three themes only. A cookie still naming a removed theme fails isTheme
  // and falls back to the server default.
  { id: "studio", label: "studio" },
  { id: "studio-light", label: "studio light" },
  { id: "higgsfield", label: "higgsfield" },
] as const satisfies readonly ThemeEntry[];

export type Theme = (typeof THEME_LIST)[number]["id"];

export const THEME_IDS = THEME_LIST.map((entry) => entry.id) as readonly Theme[];

export const DEFAULT_THEME: Theme = "studio-light";

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

// `??` would let `"" ?? DEFAULT_THEME` evaluate to `""` — docker-compose's
// unset-variable substitution slips an empty string through that operator.
// isTheme is what closes that gap, on top of validating the value at all.
export const THEME: Theme = isTheme(process.env.NEXT_PUBLIC_THEME)
  ? process.env.NEXT_PUBLIC_THEME
  : DEFAULT_THEME;

// The cookie the theme picker writes on selection and the inline anti-flash
// script (buildThemeScript below) reads before first paint. Shared here so
// the two never drift apart on the literal name — see both call sites for
// why neither can be a plain server-side cookies() read.
export const THEME_COOKIE_NAME = "ugc-theme";

// Same rationale as sidebar-shell.tsx's COOKIE_MAX_AGE_S: a display
// preference with no security weight, meant to survive across sessions.
export const THEME_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365;

// Returned as a plain string, not a module the bundler can typecheck,
// because app/layout.tsx injects it via dangerouslySetInnerHTML into a
// blocking inline <script> that must run before first paint.
export function buildThemeScript(): string {
  return `(function(){try{var m=document.cookie.match(/(?:^|; )${THEME_COOKIE_NAME}=([^;]*)/);if(!m)return;var t=decodeURIComponent(m[1]);if(${JSON.stringify(THEME_IDS)}.indexOf(t)>-1)document.documentElement.dataset.theme=t;}catch(e){}})();`;
}
