"use client";

// The desktop-collapsible sidebar shell. Split out of app/(app)/layout.tsx
// (which must stay a Server Component for requireUser()) because collapse
// is interactive client state: a width that changes on click, a preference
// that has to survive a reload, and a footer trigger (AccountMenu) whose
// own layout depends on it. NavLinks takes the plain `collapsed` boolean.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { JSX } from "react";
import { PanelLeft, PanelLeftClose } from "lucide-react";
import { NavLinks } from "@/components/nav-links";
import { MaisonLogo, MaisonWordmark } from "@/components/maison-logo";
import { ThemePicker } from "@/components/theme-picker";
import { ReportIssueDialog } from "@/components/report-issue-dialog";
import { cn } from "@/lib/utils";

const COOKIE_NAME = "sidebar-collapsed";
// A year: this is a display preference with no security weight, and it
// should hold across sessions, not just the current tab.
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365;

export function SidebarShell({
  showAdminLinks,
  showAllowanceLink,
  decidableRequestCount,
  defaultCollapsed,
}: {
  showAdminLinks: boolean;
  showAllowanceLink: boolean;
  /** Passed straight to NavLinks' badge — see its prop doc. */
  decidableRequestCount: number | null;
  /** Read from the `sidebar-collapsed` cookie server-side in AppLayout, so
   * the very first paint on a hard reload already matches the persisted
   * choice — no expand-then-snap-collapsed flash while this component
   * hydrates. */
  defaultCollapsed: boolean;
}): JSX.Element {
  const pathname = usePathname();

  // Inside a single project the page grows its own rail
  // (components/project-rail.tsx), so leaving this one expanded puts two
  // full navigation columns side by side and squeezes the work. Collapsing
  // to icons keeps Projects/Spend/Users one click away without spending the
  // width on them.
  //
  // Matches /projects/<something> but NOT /projects itself or /projects/new:
  // neither of those has a rail, so neither should lose this one.
  const insideProject = /^\/projects\/(?!new$)[^/]+/.test(pathname ?? "");

  // null means "follow the rule for wherever I am". A click sets it, so an
  // operator who wants both columns can still have them — the rule is a
  // default, not a lock. It resets on crossing into or out of a project,
  // because a choice made about one context should not silently govern the
  // other.
  const [override, setOverride] = useState<boolean | null>(null);
  // React's documented "adjust state when a prop changes" shape: keep the
  // previous value in state and compare during render. A ref would be the
  // obvious instinct and is exactly what react-hooks/refs forbids here —
  // reading or writing one during render is not safe under concurrent
  // rendering, where a render can be thrown away and replayed.
  const [prevInsideProject, setPrevInsideProject] = useState(insideProject);
  if (prevInsideProject !== insideProject) {
    setPrevInsideProject(insideProject);
    setOverride(null);
  }

  const [userCollapsed, setUserCollapsed] = useState(defaultCollapsed);
  const collapsed = override ?? (insideProject ? true : userCollapsed);
  const setCollapsed = (next: boolean): void => {
    setOverride(next);
    // Only a choice made OUTSIDE a project is the operator's standing
    // preference; one made inside is about this project's cramped width and
    // must not follow them back out.
    if (!insideProject) setUserCollapsed(next);
  };
  // Both timers live for the component's lifetime; cleared on unmount so a
  // delayed callback never fires setState against an unmounted instance.
  const pendingCookieWrite = useRef<boolean>(false);

  useEffect(() => {
    // Skip the write on first mount — defaultCollapsed already came from
    // the cookie AppLayout read, so re-writing it here would be a no-op at
    // best and, at worst, race a stale value onto a cookie a concurrent tab
    // just changed.
    if (!pendingCookieWrite.current) {
      pendingCookieWrite.current = true;
      return;
    }
    document.cookie = `${COOKIE_NAME}=${userCollapsed ? "1" : "0"}; path=/; max-age=${COOKIE_MAX_AGE_S}`;
  }, [userCollapsed]);

  return (
    // peer-checked:flex is the mobile disclosure toggle (app/(app)/layout.tsx's
    // #sidebar-toggle checkbox, a DOM sibling of this <aside> once rendered —
    // React component boundaries don't change DOM adjacency, so the CSS
    // `peer` relationship still holds with <aside> living in this separate
    // component). md:w-16/md:w-64 is the ONLY thing collapse changes at the
    // <aside> level; every collapse-driven class below is `md:`-scoped on
    // purpose — collapse is a desktop affordance, and below `md` this is the
    // same full disclosure panel it always was, regardless of what the
    // desktop preference happens to be set to (e.g. a window resized down
    // after collapsing at desktop width must not carry icon-only layout
    // into the mobile panel).
    <aside
      className={cn(
        // md:z-30: sticky makes this its own stacking context, and without a
        // z-index it painted UNDER <main> (later in the DOM), so the nav's
        // hover labels (z-50 inside it) slid beneath page images. Above the
        // pages' own floating controls (z-20), below dialogs (z-50).
        "hidden flex-col justify-between border-b border-border bg-sidebar p-4 peer-checked:flex md:sticky md:top-0 md:z-30 md:flex md:h-svh md:shrink-0 md:border-r md:border-b-0",
        // md:p-2 when collapsed, not the p-4 the expanded rail uses: at
        // md:w-16 (64px), p-4 leaves 32px of content box, and the account
        // trigger's own p-2 takes 16 more — so a 32px `size-8` avatar had
        // 16px to live in. Being `shrink-0` it refused to shrink and was
        // clipped instead, which renders a circle as a narrow vertical
        // sliver and reads as a corrupted image rather than a layout bug.
        // The nav icons survived it only because they are 16px.
        collapsed ? "md:w-16 md:p-2" : "md:w-64",
        // Inside a project this stays VISIBLE, as a narrow icon strip
        // (md:w-16 above, via the `collapsed` default below). It was hidden
        // outright for a while — the argument being that a rail already
        // carrying "← Studio" made a second column redundant — and that
        // was reversed by explicit request: the app's own top-level
        // destinations (Character Library, Spend, Users) were then two
        // clicks away from every project screen, and the account and theme
        // controls with them.
        //
        // Icon-only rather than full width is the compromise that survived
        // both rounds: 64px of glyphs beside the rail, expandable from the
        // toggle, and the expansion does not follow the operator back out
        // of the project (see setCollapsed).
      )}
    >
      <div className="flex flex-col gap-6">
        <div
          className={cn("border-b border-sidebar-border pb-4", collapsed && "md:border-0 md:pb-0")}
        >
          <Link
            href="/projects"
            aria-label="Maison Studios home"
            className={cn(
              "flex min-h-14 min-w-0 items-center gap-3 rounded-md px-2 transition-opacity hover:opacity-85",
              collapsed && "md:justify-center md:px-0",
            )}
          >
            <MaisonLogo
              className={cn("h-10 w-14 shrink-0 text-primary", collapsed && "md:size-7")}
            />
            <MaisonWordmark
              className={cn("min-w-0 text-sidebar-foreground", collapsed && "md:hidden")}
            />
          </Link>
        </div>
        {/* The toggle is the row's only child: justify-end keeps it where it
            sat beside the old title. Collapsed, every nav icon below is
            md:justify-center, so centring the row puts it on the same axis. */}
        <div className={cn("flex items-center justify-end", collapsed && "md:justify-center")}>
          {/* Desktop-only, real <button> (not a div/span with a click
              handler) — reachable by Tab, activatable with Enter/Space for
              free, and aria-pressed makes the current state announced, not
              just implied by an icon swap. */}
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-pressed={collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="group/collapse hidden rounded-md p-1.5 text-sidebar-foreground/70 outline-none transition-[background-color,color,transform] duration-200 ease-out hover:scale-105 hover:bg-sidebar-accent hover:text-sidebar-foreground active:scale-90 focus-visible:ring-2 focus-visible:ring-sidebar-ring md:inline-flex"
          >
            {collapsed ? (
              <PanelLeft
                aria-hidden="true"
                className="size-4 transition-transform duration-200 group-hover/collapse:translate-x-0.5"
              />
            ) : (
              <PanelLeftClose
                aria-hidden="true"
                className="size-4 transition-transform duration-200 group-hover/collapse:-translate-x-0.5"
              />
            )}
          </button>
        </div>
        <NavLinks
          showAdminLinks={showAdminLinks}
          showAllowanceLink={showAllowanceLink}
          decidableRequestCount={decidableRequestCount}
          collapsed={collapsed}
        />
      </div>

      <div className="border-t border-sidebar-border pt-2">
        {/* Same footer, right next to the account control — a display
            preference, not an account setting, so it doesn't belong inside
            AccountMenu's dropdown. This stays visible collapsed: ThemePicker
            follows the collapse rule itself (icon-only, label md:hidden),
            matching the collapse button up in the header. */}
        {/* REACHABLE FROM EVERY PAGE, which is the only placement that
            works: a problem is noticed wherever it happens, and a report
            button that lives on one screen is a report button people
            navigate away from before they reach it.

            Beside the theme toggle rather than inside AccountMenu's
            dropdown, for the same reason that one is: two clicks to reach
            a control is one more than a frustrated operator will spend.

            Stays visible collapsed — it is an icon already. */}
        {/* STACKED, not side by side. They are the same kind of control —
            a labelled footer row that collapses to its icon — and a row of
            two icons reads as a toolbar, which is a different promise. */}
        <ThemePicker collapsed={collapsed} />
        <ReportIssueDialog collapsed={collapsed} />
      </div>
    </aside>
  );
}
