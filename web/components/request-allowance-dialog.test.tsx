// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { requestAllowance } from "@/actions/allowance";
import { RequestAllowanceDialog } from "./request-allowance-dialog";

vi.mock("@/actions/allowance", () => ({
  requestAllowance: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.mocked(requestAllowance).mockReset();
});

describe("RequestAllowanceDialog credit display", () => {
  it("accepts credits and submits the equivalent USD amount", async () => {
    const user = userEvent.setup();
    vi.mocked(requestAllowance).mockResolvedValue(undefined);

    render(
      <RequestAllowanceDialog
        open
        onOpenChange={vi.fn()}
        state="headroom"
        weeklyRemainingUsd={10}
        weeklyCapUsd={30}
        displayUnit="credits"
      />,
    );

    expect(screen.getByText(/2,000 cr of 6,000 cr left this week/i)).toBeTruthy();
    const amount = screen.getByLabelText("Amount (credits)");
    await user.clear(amount);
    await user.type(amount, "6000");
    await user.click(screen.getByRole("button", { name: "Submit request" }));

    expect(requestAllowance).toHaveBeenCalledWith(30, null);
  });
});
