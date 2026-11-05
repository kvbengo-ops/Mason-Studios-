// DISPLAY-ONLY resolution label for /ugc. Nothing else reads this.
//
// OPERATOR DECISION, 2026-09-10: Kling's std tier — kie's real 720p, priced
// and billed at that receipt's 20 cr/s (see lib/kie/rates.ts) — is what
// /ugc's picker means by "the cheap Kling option," and the UI is allowed to
// read it as a single tier the way the rest of /ugc's picker does, rather
// than exposing kie's own std/pro split. So the screen SHOWS "480p" for it.
//
// DISPLAY ONLY. Everything that is not a label on the page keeps the real
// value, 720p, unchanged: the hidden `resolution` form input, every
// `formData.set("resolution", ...)`, scenes.render_settings_override, every
// price quoted anywhere, and the "mode":"std" kie is actually sent. This
// function has no reach into any of that — it takes a resolution string and
// returns a resolution string, and every call site is a place text is
// painted on screen, never a place one is read off a form or a row.
//
// ITS OWN MODULE, deliberately not folded into lib/ugc-options.ts. That file
// imports offerable()/rateFor, which read KIE_MODELS and pull kie's pricing
// tables along with them — fine for the server component that already isn't
// shipped to the browser, wrong for a function every client component that
// merely displays a resolution would otherwise have to import transitively.

/**
 * What /ugc should show for a model/resolution pair — "480p" for Kling's
 * std tier (the real, billed value is 720p; see this file's own header),
 * the resolution unchanged for every other pair.
 */
export function ugcTierLabel(modelId: string, resolution: string): string {
  if ((modelId === "kling-3.0-pro" || modelId === "gemini-omni-video") && resolution === "720p") {
    return "480p";
  }
  return resolution;
}
