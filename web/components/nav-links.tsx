"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { JSX } from "react";
import {
  BarChart3,
  Clapperboard,
  Folder,
  HandCoins,
  Library,
  Trash2,
  Users as UsersIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface NavLink {
  href: string;
  label: string;
  // Destination-describing, not decorative — chosen so the icon alone still
  // identifies the page once collapsed (components/sidebar-shell.tsx) turns
  // off the label text at md+.
  icon: LucideIcon;
}

// /profile used to live here as a BASE_LINKS entry; it now lives inside the
// avatar menu (components/account-menu.tsx) as "View profile" instead — see
// app/(app)/layout.tsx.
const BASE_LINKS: readonly NavLink[] = [
  // Create, Elements, Studio: making things first, then what they are made
  // from, then where they are kept. None carries an id — /ugc, which needs
  // one, is reached from Create or Studio. /create holds the image
  // generator and the clip prompt bar; /image-generator still works for old
  // links. Every signed-in account sees all of these.
  { href: "/create", label: "Create", icon: Clapperboard },
  { href: "/elements", label: "Elements Library", icon: Library },
  { href: "/projects", label: "Studio", icon: Folder },
  // Unlike /ugc, this route carries no id — it is the one bin for every
  // project an account (or, for an admin, every account) can reach.
  { href: "/bin", label: "Bin", icon: Trash2 },
];

// The Character Library's sidebar entry is GONE, not the route. /library, the
// `characters` table (0020) and every action behind them are untouched, and
// the page is still reached from the two places that actually need it — the
// chooser in components/character-library-chooser.tsx and the "browse the
// library" link on projects/[id]/character. It lost its top-level entry
// because a shared, admin-curated character set is a step inside the /ugc
// flow, not a destination of its own; the sidebar slot it held is now the
// per-account Elements Library above.
const ACCOUNTS_CONTROL_LINK: NavLink = {
  href: "/accounts-control",
  label: "Accounts and Spending Control",
  icon: BarChart3,
};
const USERS_LINK: NavLink = { href: "/users", label: "Users", icon: UsersIcon };
const ALLOWANCES_LINK: NavLink = {
  href: "/allowances",
  label: "Allowance requests",
  icon: HandCoins,
};

/**
 * Primary sidebar nav. Client-only because it needs usePathname() for
 * active-route highlighting — the surrounding layout stays a Server
 * Component so requireUser() still runs there.
 */
export function NavLinks({
  showAdminLinks,
  showAllowanceLink,
  decidableRequestCount,
  collapsed,
}: {
  showAdminLinks: boolean;
  showAllowanceLink: boolean;
  /** Pending requests this viewer may actually decide — their own and any
   * over their ceiling are already excluded server-side (lib/sidebar-
   * budget.ts). null when the read failed; 0 and null both render nothing,
   * because "no work waiting" and "could not tell" should look identical
   * rather than have one of them shout. */
  decidableRequestCount: number | null;
  /** md+ only (see sidebar-shell.tsx) — icon-only, label becomes an
   * aria-label plus a hover/focus tooltip instead of inline text. */
  collapsed: boolean;
}): JSX.Element {
  const pathname = usePathname();
  const links = [
    ...BASE_LINKS,
    ...(showAdminLinks ? [ACCOUNTS_CONTROL_LINK, USERS_LINK] : []),
    ...(showAllowanceLink ? [ALLOWANCES_LINK] : []),
  ];

  return (
    <nav className="flex flex-col gap-1">
      {links.map((link) => {
        const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <div key={link.href} className="group relative">
            <Link
              href={link.href}
              // Only set when the visible label can be hidden (collapsed,
              // md+) — an aria-label alongside already-visible matching
              // text is harmless but redundant, so leave the native
              // content-derived accessible name alone otherwise.
              aria-label={collapsed ? link.label : undefined}
              className={cn(
                "group/nav-link flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-[background-color,color,transform] duration-200 ease-out hover:translate-x-0.5 active:scale-[0.98]",
                collapsed && "md:justify-center md:px-2",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              )}
            >
              {/* No colour class of its own — inherits currentColor from
                  the Link's own active/inactive text colour above, so the
                  icon is exactly as "quiet" as the label it sits next to. */}
              <link.icon
                aria-hidden="true"
                className={cn(
                  "size-4 shrink-0 transition-transform duration-200 ease-out group-hover/nav-link:scale-110 group-active/nav-link:scale-95",
                )}
              />
              <span className={cn(collapsed && "md:hidden")}>{link.label}</span>
            </Link>
            {/* Count rides on the link, not beside it, so it survives the
                collapsed (md+, icon-only) state where there is no label to
                sit next to — that is exactly when an operator most needs to
                know something is waiting. Capped at 9+: the number is a
                nudge to open the page, and past a point the exact figure
                stops changing what anyone does. aria-label carries the real
                count and the noun, since a bare "3" read aloud after
                "Allowance requests" is ambiguous about what is being
                counted. */}
            {link.href === ALLOWANCES_LINK.href && decidableRequestCount ? (
              <span
                key={decidableRequestCount}
                aria-label={`${decidableRequestCount} awaiting your decision`}
                className={cn(
                  "pointer-events-none absolute flex min-w-4 animate-in items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground zoom-in-50 duration-200",
                  collapsed
                    ? "-right-0.5 -top-0.5 md:right-1 md:top-1"
                    : "right-2 top-1/2 -translate-y-1/2",
                )}
              >
                {decidableRequestCount > 9 ? "9+" : decidableRequestCount}
              </span>
            ) : null}
            {collapsed ? (
              // Below `md` this never shows: `hidden` is the default and
              // the only rules that flip it to `flex` are `md:`-scoped, so
              // the mobile disclosure panel (which always shows full
              // labels) never has a hover-tooltip fighting the inline text.
              <span
                role="tooltip"
                className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 hidden -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md md:group-hover:flex md:group-focus-within:flex"
              >
                {link.label}
              </span>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}
