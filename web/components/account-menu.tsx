"use client";

// Sidebar footer's account control (app/(app)/layout.tsx, via
// sidebar-shell.tsx). Replaces the old stacked email/role/budget-meter/
// "Request more"/"Sign out" block — and the nav's standalone /profile link
// (nav-links.tsx) — with a single avatar button that opens a menu UPWARD
// (the footer sits at the bottom of the sidebar, so a downward menu would
// render off-screen). Radix DropdownMenu, controlled (`open`/
// `onOpenChange`) rather than left to Radix's own internal state, because
// hover has to drive the same `open` boolean click already does — see the
// pointer-enter/leave handlers below. Hover augments click; it never
// replaces it, since hover doesn't exist on touch and this product's users
// are explicitly expected on mobile (AGENTS.md).
//
// Every prop here is plain serialisable data computed server-side in
// AppLayout (email, role label, avatarUrl, isAdmin, the SidebarBudget
// snapshot) — never a function. The one exception, signOut, is imported
// directly from actions/auth.ts (a "use server" module) rather than passed
// down as a prop; Next serialises a "use server" export into a callable
// reference automatically, which is the one kind of function that IS safe
// to cross this boundary — see action-form.tsx's own header for the
// distinction. A plain closure prop from a Server Component would typecheck
// and build here exactly as easily and then 500 in production.
import { useEffect, useRef, useState } from "react";
import type { JSX, PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { signOut } from "@/actions/auth";
import { RequestAllowanceDialog } from "@/components/request-allowance-dialog";
import { PassCreditsDialog } from "@/components/pass-credits-dialog";
import { CancelAllowanceRequestDialog } from "@/components/cancel-allowance-request-dialog";
import {
  AccountFundsNote,
  BudgetMeter,
  BudgetSmallLine,
  PressureNote,
  budgetClassName,
  budgetPressure,
  selectBindingMeter,
} from "@/components/sidebar-budget";
import type { MeterWindow } from "@/components/sidebar-budget";
import type { SidebarBudget } from "@/lib/sidebar-budget";
import { cn } from "@/lib/utils";
import { remainingForDisplayUsd, formatUsd } from "@/lib/format-usd";
import { budgetTier } from "@/lib/budget-tier";
import type { BudgetTier } from "@/lib/budget-tier";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

const RING_RADIUS = 18;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/**
 * The avatar with a progress ring round it: the share of the binding
 * allowance still left, in the same colours as the dot meter. Drawn outside
 * the 32px avatar (inset -4px) so the trigger's layout doesn't move.
 */
function AccountAvatar({
  avatarUrl,
  email,
  ring = null,
}: {
  avatarUrl: string | null;
  email: string;
  /** Share left in [0, 1] and its tier; null draws no ring (no budget read). */
  ring?: { ratio: number; tier: BudgetTier } | null;
}): JSX.Element {
  return (
    <span className="relative flex size-8 shrink-0">
      <AvatarFace avatarUrl={avatarUrl} email={email} />
      {ring ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 40 40"
          className="pointer-events-none absolute -inset-1 size-10 -rotate-90"
        >
          <circle
            cx="20"
            cy="20"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="2"
            className="stroke-sidebar-border"
          />
          <circle
            cx="20"
            cy="20"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={RING_LENGTH}
            strokeDashoffset={RING_LENGTH * (1 - ring.ratio)}
            className={
              ring.tier === "critical"
                ? "stroke-destructive"
                : ring.tier === "warning"
                  ? "stroke-warning"
                  : "stroke-sidebar-primary"
            }
          />
        </svg>
      ) : null}
    </span>
  );
}

function AvatarFace({
  avatarUrl,
  email,
}: {
  avatarUrl: string | null;
  email: string;
}): JSX.Element {
  if (avatarUrl) {
    // No next/image, same reasoning avatar-upload.tsx's own comment gives:
    // a signed URL expires and is never a static/optimizable asset. object-
    // cover crops into the `resize: "contain"` frame lib/storage.ts's
    // AVATAR_TRANSFORM requests — identical trade avatar-upload.tsx already
    // makes for the same image at profile-page size.
    return (
      <img
        src={avatarUrl}
        alt=""
        width={32}
        height={32}
        className="size-8 shrink-0 rounded-full border border-sidebar-border object-cover"
      />
    );
  }
  // Fallback: initials, or "?" for the theoretical empty-email case —
  // never a broken image icon.
  const initial = email.trim().charAt(0).toUpperCase() || "?";
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-sidebar-border bg-sidebar-accent text-xs font-medium text-sidebar-accent-foreground">
      {initial}
    </span>
  );
}

