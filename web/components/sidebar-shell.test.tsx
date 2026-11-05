// @vitest-environment jsdom
//
// jsdom, not the suite default (see vitest.config.ts) — AccountMenu (nested
// inside SidebarShell) renders DropdownMenu.Content through a Radix Portal,
// which needs a real `document`. Same reasoning as account-menu.test.tsx.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SidebarShell } from "./sidebar-shell";
import { EXPECTED_DB_VERSION } from "@/lib/version";

vi.mock("@/actions/auth", () => ({
  signOut: vi.fn(async () => undefined),
}));
vi.mock("@/actions/transfer", () => ({ passAllowance: vi.fn(async () => undefined) }));
vi.mock("@/actions/allowance", () => ({
  requestAllowance: vi.fn(async () => undefined),
  cancelAllowanceRequest: vi.fn(async () => undefined),
}));
// NavLinks (rendered inside SidebarShell) needs usePathname() for
// active-route highlighting — outside an actual Next router this returns
// null, and the component reads .startsWith() off it unconditionally.
// A vi.fn, not a fixed string: the route is what decides whether this strip
// renders at all inside a project, so tests have to be able to move it.
const mockPathname = vi.fn(() => "/projects");
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname(),
}));

afterEach(() => {
  cleanup();
  // Undo whatever the collapse toggle wrote so tests don't bleed into
  // each other via a real, process-wide jsdom `document`.
  document.cookie = "sidebar-collapsed=; path=/; max-age=0";
});

