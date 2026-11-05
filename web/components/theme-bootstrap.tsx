"use client";

import type { JSX } from "react";
import { useServerInsertedHTML } from "next/navigation";

/**
 * Inserts the theme bootstrap into the initial server HTML without leaving a
 * script element in the client-rendered React tree.
 *
 * A raw script in app/layout.tsx works when the browser parses the first HTML
 * document, but React 19 warns and refuses to execute it when a Server Action
 * redirect remounts that tree on the client. `useServerInsertedHTML` runs this
 * callback only while Next is producing server HTML; this component itself
 * renders null during hydration and later client navigations.
 */
export function ThemeBootstrap({ script }: { script: string }): null {
  useServerInsertedHTML((): JSX.Element => (
    <script id="set-theme-from-cookie" dangerouslySetInnerHTML={{ __html: script }} />
  ));

  return null;
}