export function AccountMenu({
  email,
  roleLabel,
  avatarUrl,
  isAdmin,
  budget,
  collapsed = false,
  placement = "sidebar",
}: {
  email: string;
  /** Already role.replace("_", " ") — see app/(app)/layout.tsx for why the raw enum value can't go through Tailwind's capitalize alone. */
  roleLabel: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  /** null means the read failed (bad env var or DB error) — see lib/sidebar-budget.ts. Degrades to "—", never a broken/empty menu. */
  budget: SidebarBudget | null;
  /** md+ only (sidebar-shell.tsx) — avatar becomes the trigger with no
   * email/role text beside it. Defaults false so this component doesn't
   * need a caller-side change everywhere it's already used/tested. */
  collapsed?: boolean;
  /** Top-bar placement keeps the same menu content but opens downward and
   * uses an avatar-only trigger. */
  placement?: "sidebar" | "topbar";
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  // Hover open/close run on delays so a pointer merely passing over the
  // trigger, or crossing the small visual gap between the trigger and the
  // `side="top"` content above it, doesn't flicker the menu open/shut.
  // Refs, not state — a pending timer id is never rendered, and putting it
  // in state would re-run this effect-free component on every tick for no
  // visible reason.
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const OPEN_DELAY_MS = 150;
  const CLOSE_DELAY_MS = 300;

  useEffect(() => {
    return () => {
      if (openTimer.current) clearTimeout(openTimer.current);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  function clearOpenTimer(): void {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }
  function clearCloseTimer(): void {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  // Shared by the trigger button and DropdownMenuContent below — attaching
  // the same pair to both is what lets the pointer travel from one to the
  // other without the leave-trigger timer winning the race: entering
  // either cancels any pending close.
  function onHoverEnter(event: ReactPointerEvent): void {
    // Touch (and pen) fire pointer events too, but this product's touch
    // users get click/tap only, unchanged — gate hover to real mice.
    if (event.pointerType !== "mouse") return;
    clearCloseTimer();
    if (!menuOpen && !openTimer.current) {
      openTimer.current = setTimeout(() => {
        openTimer.current = null;
        setMenuOpen(true);
      }, OPEN_DELAY_MS);
    }
  }
  function onHoverLeave(event: ReactPointerEvent): void {
    if (event.pointerType !== "mouse") return;
    clearOpenTimer();
    if (menuOpen && !closeTimer.current) {
      closeTimer.current = setTimeout(() => {
        closeTimer.current = null;
        setMenuOpen(false);
      }, CLOSE_DELAY_MS);
    }
  }
  /**
   * A click, an Escape or an outside press settles the menu, and cancels any
   * hover timer still in flight.
   *
   * Without this a pointer that arrives and clicks within OPEN_DELAY_MS left
   * its open timer pending: the click closed the menu and the stale timer
   * sprang it back open 150ms later, with nothing on screen explaining why.
   * Clicking to dismiss inside the delay is not an edge case — it is what
   * someone who already knows where the button is does every time.
   *
   * Radix drives this for the click path only; the hover timers call
   * setMenuOpen directly, so neither cancels itself here.
   */
  function handleOpenChange(next: boolean): void {
    clearOpenTimer();
    clearCloseTimer();
    setMenuOpen(next);
  }

  // Both allowance dialogs are rendered OUTSIDE DropdownMenuContent below,
  // as siblings of the DropdownMenu itself, and controlled from here. Radix
  // unmounts DropdownMenu.Content (and everything nested in it) the instant
  // the menu closes — which happens on the very click that would open one
  // of these dialogs, since their triggers are menu items. Nesting the
  // Dialogs inside the menu would have them torn down before they ever got
  // the chance to render open. See request-allowance-dialog.tsx's header
  // for the full reasoning; this is the documented Radix composition
  // pattern for "dialog opened from a menu item," not an improvised fix.
  const [requestDialogOpen, setRequestDialogOpen] = useState(false);
  const [passDialogOpen, setPassDialogOpen] = useState(false);
  const canPass = budget?.role === "editor" || budget?.role === "trusted_editor";
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);

  let binding: MeterWindow | null = null;
  let others: MeterWindow[] = [];
  if (budget) {
    const daily: MeterWindow = {
      period: "today",
      remainingUsd: budget.remainingUsd,
      capUsd: budget.capUsd,
      allowanceUsd: budget.capUsd,
      usedUsd: budget.dailyUsedUsd,
      heldUsd: budget.heldUsd,
    };
    const weekly: MeterWindow = {
      period: "this week",
      remainingUsd: budget.remainingWeeklyUsd,
      capUsd: budget.weeklyCapUsd,
      allowanceUsd: budget.weeklyBaseCapUsd,
      usedUsd: budget.weeklyUsedUsd,
      heldUsd: budget.heldUsd,
      grantUsd: budget.weeklyGrantUsd,
      grantExpiresAt: budget.weeklyGrantEarliestExpiresAt,
    };
    const hourly: MeterWindow | null =
      budget.hourlyCapUsd === null || budget.hourlyRemainingUsd === null
        ? null
        : {
            period: "this hour",
            remainingUsd: budget.hourlyRemainingUsd,
            capUsd: budget.hourlyCapUsd,
            allowanceUsd: budget.hourlyCapUsd,
            usedUsd: budget.hourlyUsedUsd,
            heldUsd: budget.heldUsd,
          };
    const windows = [
      ...(budget.dailyCapEnabled === false ? [] : [daily]),
      weekly,
      ...(hourly ? [hourly] : []),
    ];
    binding = selectBindingMeter(weekly, ...windows.filter((window) => window !== weekly));
    others = windows.filter((window) => window !== binding);
  }

  const ring = binding
    ? {
        ratio:
          binding.capUsd > 0 ? Math.min(Math.max(binding.remainingUsd / binding.capUsd, 0), 1) : 0,
        tier: budgetTier(binding.remainingUsd, binding.capUsd),
      }
    : null;

  return (
    <>
      {/* modal={false}: Radix's default modal mode sets `pointer-events:
          none` on <body> the instant Content mounts, so the page (this
          trigger included, since it lives outside the Content's Portal)
          stops receiving pointer events at all while the menu is open —
          real browsers simply never deliver our onPointerLeave in that
          state, silently breaking "moving away closes it". Non-modal keeps
          the trigger (and the content, which un-mounts on outside
          pointerdown either way) interactive throughout; Escape-closes and
          focus-return to the trigger are DismissableLayer/FocusScope
          behaviour, not modal-gated, so neither regresses. */}
      <DropdownMenu open={menuOpen} onOpenChange={handleOpenChange} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            onPointerEnter={onHoverEnter}
            onPointerLeave={onHoverLeave}
            // Real aria-label, not tooltip-only: when collapsed the email/
            // role text next to the avatar disappears (md+), so the
            // accessible name has to come from somewhere that doesn't
            // depend on that text being visible.
            aria-label={collapsed || placement === "topbar" ? `Account menu — ${email}` : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md p-2 text-left outline-none transition-[background-color,transform] duration-200 ease-out hover:-translate-y-px hover:bg-accent active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-ring",
              placement === "sidebar" &&
                "w-full hover:bg-sidebar-accent focus-visible:ring-sidebar-ring",
              // md:p-1 collapsed: paired with sidebar-shell.tsx's md:p-2 on
              // the rail itself, this leaves 40px of content box for the
              // 32px avatar instead of the 16px the two p-4/p-2 defaults
              // between them used to leave it. See that file's comment for
              // what the squeeze actually looked like.
              collapsed && "md:justify-center md:gap-0 md:p-1",
            )}
          >
            <AccountAvatar avatarUrl={avatarUrl} email={email} ring={ring} />
            {placement === "sidebar" ? (
              <span className={cn("flex min-w-0 flex-col", collapsed && "md:hidden")}>
                <span className="truncate text-sm text-sidebar-foreground">{email}</span>
                <span className="truncate text-xs text-muted-foreground">{roleLabel}</span>
              </span>
            ) : null}
          </button>
        </DropdownMenuTrigger>

        {/* side="top": this trigger lives at the bottom of the sidebar
            footer, so the menu has to open upward or it renders straight
            off the viewport — Radix flips automatically if there isn't
            room, but "top" is the correct default here, not a fallback.
            The same hover handlers as the trigger: entering the content
            (crossing from trigger into it) cancels any close already
            queued, so a menu opened by hover doesn't vanish while the
            pointer is mid-travel toward it. */}
        <DropdownMenuContent
          side={placement === "topbar" ? "bottom" : "top"}
          align={placement === "topbar" ? "end" : "start"}
          className="w-64"
          onPointerEnter={onHoverEnter}
          onPointerLeave={onHoverLeave}
        >
          <DropdownMenuLabel className="flex items-center gap-2 font-normal">
            <AccountAvatar avatarUrl={avatarUrl} email={email} ring={ring} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm">{email}</span>
              <span className="truncate text-xs text-muted-foreground">{roleLabel}</span>
            </span>
          </DropdownMenuLabel>

          <DropdownMenuSeparator />

          {!budget || !binding ? (
            // Fails soft, on purpose: an em dash, not a missing section and
            // not a thrown error — see lib/sidebar-budget.ts's file header.
            // The rest of the menu (profile, sign out) still renders below.
            <div className="px-2 py-1.5 text-xs text-muted-foreground">—</div>
          ) : (
            <div className="flex flex-col gap-1.5 px-2 py-1.5">
              <BudgetMeter
                window={binding}
                grantBreakdown={binding.period === "this week" ? budget : undefined}
              />
              {others.map((window) => (
                <BudgetSmallLine key={window.period} window={window} />
              ))}
              <AccountFundsNote underfunded={budget.accountUnderfunded} />
              {isAdmin &&
              budget.globalCapEnabled &&
              budget.globalRemainingUsd !== null &&
              budget.globalCapUsd !== null ? (
                <div className="flex flex-col gap-0.5">
                  <span className="truncate text-xs text-muted-foreground">
                    Team:{" "}
                    <span
                      className={cn(
                        "tabular-nums",
                        budgetClassName(budget.globalRemainingUsd, budget.globalCapUsd),
                      )}
                    >
                      {usdFormatter.format(remainingForDisplayUsd(budget.globalRemainingUsd))}
                    </span>{" "}
                    left {budget.globalCapPeriod === "weekly" ? "this week" : "today"}
                  </span>
                  {/* usedUsd derived, not a new SidebarBudget field — "no
                      new accounting" per the brief this came from.
                      globalRemainingUsd is documented (lib/sidebar-
                      budget.ts) as globalCapUsd minus today's global spend,
                      so reversing that arithmetic recovers the spend
                      exactly. */}
                  <PressureNote
                    pressure={budgetPressure(
                      budget.globalCapUsd - budget.globalRemainingUsd,
                      budget.globalCapUsd,
                    )}
                    audience="team"
                  />
                </div>
              ) : null}
            </div>
          )}

          {budget ? (
            <>
              <DropdownMenuSeparator />
              {/* Pending status takes priority over the request item — see
                  sidebar-budget.tsx's original comment (now here): an
                  account with a pending request has already asked, and the
                  database's own partial unique index
                  (allowance_requests_one_pending_per_user,
                  0032_allowance_requests.sql) refuses a second one anyway. */}
              {budget.pendingRequestUsd !== null && budget.pendingRequestId !== null ? (
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault();
                    setCancelDialogOpen(true);
                  }}
                >
                  Allowance request pending: {formatUsd(budget.pendingRequestUsd)} — Cancel
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault();
                    setRequestDialogOpen(true);
                  }}
                >
                  Request more
                </DropdownMenuItem>
              )}
              {canPass ? (
                <>
                  <DropdownMenuItem
                    onSelect={(event) => {
                      event.preventDefault();
                      setPassDialogOpen(true);
                    }}
                  >
                    Pass allowance
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/allowances">Passes this week</Link>
                  </DropdownMenuItem>
                </>
              ) : null}
            </>
          ) : null}

          <DropdownMenuSeparator />

          <DropdownMenuItem asChild>
            <Link href="/profile">View profile</Link>
          </DropdownMenuItem>

          {/* Not a DropdownMenuItem: SubmitButton's pending label comes from
              useFormStatus(), which needs a real <form> ancestor — asChild
              would hand the Item's role/keyboard-select props to that
              <form> itself rather than its submit button, and Enter/Space
              would then have nothing to actually click. A plain row styled
              to match the items above costs only Radix's own up/down
              arrow-key roving focus (Tab and click still reach it, and
              Escape still closes the menu and returns focus to the trigger,
              same as every other exit here) — an acceptable trade to keep
              the exact SubmitButton/pendingLabel behaviour intact. */}
          <div className="px-1 py-1">
            <ActionForm action={signOut} fallbackErrorMessage="Failed to sign out.">
              <SubmitButton
                variant="ghost"
                size="sm"
                className="w-full justify-start px-1 font-normal"
                pendingLabel="Signing out…"
              >
                Sign out
              </SubmitButton>
            </ActionForm>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      {budget ? (
        <>
          <RequestAllowanceDialog
            open={requestDialogOpen}
            onOpenChange={setRequestDialogOpen}
            state={budget.requestDialogState}
            weeklyRemainingUsd={budget.remainingWeeklyUsd}
            weeklyCapUsd={budget.weeklyCapUsd}
          />
          {canPass ? (
            <PassCreditsDialog
              open={passDialogOpen}
              onOpenChange={setPassDialogOpen}
              senderId={budget.userId}
              senderRole={budget.role}
              headroomUsd={budget.remainingWeeklyUsd}
              recipients={budget.transferRecipients}
            />
          ) : null}
          {budget.pendingRequestId !== null && budget.pendingRequestUsd !== null ? (
            <CancelAllowanceRequestDialog
              open={cancelDialogOpen}
              onOpenChange={setCancelDialogOpen}
              requestId={budget.pendingRequestId}
              requestedUsd={budget.pendingRequestUsd}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}
