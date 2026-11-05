// @vitest-environment jsdom
//
// Only .test.tsx file in this repo — everything else is pure-function
// logic under vitest.config.ts's default `environment: "node"`. Radix's
// DropdownMenu.Content renders through a Portal, which React's server
// renderer drops entirely and which needs a real `document` to attach to
// (see @radix-ui/react-portal), so this file scopes jsdom to itself via
// the pragma above rather than flipping the whole suite to jsdom — every
// other test file gets to keep the faster, DOM-free "node" environment.
//
// actions/auth.ts and actions/allowance.ts are mocked below not because
// their logic is under test here (it already has its own coverage —
// lib/spend.test.ts, actions/allowance.test.ts) but because importing them
// for real pulls in next/headers' cookies() (actions/auth.ts ->
// lib/supabase/server.ts), which throws outside an actual Next request —
// exactly the kind of import-time landmine this file's own module-load
// concerns (lib/sidebar-budget.ts's header) warn about elsewhere.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountMenu } from "./account-menu";
import type { SidebarBudget } from "@/lib/sidebar-budget";

vi.mock("@/actions/auth", () => ({
  signOut: vi.fn(async () => undefined),
}));
vi.mock("@/actions/transfer", () => ({ passAllowance: vi.fn(async () => undefined) }));
vi.mock("@/actions/allowance", () => ({
  requestAllowance: vi.fn(async () => undefined),
  cancelAllowanceRequest: vi.fn(async () => undefined),
}));

afterEach(() => {
  cleanup();
});

const BASE_BUDGET: SidebarBudget = {
  userId: "sender",
  role: "editor",
  transferRecipients: [
    { id: "peer", username: "Ana", email: "ana@example.com", role: "trusted_editor" },
  ],
  grantedInUsd: 0,
  receivedUsd: 0,
  passedOutUsd: 0,
  remainingUsd: 3,
  capUsd: 5,
  dailyUsedUsd: 2,
  remainingWeeklyUsd: 7,
  weeklyCapUsd: 10,
  weeklyUsedUsd: 3,
  weeklyBaseCapUsd: 10,
  weeklyGrantUsd: 0,
  heldUsd: 0,
  weeklyGrantCount: 0,
  weeklyGrantEarliestExpiresAt: null,
  hourlyRemainingUsd: null,
  hourlyCapUsd: null,
  hourlyUsedUsd: 0,
  globalRemainingUsd: 40,
  globalCapUsd: 100,
  globalCapEnabled: true,
  globalCapPeriod: "daily",
  requestDialogState: "normal",
  pendingRequestUsd: null,
  pendingRequestId: null,
  accountUnderfunded: false,
  accountFundsUsd: null,
};

// userEvent, not fireEvent.click: Radix's DropdownMenuTrigger opens on
// pointerdown (for touch/mouse responsiveness), and fireEvent.click alone
// never dispatches the pointerdown jsdom needs to see first — userEvent
// replays the full realistic event sequence a real click produces.
async function openMenu(user: ReturnType<typeof userEvent.setup>, email: string): Promise<void> {
  await user.click(screen.getByRole("button", { name: new RegExp(email) }));
  // Radix mounts DropdownMenu.Content asynchronously (focus-scope setup) —
  // findBy* polls instead of assuming it's present on the next tick.
  await screen.findByRole("menuitem", { name: /view profile/i });
}

describe("AccountMenu — passing", () => {
  it("keeps the pass trigger at zero headroom with a request pending", async () => {
    const user = userEvent.setup();
    render(
      <AccountMenu
        email="sender@example.com"
        roleLabel="Editor"
        avatarUrl={null}
        isAdmin={false}
        budget={{
          ...BASE_BUDGET,
          remainingWeeklyUsd: 0,
          pendingRequestId: "pending",
          pendingRequestUsd: 5,
        }}
      />,
    );
    await openMenu(user, "sender@example.com");
    expect(screen.getByRole("menuitem", { name: "Passes this week" }).getAttribute("href")).toBe(
      "/allowances",
    );
    await user.click(screen.getByRole("menuitem", { name: "Pass credits" }));
    expect(await screen.findByRole("dialog", { name: "Pass credits" })).toBeTruthy();
    expect(screen.getByText("Remaining this week: 0 cr")).toBeTruthy();
  });

  it("does not offer passing to admins", async () => {
    const user = userEvent.setup();
    render(
      <AccountMenu
        email="admin@example.com"
        roleLabel="Admin"
        avatarUrl={null}
        isAdmin
        budget={{ ...BASE_BUDGET, role: "admin", transferRecipients: [] }}
      />,
    );
    await openMenu(user, "admin@example.com");
    expect(screen.queryByRole("menuitem", { name: "Pass credits" })).toBeNull();
  });
});