describe("SidebarShell", () => {
  it("shows allowance requests to an approver without exposing the admin-only destinations", () => {
    render(
      <SidebarShell
        showAdminLinks={false}
        showAllowanceLink={true}
        decidableRequestCount={null}
        defaultCollapsed={false}
        buildSha="10ba25c"
        dbVersion={EXPECTED_DB_VERSION}
      />,
    );

    expect(screen.getByRole("link", { name: "Allowance requests" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Tasks" })).toBeNull();
    for (const name of ["Accounts and Spending Control", "Users"]) {
      expect(screen.queryByRole("link", { name })).toBeNull();
    }

    // The Elements Library is NOT admin-gated, unlike the Character Library
    // whose sidebar slot it took: /library is one shared, admin-curated set,
    // while /elements is this account's own rows (elements.user_id). Pinned
    // on the non-admin case because that is the whole difference between the
    // two links, and a copy-paste into the showAdminLinks list would be
    // invisible to every other assertion here.
    expect(screen.getByRole("link", { name: "Elements Library" })).toBeTruthy();

    // The Character Library link is gone from the sidebar entirely — for an
    // admin too (asserted in the collapse test below, whose list no longer
    // names it). The ROUTE is untouched; only this entry was removed.
    expect(screen.queryByRole("link", { name: "Character Library" })).toBeNull();
  });

  it("expands by default, and clicking collapse switches every nav link to icon-only while keeping it reachable by name", async () => {
    const user = userEvent.setup();
    render(
      <SidebarShell
        showAdminLinks={true}
        showAllowanceLink={true}
        decidableRequestCount={null}
        defaultCollapsed={false}
        buildSha="10ba25c"
        dbVersion={EXPECTED_DB_VERSION}
      />,
    );

    // Expanded: label text is real, rendered content — not just present in
    // the DOM behind a CSS class jsdom can't evaluate — and it doesn't
    // carry the responsive hide class.
    const projectsLinkExpanded = screen.getByRole("link", { name: "Studio" });
    const expandedLabel = within(projectsLinkExpanded).getByText("Studio");
    expect(expandedLabel.className).not.toContain("md:hidden");

    await user.click(screen.getByRole("button", { name: /collapse sidebar/i }));

    // Every admin link is still reachable by its accessible name — the
    // destination didn't disappear, only the always-visible text did.
    for (const name of ["Studio", "Create", "Elements Library", "Users", "Allowance requests"]) {
      expect(screen.getByRole("link", { name })).toBeTruthy();
    }
    // Even with every admin link on. See the non-admin test above.
    expect(screen.queryByRole("link", { name: "Character Library" })).toBeNull();

    // The label span itself picked up the md:-scoped hide class — this is
    // the actual mechanism under test, not an assumption about jsdom
    // rendering CSS (it doesn't: Tailwind classes are inert strings here,
    // so asserting the class is present is the only non-vacuous check that
    // the collapsed branch actually ran).
    const projectsLinkCollapsed = screen.getByRole("link", { name: "Studio" });
    const collapsedLabel = within(projectsLinkCollapsed).getByText("Studio");
    expect(collapsedLabel.className).toContain("md:hidden");

    // The toggle itself flipped to the opposite affordance and announced
    // its new state.
    expect(screen.getByRole("button", { name: /expand sidebar/i })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /expand sidebar/i }).getAttribute("aria-pressed"),
    ).toBe("true");

    // Persisted for the next reload, not just held in React state.
    expect(document.cookie).toContain("sidebar-collapsed=1");
  });

  it("starts collapsed when the server already read a collapsed cookie", () => {
    render(
      <SidebarShell
        showAdminLinks={false}
        showAllowanceLink={false}
        decidableRequestCount={null}
        defaultCollapsed={true}
        buildSha="10ba25c"
        dbVersion={EXPECTED_DB_VERSION}
      />,
    );

    const projectsLink = screen.getByRole("link", { name: "Studio" });
    expect(within(projectsLink).getByText("Studio").className).toContain("md:hidden");
    expect(screen.queryByRole("button", { name: /collapse sidebar/i })).toBeNull();
    expect(screen.getByRole("button", { name: /expand sidebar/i })).toBeTruthy();
  });
});

describe("SidebarShell build/db version footer", () => {
  it("renders the matching version in the normal muted style, and copies the full string on click", async () => {
    const user = userEvent.setup();
    // jsdom has no Clipboard API implementation of its own, and
    // `navigator.clipboard` is a getter-only accessor — Object.assign can't
    // touch it, so it has to be replaced via defineProperty instead.
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(
      <SidebarShell
        showAdminLinks={false}
        showAllowanceLink={false}
        decidableRequestCount={null}
        defaultCollapsed={false}
        buildSha="10ba25c"
        dbVersion={EXPECTED_DB_VERSION}
      />,
    );

    const line = screen.getByRole("button", { name: `10ba25c · db ${EXPECTED_DB_VERSION}` });
    expect(line.className).not.toContain("text-warning");

    await user.click(line);
    expect(writeText).toHaveBeenCalledWith(`10ba25c · db ${EXPECTED_DB_VERSION}`);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("renders a mismatched db version as a warning", () => {
    render(
      <SidebarShell
        showAdminLinks={false}
        showAllowanceLink={false}
        decidableRequestCount={null}
        defaultCollapsed={false}
        buildSha="10ba25c"
        dbVersion="0001"
      />,
    );

    const line = screen.getByRole("button", { name: "10ba25c · db 0001" });
    expect(line.className).toContain("text-warning");
  });

  it("renders db ? in the normal (non-warning) style when the read failed or the migration hasn't landed", () => {
    render(
      <SidebarShell
        showAdminLinks={false}
        showAllowanceLink={false}
        decidableRequestCount={null}
        defaultCollapsed={false}
        buildSha="10ba25c"
        dbVersion={null}
      />,
    );

    const line = screen.getByRole("button", { name: "10ba25c · db ?" });
    expect(line.className).not.toContain("text-warning");
  });

  it("renders nothing when collapsed", () => {
    render(
      <SidebarShell
        showAdminLinks={false}
        showAllowanceLink={false}
        decidableRequestCount={null}
        defaultCollapsed={true}
        buildSha="10ba25c"
        dbVersion={EXPECTED_DB_VERSION}
      />,
    );

    expect(
      screen.queryByRole("button", { name: `10ba25c · db ${EXPECTED_DB_VERSION}` }),
    ).toBeNull();
  });
});

// Inside a project the rail is the navigation, and it carries its own
// "← Studio". A second vertical strip beside it is chrome with nothing
// left to do — the operator asked twice why there were still two sidebars.
describe("SidebarShell — the strip steps aside inside a project", () => {
  function renderAt(pathname: string) {
    mockPathname.mockReturnValue(pathname);
    const { container } = render(
      <SidebarShell
        showAdminLinks={false}
        showAllowanceLink={false}
        decidableRequestCount={null}
        defaultCollapsed={false}
        buildSha="10ba25c"
        dbVersion="0057"
      />,
    );
    return container.querySelector("aside")?.className ?? "";
  }

  it("stays visible on a project route, narrowed to icons rather than hidden", () => {
    const className = renderAt("/projects/abc/character");
    expect(className).not.toContain("md:hidden");
    expect(className).toContain("md:w-16");
  });

  it("is full width on the projects list, which grows no rail of its own", () => {
    const className = renderAt("/projects");
    expect(className).not.toContain("md:hidden");
    expect(className).toContain("md:w-64");
  });

  it("stays full width on the new-project form, which is not inside a project", () => {
    const className = renderAt("/projects/new");
    expect(className).not.toContain("md:hidden");
    expect(className).toContain("md:w-64");
  });
});

// The badge exists so an approver knows work is waiting without opening the
// page. These pin the two states that are easy to get backwards: a count
// that should show, and the two "nothing to show" values that must look
// identical — 0 ("no work") and null ("the read failed") both render
// nothing, because a sidebar that shouts about its own broken query is
// worse than one that stays quiet.
describe("SidebarShell allowance badge", () => {
  function renderWithCount(count: number | null): void {
    render(
      <SidebarShell
        showAdminLinks={false}
        showAllowanceLink={true}
        decidableRequestCount={count}
        defaultCollapsed={false}
        buildSha="abc1234"
        dbVersion="0074"
      />,
    );
  }

  it("shows the count when there is work waiting", () => {
    renderWithCount(3);
    expect(screen.getByLabelText("3 awaiting your decision").textContent).toBe("3");
  });

  it("caps the display at 9+ while keeping the real number for screen readers", () => {
    renderWithCount(12);
    // The visible glyph is capped so the pill cannot grow and shove the
    // label; the accessible name is not, because "9+" tells someone using a
    // screen reader less than "12" does and costs nothing to keep.
    expect(screen.getByLabelText("12 awaiting your decision").textContent).toBe("9+");
  });

  it.each([
    ["zero", 0],
    ["a failed read", null],
  ])("renders no badge for %s", (_label, count) => {
    renderWithCount(count as number | null);
    expect(screen.queryByLabelText(/awaiting your decision/)).toBeNull();
  });
});
