import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/actions/account", () => ({
  setAccountRole: vi.fn(async () => undefined),
  demoteAdmin: vi.fn(async () => undefined),
}));
vi.mock("@/components/weekly-allowance-dialog", () => ({ WeeklyAllowanceDialog: () => null }));
vi.mock("@/components/deactivate-account-dialog", () => ({ DeactivateAccountDialog: () => null }));
vi.mock("@/components/promote-admin-dialog", () => ({ PromoteAdminDialog: () => null }));

import { setAccountRole } from "@/actions/account";
import { UserRowActions } from "./user-row-actions";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("UserRowActions role menu", () => {
  it("offers every other non-admin role, the new two included, and sets the one picked", async () => {
    const user = userEvent.setup();
    render(<UserRowActions userId="u-1" email="a@example.com" role="editor" allowance={null} />);

    await user.click(screen.getByRole("button", { name: /Actions for a@example.com/ }));
    const labels = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(labels).toEqual(
      expect.arrayContaining(["Make trusted", "Make Hybrid Editor", "Make AI Animator", "Make admin"]),
    );
    expect(labels).not.toContain("Make editor");

    await user.click(screen.getByRole("menuitem", { name: "Make Hybrid Editor" }));
    expect(setAccountRole).toHaveBeenCalledWith("u-1", "hybrid_editor");
  });

  it("lets a Hybrid Editor be moved back to editor", async () => {
    const user = userEvent.setup();
    render(
      <UserRowActions userId="u-2" email="b@example.com" role="hybrid_editor" allowance={null} />,
    );

    await user.click(screen.getByRole("button", { name: /Actions for b@example.com/ }));
    expect(screen.queryByRole("menuitem", { name: "Make Hybrid Editor" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Make editor" }));
    expect(setAccountRole).toHaveBeenCalledWith("u-2", "editor");
  });
});
