// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/actions/account", () => ({
  setAccountRole: vi.fn(async () => undefined),
  demoteAdmin: vi.fn(async () => undefined),
}));
vi.mock("@/components/weekly-allowance-dialog", () => ({ WeeklyAllowanceDialog: () => null }));
vi.mock("@/components/deactivate-account-dialog", () => ({ DeactivateAccountDialog: () => null }));
vi.mock("@/components/promote-admin-dialog", () => ({
  PromoteAdminDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="promote-admin" /> : null,
}));
vi.mock("@/components/burn-drawer", () => ({
  BurnDrawer: ({ account }: { account: { email: string; weekSpentUsd: number } }) => (
    <div data-testid="burn-drawer">
      {account.email} {account.weekSpentUsd}
    </div>
  ),
}));

import { setAccountRole } from "@/actions/account";
import { UserRowActions } from "./user-row-actions";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("UserRowActions role menu", () => {
  it("has one Change role… item instead of one item per role", async () => {
    const user = userEvent.setup();
    render(<UserRowActions userId="u-1" email="a@example.com" role="editor" allowance={null} />);

    await user.click(screen.getByRole("button", { name: /Actions for a@example.com/ }));
    const labels = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(labels).toEqual(["Change role…", "Deactivate account"]);
  });

  it("sets the role picked in the Change role modal", async () => {
    const user = userEvent.setup();
    render(<UserRowActions userId="u-1" email="a@example.com" role="editor" allowance={null} />);

    await user.click(screen.getByRole("button", { name: /Actions for a@example.com/ }));
    await user.click(screen.getByRole("menuitem", { name: "Change role…" }));
    await user.click(screen.getByRole("radio", { name: /Hybrid Editor/ }));
    await user.click(screen.getByRole("button", { name: "Change role" }));
    expect(setAccountRole).toHaveBeenCalledWith("u-1", "hybrid_editor");
  });

  it("offers Change role… on an admin row only when it can be demoted", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <UserRowActions
        userId="u-5"
        email="e@example.com"
        role="admin"
        allowance={null}
        allowanceOnly
      />,
    );
    await user.click(screen.getByRole("button", { name: /Actions for e@example.com/ }));
    expect(screen.queryByRole("menuitem", { name: "Change role…" })).toBeNull();
    unmount();

    render(
      <UserRowActions
        userId="u-5"
        email="e@example.com"
        role="admin"
        allowance={null}
        allowanceOnly
        canDemote
      />,
    );
    await user.click(screen.getByRole("button", { name: /Actions for e@example.com/ }));
    expect(screen.getByRole("menuitem", { name: "Change role…" })).toBeTruthy();
  });

  it("opens the burn drawer from View burn", async () => {
    const user = userEvent.setup();
    render(
      <UserRowActions
        userId="u-3"
        email="c@example.com"
        role="editor"
        allowance={null}
        burn={{ weekSpentUsd: 70.25, weekTotalUsd: 700, dailyAllowanceUsd: null }}
      />,
    );
    expect(screen.queryByTestId("burn-drawer")).toBeNull();
    await user.click(screen.getByRole("button", { name: /Actions for c@example.com/ }));
    await user.click(screen.getByRole("menuitem", { name: "View burn" }));
    expect(screen.getByTestId("burn-drawer").textContent).toBe("c@example.com 70.25");
  });

  it("leaves View burn out when the row has no burn data", async () => {
    const user = userEvent.setup();
    render(<UserRowActions userId="u-4" email="d@example.com" role="editor" allowance={null} />);
    await user.click(screen.getByRole("button", { name: /Actions for d@example.com/ }));
    expect(screen.queryByRole("menuitem", { name: "View burn" })).toBeNull();
  });
});
