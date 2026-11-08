import type { JSX, ReactNode } from "react";
import { cookies } from "next/headers";
import { requireUser, isAdmin, isApprover } from "@/actions/guard";
import { SidebarShell } from "@/components/sidebar-shell";
import { TopBar } from "@/components/top-bar";
import { getSidebarBudget, getDecidableRequestCount } from "@/lib/sidebar-budget";
import { signedUrl, AVATAR_TRANSFORM } from "@/lib/storage";
import { RenderTimer } from "@/lib/perf-log";
import { getRecentNotifications, getUnreadNotificationCount } from "@/lib/notifications";
import { HostedDbWarning } from "@/components/hosted-db-warning";
import { UploadProgressProvider } from "@/components/upload-progress-store";
import { UploadProgressBar } from "@/components/upload-progress-bar";
import { AppBanner } from "@/components/app-banner";
import { readAppBannerConfig } from "@/lib/app-banner";
import { RefreshOnFocus } from "@/components/refresh-on-focus";

// Persistent left sidebar shell. Stays a Server Component so requireUser()
// runs here; the interactive pieces (nav links needing usePathname(), the
// collapse toggle needing click state, the account menu needing dropdown/
// hover state) live in SidebarShell and its children instead.
//
// Mobile collapse (<768px) is a CSS-only checkbox disclosure — no JS, no
// new dependency: the hidden checkbox's :checked state is read via the
// `peer` selector to reveal the <aside> (now rendered inside SidebarShell,
// but still SidebarShell's DOM output ends up as a sibling of this
// checkbox — component boundaries don't change DOM adjacency, so `peer`
// still resolves) that is otherwise display:none below the md breakpoint.
// Desktop icon-only collapse (SidebarShell's own state) is a completely
// separate, `md:`-scoped mechanism layered on top — see that file's header
// for why the two don't fight.
export default async function AppLayout({
  children,
}: {
  children: ReactNode;
}): Promise<JSX.Element> {
  // "app-shell", not the actual pathname: this layout wraps every route
  // under app/(app), Next layouts don't receive the current pathname as a
  // prop, and a per-request pathname isn't worth reaching for headers()
  // just to label this one line — the step breakdown below (requireUser,
  // budget, avatar) is what actually answers "is auth slow / is the
  // aggregate slow / is Storage signing slow," the same question
  // regardless of which page underneath the shell was being loaded. See
  // lib/perf-log.ts for the flag this is gated behind and the safety
  // contract .step()/.finish() follow.
  const timer = new RenderTimer("app-shell");

  const { user, profile } = await timer.step("require_user", requireUser());

  // getSidebarBudget, the avatar signed-url, and the sidebar-collapsed
  // cookie were previously three sequential `await`s here even though none
  // of the three depends on either of the others — all three only need
  // `user`/`profile`, already in hand above. Serializing them cost the sum
  // of their latencies on EVERY authenticated page load (this file wraps
  // every route under app/(app)); running them together costs only the
  // slowest one. `cookies()` is effectively free (no I/O, just the request
  // store), so folding it into the same Promise.all costs nothing and keeps
  // this block's shape obviously "everything independent, fetched
  // together" rather than "two parallel things plus one more await below".
  //
  // Each branch keeps its own fail-soft contract exactly as before:
  // getSidebarBudget already returns `null` on any internal failure (see
  // lib/sidebar-budget.ts's header — this is why a plain `await import()`
  // isn't enough on its own and the try/catch lives inside that function).
  // The avatar's try/catch is inlined into an async IIFE below so a signing
  // failure still degrades to `null` (AccountMenu's initials fallback)
  // instead of rejecting the whole Promise.all and taking the sidebar
  // (sign-out included) down with it — a bare `Promise.all([a, b, c])`
  // rejects as soon as ANY entry rejects, so leaving this branch unguarded
  // would turn "avatar image is broken" into "the whole page 500s", the
  // exact regression the try/catch under it existed to prevent before this
  // change.
  const [
    budget,
    decidableRequestCount,
    unreadNotificationCount,
    recentNotifications,
    avatarUrl,
    sidebarCollapsedCookie,
  ] = await Promise.all([
    timer.step("budget", getSidebarBudget(user.id, profile)),
    // Only approvers can decide anything, so only they pay for this read —
    // everyone else short-circuits to null without touching Postgres. Same
    // fail-soft contract as the budget beside it: the function swallows its
    // own errors, so it can sit in this Promise.all without a rejection
    // taking the whole sidebar (sign-out included) down.
    timer.step(
      "decidable_requests",
      isApprover(profile) ? getDecidableRequestCount(user.id, profile) : Promise.resolve(null),
    ),
    timer.step("unread_notifications", getUnreadNotificationCount(user.id)),
    timer.step("recent_notifications", getRecentNotifications(user.id)),
    // Same signed-url call profile/page.tsx makes for the same avatar —
    // AVATAR_TRANSFORM (lib/storage.ts) is shared between the two call
    // sites specifically so this and the profile page's own read land on
    // the same signedUrl() cache entry instead of paying for two
    // createSignedUrl calls per page load. A null avatar_storage_key (most
    // accounts never upload one) short-circuits before signedUrl() is even
    // called.
    timer.step(
      "avatar",
      (async (): Promise<string | null> => {
        if (!profile.avatar_storage_key) {
          return null;
        }
        try {
          return await signedUrl(profile.avatar_storage_key, 3600, AVATAR_TRANSFORM);
        } catch (error) {
          console.error("Failed to sign avatar URL for sidebar account menu", error);
          return null;
        }
      })(),
    ),
    // Read, not written, here — SidebarShell (a Client Component) is the
    // one that writes this cookie on toggle, via document.cookie, since
    // it's a pure display preference with no server-side consequence worth
    // a Server Action round trip. Reading it server-side is what lets the
    // very first paint of a hard reload already match the persisted choice
    // instead of rendering expanded and snapping to collapsed once React
    // hydrates. Not timed — the layout.tsx comment above already calls this
    // "effectively free (no I/O, just the request store)," and a step this
    // cheap is noise next to requireUser/budget/avatar.
    cookies(),
  ]);
  const sidebarCollapsed = sidebarCollapsedCookie.get("sidebar-collapsed")?.value === "1";
  const appBanner = readAppBannerConfig();
  const roleLabel = profile.role
    .replace("_", " ")
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

  timer.finish({ userId: user.id });

  return (
    <UploadProgressProvider>
      <UploadProgressBar />
      <HostedDbWarning />
      <div className="flex min-h-svh flex-col bg-background md:h-svh md:flex-row">
        <input type="checkbox" id="sidebar-toggle" className="peer hidden" />

        {/* md:sticky here is defensive, not load-bearing — and this row's
          height class is what decides whether it even needs to be.
          `min-h-svh` on the row above is a FLOOR: below `md`, that's the
          only height class in play, so the row (and <main> inside it) grows
          to fit content, `<main>` has no overflow constraint (its
          `overflow-y-auto` is now `md:`-scoped, see <main> below), and the
          document itself is what scrolls — <aside> isn't even sticky there
          (`md:sticky` doesn't apply), and isn't even rendered unless the
          mobile menu checkbox is toggled open.
          At `md` and up, `md:h-svh` on the row turns that floor into a
          ceiling too (an explicit `height` doesn't fight a `min-height` that
          it already satisfies), and `<main>` gains `md:overflow-y-auto`.
          Flex items default their automatic minimum size to their content
          size — UNLESS the item's own overflow is non-visible, in which
          case that minimum collapses to 0 (CSS Flexbox §4.5). Because
          <main>'s overflow is now non-visible at `md`+, it's free to be
          compressed to the row's capped cross-size instead of growing to
          fit its own content — that's what makes <main> actually clip and
          scroll internally at `md`+, rather than the document scrolling
          with <aside> dragged along for the ride. With the row height
          capped and <main> absorbing all the scroll internally, the
          document itself ends up exactly viewport-height and never
          scrolls — so <aside>'s `md:sticky md:top-0` never actually needs
          to "stick" against anything; kept anyway as a zero-cost guard
          against a future layout change reintroducing document-level
          scroll at that breakpoint. (An earlier version of this comment
          claimed <main>'s overflow-y-auto was unconditional and made it the
          real scroll container "at every breakpoint" — that was true only
          at `md`+; below `md` the document is what scrolls, and that half
          of the original comment, before it was "corrected", had it
          right.) */}
        <SidebarShell
          showAdminLinks={isAdmin(profile)}
          showAllowanceLink={isApprover(profile)}
          decidableRequestCount={decidableRequestCount}
          defaultCollapsed={sidebarCollapsed}
        />

        <div className="relative flex min-w-0 flex-1 flex-col md:h-svh">
          <TopBar
            unreadNotificationCount={unreadNotificationCount}
            initialNotifications={recentNotifications}
            currentUserId={user.id}
            email={user.email ?? ""}
            roleLabel={roleLabel}
            avatarUrl={avatarUrl}
            isAdmin={isAdmin(profile)}
            budget={budget}
          />
          {appBanner ? <AppBanner config={appBanner} /> : null}
          <RefreshOnFocus />

          {/* @container: makes step-rail.tsx's full-bleed header possible. The
          rail used to render inside the `mx-auto max-w-6xl` div below,
          which centers and caps page content — correct for page content,
          wrong for a header, since on anything wider than 1152px it left a
          gap on both sides that made the rail read as a floating panel
          instead of spanning edge-to-edge like the rest of this shell. The
          rail can't simply move to be a sibling of that div from a nested
          route layout (app/(app)/projects/[id]/layout.tsx has no way to
          render outside {children}'s slot), and it can't move up into this
          Server Component either (AppLayout sits above /projects/[id] in
          the tree and never receives that segment's `id` param, which
          StepRail's data — requireProject(id) — depends on). Marking <main>
          as a container and having step-rail.tsx size itself in `cqw`
          units against it is the one way to break the rail out to <main>'s
          true width without touching every other page under this layout.

          relative: <main> is this shell's only overflow:auto clip boundary
          at md+ (see the row's own comment above), but clipping only helps
          descendants whose containing block is actually <main> — an
          absolutely-positioned descendant with no positioned ancestor in
          between resolves its containing block all the way up past <main>
          (unaffected by its overflow) to the document root instead, and
          still counts toward the ROOT's scrollable area even though <main>
          visually clips it from view. Pages under this layout reliably hit
          this: Radix's Select renders a visually-hidden native <select>
          (and similar primitives render visually-hidden position:absolute
          inputs) as a plain descendant, not a portal, positioned at the
          visible trigger's on-page offset — hundreds/thousands of px down
          on a long form. Without `relative` here, that invisible element
          alone was enough to give <html> a real, scrollable-past-900px
          height (confirmed via CDP Page.getLayoutMetrics, not just a DOM
          scrollHeight quirk — window.scrollTo actually moved the page) even
          though every visible box measured exactly viewport-height: a
          second, phantom document-level scrollbar stacked on <main>'s own,
          on a page whose content was long enough to reach a Select this
          deep (character/page.tsx's Shooting Mode field). `relative` makes
          <main> the containing block for its own non-portaled absolutely-
          positioned descendants, so they clip and scroll with everything
          else instead of escaping to the root. */}
          <main className="relative min-h-0 min-w-0 flex-1 md:overflow-y-auto @container">
            {/* Centred and width-capped for ordinary pages, where a 6xl column
            is the readable line length. A project is the exception: its rail
            is a piece of chrome that must sit flush against the sidebar, and
            centring pushed it inward, leaving a band of empty page between
            the two — the rail looked detached from the app.
            has-[[data-project-shell]] lets the project layout opt out from
            the inside, without this Server Component needing a pathname it
            cannot read. */}
            <div className="mx-auto w-full max-w-6xl has-[[data-project-shell]]:max-w-none has-[[data-create-page]]:max-w-none">
              {children}
            </div>
          </main>
        </div>
      </div>
    </UploadProgressProvider>
  );
}
