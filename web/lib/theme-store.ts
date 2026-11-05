"use client";

// The external store behind the theme picker (components/theme-picker.tsx),
// carrying over the reasoning that used to live in components/theme-toggle.tsx:
//
// document.documentElement.dataset.theme is external mutable state (written
// by the anti-flash script in app/layout.tsx's <head> before hydration, and
// by commitTheme below) that the picker's checkmark needs to track.
// useSyncExternalStore, not useState+useEffect: reading `document` in a
// lazy useState initializer would run again during hydration and could
// disagree with the server-rendered markup whenever the `ugc-theme`
// cookie says something other than the build-time default — a hydration
// mismatch. Syncing via setState inside a plain useEffect avoids the
// mismatch but is exactly the "cascading render" pattern this repo's lint
// config (react-hooks/set-state-in-effect) forbids. useSyncExternalStore is
// the React-sanctioned way to read non-React state safely on both the
// server (getServerCommittedTheme, derived from THEME so it matches what
// layout.tsx stamps) and the client (getCommittedTheme), with no effect and
// no manual setState.
//
// THE COOKIE IS THE COMMITTED THEME, NOT THE DOM. The picker previews by
// writing data-theme on its own, so while it is open the attribute says
// "what you would get" — asking the DOM what theme you have would answer
// with whichever row the cursor is sitting on.
import { THEME, THEME_COOKIE_NAME, THEME_COOKIE_MAX_AGE_S, isTheme } from "@/config/theme";
import type { Theme } from "@/config/theme";

const listeners = new Set<() => void>();

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * The theme the user actually has, parsed fresh from the cookie on every
 * call. No module-level cache: this returns a string, which React compares
 * with Object.is, so getSnapshot needs no referential stability here — and a
 * cache has no reset path, survives between tests in one Vitest file, and
 * goes stale the moment another tab commits a different theme.
 */
export function getCommittedTheme(): Theme {
  try {
    // decodeURIComponent throws on a malformed value, and `document` does
    // not exist at all on the paths that reach this by accident; either way
    // the answer is the build-time default rather than a crash.
    const match = document.cookie.match(new RegExp(`(?:^|; )${THEME_COOKIE_NAME}=([^;]*)`));
    if (!match) return THEME;
    const value = decodeURIComponent(match[1] ?? "");
    return isTheme(value) ? value : THEME;
  } catch {
    return THEME;
  }
}

export function getServerCommittedTheme(): Theme {
  return THEME;
}

/** PREVIEW: the attribute only. No cookie, no notify — so the picker's
 * checkmark keeps pointing at the theme you still have. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function commitTheme(theme: Theme): void {
  applyTheme(theme);
  document.cookie = `${THEME_COOKIE_NAME}=${theme}; path=/; max-age=${THEME_COOKIE_MAX_AGE_S}; SameSite=Lax`;
  // Without this, React has no reason to know the cookie just changed and
  // every subscribed useSyncExternalStore keeps rendering the stale theme.
  notify();
}
