// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setDailyCapOverride, setHourlyCapOverride, setWeeklyCapOverride } from "@/actions/account";
import { WeeklyAllowanceDialog } from "./weekly-allowance-dialog";

vi.mock("@/actions/account", () => ({
  setDailyCapOverride: vi.fn(),
  setHourlyCapOverride: vi.fn(),
  setWeeklyCapOverride: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.mocked(setDailyCapOverride).mockReset();
  vi.mocked(setHourlyCapOverride).mockReset();
  vi.mocked(setWeeklyCapOverride).mockReset();
});

describe("WeeklyAllowanceDialog", () => {
  it("allows an admin to save zero credits as an explicit pause", async () => {
    const user = userEvent.setup();
    vi.mocked(setDailyCapOverride).mockResolvedValue(undefined);
    vi.mocked(setWeeklyCapOverride).mockResolvedValue(undefined);

    render(
      <WeeklyAllowanceDialog
        userId="editor-1"
        email="editor@example.com"
        effectiveWeeklyCapUsd={10}
        hasOverride={false}
        maxWeeklyCapUsd={700}
        effectiveDailyCapUsd={5}
        hasDailyOverride={false}
        maxDailyCapUsd={100}
        effectiveHourlyCapUsd={null}
        hasHourlyOverride={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: /allowance.*editor@example\.com/i }));
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByLabelText("USD per week") as HTMLInputElement;

    expect(input.min).toBe("0");
    // The copy has to state the grant consequence, because zero is the one
    // value that ALSO revokes (actions/account.ts's ZERO MEANS ZERO note):
    // an admin who reads only "sets the allowance to 0" would not expect an
    // approved grant to disappear with it.
    expect(
      within(dialog).getByText(
        /set it to 0 to stop this account spending.*revokes any active grant/i,
      ),
    ).toBeTruthy();

    await user.clear(input);
    await user.type(input, "0");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(setWeeklyCapOverride).toHaveBeenCalledWith("editor-1", 0));
  });

  it("hides and skips the daily override when the optional guard is disabled", async () => {
    const user = userEvent.setup();
    vi.mocked(setWeeklyCapOverride).mockResolvedValue(undefined);
    vi.mocked(setHourlyCapOverride).mockResolvedValue(undefined);

    render(
      <WeeklyAllowanceDialog
        userId="editor-1"
        email="editor@example.com"
        effectiveWeeklyCapUsd={10}
        hasOverride={false}
        maxWeeklyCapUsd={700}
        effectiveDailyCapUsd={5}
        hasDailyOverride={false}
        maxDailyCapUsd={100}
        effectiveHourlyCapUsd={null}
        hasHourlyOverride={false}
        dailyCapEnabled={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: /allowance.*editor@example\.com/i }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByLabelText("USD per day")).toBeNull();
    const hourlyInput = within(dialog).getByLabelText("USD per rolling hour");
    await user.type(hourlyInput, "5");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(setWeeklyCapOverride).toHaveBeenCalledWith("editor-1", 10));
    expect(setDailyCapOverride).not.toHaveBeenCalled();
    expect(setHourlyCapOverride).toHaveBeenCalledWith("editor-1", 5);
  });
});