describe("AccountMenu — account funds", () => {
  // The live case this note was built for: the menu read "$3.06 left" while
  // the fal account held $1.56. Both numbers were correct and the smaller,
  // binding one was the one nobody could see — an editor's first hint was a
  // render refused after they had already paid to build the frames.
  it("warns when the account holds less than the allowance still claims", async () => {
    const user = userEvent.setup();
    render(
      <AccountMenu
        email="test2@yopmail.com"
        roleLabel="Editor"
        avatarUrl={null}
        isAdmin={false}
        budget={{ ...BASE_BUDGET, accountUnderfunded: true }}
      />,
    );
    await openMenu(user, "test2@yopmail.com");

    expect(screen.getByText(/shared account is low/i)).toBeTruthy();
    // Says what to do. "Renders may fail" with no next step relocates the
    // confusion rather than removing it.
    expect(screen.getByText(/ask an admin to add funds/i)).toBeTruthy();
  });

  it("stays silent when the account can cover the allowance", async () => {
    const user = userEvent.setup();
    render(
      <AccountMenu
        email="test2@yopmail.com"
        roleLabel="Editor"
        avatarUrl={null}
        isAdmin={false}
        budget={BASE_BUDGET}
      />,
    );
    await openMenu(user, "test2@yopmail.com");

    // The negative control. Without this, a note hardcoded to always render
    // would satisfy the test above — and a permanent warning is a warning
    // everyone learns to stop reading.
    expect(screen.queryByText(/shared account is low/i)).toBeNull();
  });

  it("never shows the account balance to an editor", async () => {
    // accountFundsUsd is null for non-admins by construction
    // (lib/sidebar-budget.ts). This pins that the note carries no figure of
    // its own either — an editor cannot act on the balance, and putting the
    // company's cash position in front of twenty people on every page render
    // says more than they need.
    const user = userEvent.setup();
    render(
      <AccountMenu
        email="test2@yopmail.com"
        roleLabel="Editor"
        avatarUrl={null}
        isAdmin={false}
        budget={{ ...BASE_BUDGET, accountUnderfunded: true }}
      />,
    );
    await openMenu(user, "test2@yopmail.com");

    const note = screen.getByText(/shared account is low/i);
    expect(note.textContent).not.toMatch(/\$/);
  });
});

