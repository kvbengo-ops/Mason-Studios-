// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  setDailyCapOverride,
  setGlobalCapExempt,
  setHourlyCapOverride,
  setWeeklyCapOverride,
} from "@/actions/account";
import { WeeklyAllowanceDialog } from "./weekly-allowance-dialog";

vi.mock("@/actions/account", () => ({
  setDailyCapOverride: vi.fn(),
  setGlobalCapExempt: vi.fn(),
  setHourlyCapOverride: vi.fn(),
  setWeeklyCapOverride: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.mocked(setDailyCapOverride).mockReset();
  vi.mocked(setGlobalCapExempt).mockReset();
  vi.mocked(setHourlyCapOverride).mockReset();
  vi.mocked(setWeeklyCapOverride).mockReset();
});

describe("WeeklyAllowanceDialog", () => {
  it("exempts the account from the team cap when the switch is turned off, and writes nothing else", async () => {
    const user = userEvent.setup();
    vi.mocked(setGlobalCapExempt).mockResolvedValue(undefined);
    render(
      <WeeklyAllowanceDialog
        userId="editor-1"
        email="editor@example.com"
        effectiveWeeklyCapUsd={150}
        hasOverride
        maxWeeklyCapUsd={700}
        effectiveDailyCapUsd={30}
        hasDailyOverride
        maxDailyCapUsd={100}
        effectiveHourlyCapUsd={null}
        hasHourlyOverride={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: /allowance.*editor@example\.com/i }));
    const dialog = screen.getByRole("dialog");
    const teamCap = within(dialog).getByRole("switch", { name: "Team spending cap applies" });
    expect(teamCap.getAttribute("aria-checked")).toBe("true");
    await user.click(teamCap);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(setGlobalCapExempt).toHaveBeenCalledWith("editor-1", true));
    expect(setWeeklyCapOverride).not.toHaveBeenCalled();
    expect(setDailyCapOverride).not.toHaveBeenCalled();
    expect(setHourlyCapOverride).not.toHaveBeenCalled();
  });

  it("does not touch the exemption when the switch is left alone", async () => {
    const user = userEvent.setup();
    vi.mocked(setHourlyCapOverride).mockResolvedValue(undefined);
    render(
      <WeeklyAllowanceDialog
        userId="editor-1"
        email="editor@example.com"
        effectiveWeeklyCapUsd={150}
        hasOverride
        maxWeeklyCapUsd={700}
        effectiveDailyCapUsd={30}
        hasDailyOverride
        maxDailyCapUsd={100}
        effectiveHourlyCapUsd={null}
        hasHourlyOverride={false}
        globalCapExempt
      />,
    );

    await user.click(screen.getByRole("button", { name: /allowance.*editor@example\.com/i }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog)
        .getByRole("switch", { name: "Team spending cap applies" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    await user.type(within(dialog).getByLabelText("USD per rolling hour"), "5");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(setHourlyCapOverride).toHaveBeenCalledWith("editor-1", 5));
    expect(setGlobalCapExempt).not.toHaveBeenCalled();
  });

  it("discards unsaved edits and uses refreshed account limits when reopened", async () => {
    const user = userEvent.setup();
    const props = {
      userId: "editor-1",
      email: "editor@example.com",
      effectiveWeeklyCapUsd: 25,
      hasOverride: true,
      maxWeeklyCapUsd: 700,
      effectiveDailyCapUsd: 10,
      hasDailyOverride: true,
      maxDailyCapUsd: 100,
      effectiveHourlyCapUsd: null,
      hasHourlyOverride: false,
    };
    const view = render(<WeeklyAllowanceDialog {...props} />);
    await user.click(screen.getByRole("button", { name: /allowance.*editor@example\.com/i }));
    await user.clear(screen.getByLabelText("USD per week"));
    await user.type(screen.getByLabelText("USD per week"), "99");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    view.rerender(<WeeklyAllowanceDialog {...props} effectiveWeeklyCapUsd={40} />);
    await user.click(screen.getByRole("button", { name: /allowance.*editor@example\.com/i }));
    expect((screen.getByLabelText("USD per week") as HTMLInputElement).value).toBe("40");
    expect(setWeeklyCapOverride).not.toHaveBeenCalled();
  });

  it.each(["USD per week", "USD per day"])(
    "rejects a blank %s instead of pausing an account",
    async (label) => {
      const user = userEvent.setup();
      render(
        <WeeklyAllowanceDialog
          userId="editor-1"
          email="editor@example.com"
          effectiveWeeklyCapUsd={25}
          hasOverride={true}
          maxWeeklyCapUsd={700}
          effectiveDailyCapUsd={10}
          hasDailyOverride={true}
          maxDailyCapUsd={100}
          effectiveHourlyCapUsd={null}
          hasHourlyOverride={false}
        />,
      );
      await user.click(screen.getByRole("button", { name: /allowance.*editor@example\.com/i }));
      await user.clear(screen.getByLabelText(label));
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(screen.getByText(/Enter zero or a positive/)).toBeTruthy();
      expect(setWeeklyCapOverride).not.toHaveBeenCalled();
      expect(setDailyCapOverride).not.toHaveBeenCalled();
    },
  );

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
        /set it to 0 to remove the base allowance and revoke approved grants/i,
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

    await waitFor(() => expect(setHourlyCapOverride).toHaveBeenCalledWith("editor-1", 5));
    expect(setWeeklyCapOverride).not.toHaveBeenCalled();
    expect(setDailyCapOverride).not.toHaveBeenCalled();
    expect(setHourlyCapOverride).toHaveBeenCalledWith("editor-1", 5);
  });

  it("does not overwrite an untouched daily cap or revoke grants when editing only the hourly cap", async () => {
    const user = userEvent.setup();
    vi.mocked(setHourlyCapOverride).mockResolvedValue(undefined);
    render(
      <WeeklyAllowanceDialog
        userId="editor-1"
        email="editor@example.com"
        effectiveWeeklyCapUsd={0}
        hasOverride={true}
        maxWeeklyCapUsd={700}
        effectiveDailyCapUsd={0}
        hasDailyOverride={true}
        maxDailyCapUsd={100}
        effectiveHourlyCapUsd={null}
        hasHourlyOverride={false}
        dailyCapEnabled={true}
      />,
    );
    await user.click(screen.getByRole("button", { name: /allowance.*editor@example\.com/i }));
    await user.type(screen.getByLabelText("USD per rolling hour"), "5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(setHourlyCapOverride).toHaveBeenCalledWith("editor-1", 5));
    expect(setWeeklyCapOverride).not.toHaveBeenCalled();
    expect(setDailyCapOverride).not.toHaveBeenCalled();
  });
});
