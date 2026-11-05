export interface AppBannerConfig {
  id: string;
  text: string;
  cta: string;
  href: string;
}

/**
 * Reads the optional global announcement without exposing its controls to
 * the client bundle. APP_BANNER_ID is the switch and the dismissal version:
 * changing it publishes the next announcement to browsers that dismissed
 * the previous one.
 */
export function readAppBannerConfig(
  env: Record<string, string | undefined> = process.env,
): AppBannerConfig | null {
  const id = env.APP_BANNER_ID?.trim();
  if (!id) return null;

  const text = env.APP_BANNER_TEXT?.trim();
  const cta = env.APP_BANNER_CTA?.trim();
  const href = env.APP_BANNER_HREF?.trim();

  // A partial campaign is hidden instead of shipping an empty CTA or an
  // unsafe external destination. This banner only needs in-app links.
  // "/\host" is rejected too: browsers read the backslash as "/", making it "//host".
  if (!text || !cta || !href || !href.startsWith("/") || /^\/[/\\]/.test(href)) return null;

  return { id, text, cta, href };
}