describe("AccountMenu", () => {
  it("renders every item — profile, sign out, and the healthy-budget request control", async () => {
    const user = userEvent.setup();
    render(
      <AccountMenu
        email="test1@yopmail.com"
        roleLabel="Editor"
        avatarUrl={null}
        isAdmin={false}
        budget={BASE_BUDGET}
      />,
    );
    await openMenu(user, "test1@yopmail.com");

    expect(screen.getByRole("menuitem", { name: /view profile/i })).toBeTruthy();
    expect(screen.getByText("Sign out")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /^request more$/i })).toBeTruthy();
    // Budget meter presentation survived the move intact — both windows
    // show. The binding window (daily, here — 3/5 = 60% left vs. weekly's
    // 7/10 = 70%) now shows the derivation (Part 2: allowance/used/left),
    // not just the old bare "X of Y left" line — see components/sidebar-
    // budget.tsx's BudgetMeter.
    expect(screen.getByText(/left this week/)).toBeTruthy();
    expect(screen.getByText("1,000 cr allowance")).toBeTruthy();
    expect(screen.getByText("-400 cr used")).toBeTruthy();
    expect(screen.getByText(/600 cr left/)).toBeTruthy();
    // Nothing in flight in BASE_BUDGET, so no hold line — the ordinary
    // three-line breakdown is unchanged by the hold feature.
    expect(screen.queryByText(/on hold/)).toBeNull();
    // isAdmin: false — no team figure.
    expect(screen.queryByText(/Team:/)).toBeNull();
  });

  // Pressing Generate takes the estimate out of the balance immediately
  // (lib/spend.ts's getInFlightSpend, folded into every displayed figure).
  // This is the line that tells an operator WHY "left" dropped without them
  // being billed for anything — without it the number moves for no visible
  // reason, which is the same complaint the allowance breakdown itself was
  // added to answer.
  it("shows renders in flight as a hold, on its own line, and the breakdown still adds up", async () => {
    const user = userEvent.setup();
    render(
      <AccountMenu
        email="test1@yopmail.com"
        roleLabel="Editor"
        avatarUrl={null}
        isAdmin={false}
        budget={{
          ...BASE_BUDGET,
          // $1 held for a queued render: already subtracted from BOTH
          // remaining figures by getSidebarBudget, exactly as the server
          // enforces it.
          heldUsd: 1,
          remainingUsd: BASE_BUDGET.remainingUsd - 1,
          remainingWeeklyUsd: BASE_BUDGET.remainingWeeklyUsd - 1,
        }}
      />,
    );
    await openMenu(user, "test1@yopmail.com");

    // Held is NOT folded into "used" — used money is billed and gone, held
    // money comes back if the render never lands.
    expect(screen.getByText("-400 cr used")).toBeTruthy();
    expect(screen.getByText("-200 cr on hold (rendering)")).toBeTruthy();
    // 1000 allowance - 400 used - 200 held = 400 left. The arithmetic on
    // screen has to close, or the hold line is just decoration.
    expect(screen.getByText(/400 cr left/)).toBeTruthy();
  });

  it("shows the team figure for admins", async () => {
    const user = userEvent.setup();
    render(
      <AccountMenu
        email="admin@yopmail.com"
        roleLabel="Admin"
        avatarUrl={null}
        isAdmin={true}
        budget={BASE_BUDGET}
      />,
    );
    await openMenu(user, "admin@yopmail.com");

    expect(screen.getByText(/Team:/)).toBeTruthy();
    expect(screen.getByText(/\$40\.00/)).toBeTruthy();
  });

  it("shows a warning pressure note in visible text once a line crosses 70% consumed", async () => {
    const user = userEvent.setup();
    // Daily stays at BASE_BUDGET's 3/5 = 60% remaining. Weekly drops to $3
    // remaining of $10 (30% remaining, $7 used = exactly the 70% consumed
    // warning threshold) — the smaller remaining fraction, so weekly is now
    // the BINDING meter (selectBindingMeter) and gets the full BudgetMeter,
    // with the pressure note attached.
    const warm: SidebarBudget = {
      ...BASE_BUDGET,
      weeklyUsedUsd: 7,
      remainingWeeklyUsd: 3,
    };
    render(
      <AccountMenu
        email="test1@yopmail.com"
        roleLabel="Editor"
        avatarUrl={null}
        isAdmin={false}
        budget={warm}
      />,
    );
    await openMenu(user, "test1@yopmail.com");

    // Real visible text, not just a colour class — an accessible-name-free
    // assertion that would still pass if the pressure note only ever set a
    // className would be the exact status-icon.tsx mistake this brief warns
    // against; asserting the text itself rules that out.
    expect(screen.getByText("Nearing limit")).toBeTruthy();
  });

  it("shows a critical pressure note pointing at requesting more once a line crosses 90% consumed", async () => {
    const user = userEvent.setup();
    const hot: SidebarBudget = {
      ...BASE_BUDGET,
      weeklyUsedUsd: 9.5,
      remainingWeeklyUsd: 0.5,
    };
    render(
      <AccountMenu
        email="test1@yopmail.com"
        roleLabel="Editor"
        avatarUrl={null}
        isAdmin={false}
        budget={hot}
      />,
    );
    await openMenu(user, "test1@yopmail.com");

    expect(screen.getByText(/Over budget — request more/)).toBeTruthy();
  });

  it("renders an over-spent (negative remaining) line without crashing, and flags it critical", async () => {
    const user = userEvent.setup();
    const overspent: SidebarBudget = {
      ...BASE_BUDGET,
      remainingUsd: -1,
      dailyUsedUsd: 6,
      remainingWeeklyUsd: -3,
      weeklyUsedUsd: 13,
    };
    render(
      <AccountMenu
        email="test1@yopmail.com"
        roleLabel="Editor"
        avatarUrl={null}
        isAdmin={false}
        budget={overspent}
      />,
    );
    await openMenu(user, "test1@yopmail.com");

    // Both windows are over cap here (daily -1/5, weekly -3/10), so both the
    // binding meter's PressureNote and the small line's inline note show the
    // critical copy — getAllByText, not getByText, since more than one
    // match is the correct outcome for this fixture, not a bug.
    expect(screen.getAllByText(/Over budget — request more/).length).toBeGreaterThan(0);
  });

  it("gives a non-admin no team pressure note at any pressure level — there is no team line to attach one to", async () => {
    const user = userEvent.setup();
    // globalRemainingUsd/globalCapUsd would read as deep into critical
    // territory if this were shown at all — the point is that it never is,
    // for a non-admin, regardless of how hot the (invisible to them) team
    // figure runs.
    const hotTeamButNonAdmin: SidebarBudget = {
      ...BASE_BUDGET,
      globalRemainingUsd: 1,
      globalCapUsd: 100,
    };
    render(
      <AccountMenu
        email="test1@yopmail.com"
        roleLabel="Editor"
        avatarUrl={null}
        isAdmin={false}
        budget={hotTeamButNonAdmin}
      />,
    );
    await openMenu(user, "test1@yopmail.com");

    expect(screen.queryByText(/Team:/)).toBeNull();
    expect(screen.queryByText(/Team ceiling/)).toBeNull();
    expect(screen.queryByText(/Team spend climbing/)).toBeNull();
  });

  it("shows the admin team line's critical note pointing at the team ceiling, not the admin's own cap", async () => {
    const user = userEvent.setup();
    const teamCritical: SidebarBudget = {
      ...BASE_BUDGET,
      globalRemainingUsd: 5,
      globalCapUsd: 100,
    };
    render(
      <AccountMenu
        email="admin@yopmail.com"
        roleLabel="Admin"
        avatarUrl={null}
        isAdmin={true}
        budget={teamCritical}
      />,
    );
    await openMenu(user, "admin@yopmail.com");

    expect(screen.getByText(/Team:/)).toBeTruthy();
    expect(screen.getByText(/Team ceiling binding, not your own/)).toBeTruthy();
  });

  it("replaces the request-more trigger with the pending-cancel item when a request is pending", async () => {
    const user = userEvent.setup();
    const pending: SidebarBudget = {
      ...BASE_BUDGET,
      pendingRequestUsd: 15,
      pendingRequestId: "req-1",
    };
    render(
      <AccountMenu
        email="test1@yopmail.com"
        roleLabel="Editor"
        avatarUrl={null}
        isAdmin={false}
        budget={pending}
      />,
    );
    await openMenu(user, "test1@yopmail.com");

    expect(screen.queryByRole("menuitem", { name: /^request more$/i })).toBeNull();
    expect(screen.getByText(/Allowance request pending: 3,000 cr/)).toBeTruthy();
  });

  it("degrades to a fail-soft dash, not a broken menu, when the budget read failed", async () => {
    const user = userEvent.setup();
    render(
      <AccountMenu
        email="test1@yopmail.com"
        roleLabel="Editor"
        avatarUrl={null}
        isAdmin={false}
        budget={null}
      />,
    );
    await openMenu(user, "test1@yopmail.com");

    // The one visible trace of lib/sidebar-budget.ts's fail-soft catch —
    // see that file's header. Everything else in the menu still works.
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /view profile/i })).toBeTruthy();
    expect(screen.getByText("Sign out")).toBeTruthy();
    // No request control at all when there's nothing to request against —
    // budget === null means there's no requestDialogState to show either.
    expect(screen.queryByRole("menuitem", { name: /request more/i })).toBeNull();
  });

  it("falls back to an initial when there is no avatar", async () => {
    render(
      <AccountMenu
        email="zzz@yopmail.com"
        roleLabel="Editor"
        avatarUrl={null}
        isAdmin={false}
        budget={BASE_BUDGET}
      />,
    );
    expect(screen.getAllByText("Z").length).toBeGreaterThan(0);
  });

  it("renders every item with the menu opened, collapsed or not — collapse only ever touches the closed trigger row", async () => {
    for (const collapsed of [false, true]) {
      const user = userEvent.setup();
      render(
        <AccountMenu
          email="test1@yopmail.com"
          roleLabel="Editor"
          avatarUrl={null}
          isAdmin={false}
          budget={BASE_BUDGET}
          collapsed={collapsed}
        />,
      );
      await openMenu(user, "test1@yopmail.com");

      // The opened DropdownMenuContent is untouched by `collapsed` — same
      // items, same budget presentation, every time.
      expect(screen.getByRole("menuitem", { name: /view profile/i })).toBeTruthy();
      expect(screen.getByText("Sign out")).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: /^request more$/i })).toBeTruthy();
      expect(screen.getByText(/left this week/)).toBeTruthy();

      cleanup();
    }
  });

  it("collapses the trigger to an avatar-only button with a real aria-label, not just visible text", async () => {
    render(
      <AccountMenu
        email="collapsed@yopmail.com"
        roleLabel="Editor"
        avatarUrl={null}
        isAdmin={false}
        budget={BASE_BUDGET}
        collapsed={true}
      />,
    );

    // Accessible name comes from aria-label once the email/role text next
    // to the avatar is hidden — this is the same trigger element queried by
    // its (now non-visible-text-derived) name.
    const trigger = screen.getByRole("button", { name: /account menu.*collapsed@yopmail\.com/i });
    // The actual mechanism: the wrapping span around email+role carries the
    // responsive hide class. jsdom never applies real CSS, so checking the
    // class directly is the only way this assertion can fail if the
    // collapsed branch were ever dropped or inverted.
    const emailSpan = within(trigger).getByText("collapsed@yopmail.com");
    expect(emailSpan.parentElement?.className).toContain("md:hidden");
  });

  it("uncollapsed, the trigger has no aria-label and relies on its visible text", () => {
    render(
      <AccountMenu
        email="expanded@yopmail.com"
        roleLabel="Editor"
        avatarUrl={null}
        isAdmin={false}
        budget={BASE_BUDGET}
        collapsed={false}
      />,
    );

    const trigger = screen.getByRole("button", { name: /expanded@yopmail\.com/i });
    expect(trigger.getAttribute("aria-label")).toBeNull();
    const emailSpan = within(trigger).getByText("expanded@yopmail.com");
    expect(emailSpan.parentElement?.className).not.toContain("md:hidden");
  });

  it("opens on hover after a short delay and closes after the pointer leaves, without changing the click path", async () => {
    // OPEN_DELAY_MS/CLOSE_DELAY_MS are only 150ms/300ms of real time, which
    // isn't enough headroom to assert against on a loaded CI runner — the
    // open timer can fire before a "still closed" assertion runs right
    // after user.hover(). Fake timers let us step past each delay by an
    // exact amount instead of racing the wall clock, so the pre/post-delay
    // assertions are deterministic regardless of runner speed.
    // Mirrors the unexported OPEN_DELAY_MS/CLOSE_DELAY_MS constants inside
    // account-menu.tsx — they're component-internal, so the only way to
    // reference the real values here is to keep these in sync with them.
    const OPEN_DELAY_MS = 150;
    const CLOSE_DELAY_MS = 300;

    vi.useFakeTimers();
    try {
      render(
        <AccountMenu
          email="hover@yopmail.com"
          roleLabel="Editor"
          avatarUrl={null}
          isAdmin={false}
          budget={BASE_BUDGET}
        />,
      );
      const trigger = screen.getByRole("button", { name: /hover@yopmail\.com/i });

      // fireEvent, not userEvent, for the hover itself: userEvent's own
      // internal wait drains a microtask queue by checking for a `jest`
      // global that vitest's fake timers never satisfy, which deadlocks the
      // await forever. fireEvent dispatches the pointer event synchronously
      // and account-menu.tsx only reads event.pointerType off it, so this
      // observes the same handler the real pointer path drives.
      act(() => {
        fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
      });
      expect(screen.queryByRole("menuitem", { name: /view profile/i })).toBeNull();

      act(() => {
        vi.advanceTimersByTime(OPEN_DELAY_MS + 1);
      });
      expect(screen.getByRole("menuitem", { name: /view profile/i })).toBeTruthy();

      act(() => {
        fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
      });
      // Still open immediately after unhover: this is the whole point of
      // CLOSE_DELAY_MS — a pointer merely passing over the trigger on its
      // way elsewhere shouldn't slam the menu shut.
      expect(screen.getByRole("menuitem", { name: /view profile/i })).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(CLOSE_DELAY_MS + 1);
      });
      expect(screen.queryByRole("menuitem", { name: /view profile/i })).toBeNull();
    } finally {
      // Unconditional restore so a thrown assertion above can't leak fake
      // timers into the rest of this file's tests, which rely on real ones.
      vi.useRealTimers();
    }

    // Click still opens and closes it too, exactly as before hover existed.
    // This runs on real timers (restored above) since it doesn't depend on
    // the hover delays.
    //
    // THIS HALF WAS THE SUITE'S ONE INTERMITTENT FAILURE, and the widened
    // timeouts below were the wrong fix — they treated a real bug as a slow
    // runner. userEvent's click fires pointerenter first, which scheduled a
    // hover-open timer; when the two clicks landed inside OPEN_DELAY_MS of
    // that (a FAST run, not a slow one) the stale timer fired after the second
    // click and re-opened the menu, so the close never came. account-menu.tsx
    // now cancels both hover timers in onOpenChange, which is the case below
    // this one. The generous timeouts stay: they cost nothing on a green run
    // and the suite really does share 168 files across workers.
    //
    // Keeping fake timers through this half — the obvious way to delete the
    // race rather than widen it — was tried and does NOT work: userEvent
    // deadlocks on the missing `jest` global exactly as the pointer comment
    // above describes, and `advanceTimers` does not rescue it. The test hangs
    // until vitest kills it. So the wall clock stays, and only its budget
    // changes.
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: /hover@yopmail\.com/i });
    await user.click(trigger);
    await screen.findByRole("menuitem", { name: /view profile/i }, { timeout: 10_000 });
    await user.click(trigger);
    await waitFor(
      () => expect(screen.queryByRole("menuitem", { name: /view profile/i })).toBeNull(),
      { timeout: 10_000 },
    );
  }, 20_000);

  it("a click that dismisses the menu wins over a hover timer still in flight", () => {
    // The bug this pins: a pointer arriving and clicking within OPEN_DELAY_MS
    // left an open timer pending, and it re-opened the menu the click had just
    // closed. Someone who knows where the button is clicks well inside 150ms,
    // so this was the common path, not the corner.
    //
    // Fake timers and fireEvent for the same reasons the case above gives:
    // userEvent deadlocks under vitest's fake timers, and Radix's trigger
    // toggles on pointerdown, so a synthetic pointerdown drives the real
    // click path.
    const OPEN_DELAY_MS = 150;

    vi.useFakeTimers();
    try {
      render(
        <AccountMenu
          email="hover@yopmail.com"
          roleLabel="Editor"
          avatarUrl={null}
          isAdmin={false}
          budget={BASE_BUDGET}
        />,
      );
      const trigger = screen.getByRole("button", { name: /hover@yopmail\.com/i });

      act(() => {
        fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
        fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
      });
      expect(screen.getByRole("menuitem", { name: /view profile/i })).toBeTruthy();

      act(() => {
        fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
      });
      expect(screen.queryByRole("menuitem", { name: /view profile/i })).toBeNull();

      act(() => {
        vi.advanceTimersByTime(OPEN_DELAY_MS + 1);
      });
      expect(screen.queryByRole("menuitem", { name: /view profile/i })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
