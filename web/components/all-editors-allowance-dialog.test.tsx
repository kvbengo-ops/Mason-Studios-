// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  getBulkSpendingLimits,
  setAllEditorsDailyCap,
  setAllEditorsHourlyCap,
  setAllEditorsWeeklyCap,
  setUserDailyCapEnabled,
} from "@/actions/account";
import type { BulkSpendingLimits } from "@/lib/allowance";
import { AllEditorsAllowanceDialog } from "./all-editors-allowance-dialog";

vi.mock("@/actions/account", () => ({
  getBulkSpendingLimits: vi.fn(),
  setAllEditorsDailyCap: vi.fn(),
  setAllEditorsHourlyCap: vi.fn(),
  setAllEditorsWeeklyCap: vi.fn(),
  setUserDailyCapEnabled: vi.fn(),
}));

for (const method of [
  "hasPointerCapture",
  "setPointerCapture",
  "releasePointerCapture",
  "scrollIntoView",
]) {
  if (!(method in Element.prototype)) {
    Object.defineProperty(Element.prototype, method, { value: () => false, configurable: true });
  }
}

const saved: BulkSpendingLimits = {
  count: 4,
  weeklyCapUsd: 35,
  dailyCapUsd: 8,
  hourlyCapUsd: 3,
  dailyCapEnabled: true,
};
const props = {
  maxWeeklyCapUsd: 700,
  maxDailyCapUsd: 100,
  editorCount: 1,
  trustedEditorCount: 1,
  hybridEditorCount: 1,
  aiAnimatorCount: 1,
  followingDefaultCount: 4,
};
const input = (label: string): HTMLInputElement => screen.getByLabelText(label) as HTMLInputElement;

beforeEach(() => {
  vi.mocked(getBulkSpendingLimits).mockResolvedValue({ ...saved });
  vi.mocked(setAllEditorsWeeklyCap).mockResolvedValue({ updated: 4 });
  vi.mocked(setAllEditorsDailyCap).mockResolvedValue({ updated: 4 });
  vi.mocked(setAllEditorsHourlyCap).mockResolvedValue({ updated: 4 });
  vi.mocked(setUserDailyCapEnabled).mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

async function openDialog(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(<AllEditorsAllowanceDialog {...props} />);
  await user.click(screen.getByRole("button", { name: "Spending limits" }));
  await waitFor(() => expect(input("USD per week").disabled).toBe(false));
  return user;
}

describe("Spending limits", () => {
  it("reads saved amounts after a save and a fresh page mount", async () => {
    let stored = { ...saved };
    vi.mocked(getBulkSpendingLimits).mockImplementation(async () => ({ ...stored }));
    vi.mocked(setAllEditorsWeeklyCap).mockImplementation(async (amount) => {
      stored = { ...stored, weeklyCapUsd: amount };
      return { updated: 4 };
    });
    const user = await openDialog();
    expect(input("USD per week").value).toBe("35");
    expect(input("USD per day").value).toBe("8");
    expect(input("USD per hour").value).toBe("3");
    await user.clear(input("USD per week"));
    await user.type(input("USD per week"), "47");
    await user.click(screen.getByRole("button", { name: "Set for 4" }));
    await screen.findByText(/Changes saved/);
    expect(setAllEditorsWeeklyCap).toHaveBeenCalledWith(47, "all");
    expect(setAllEditorsDailyCap).not.toHaveBeenCalled();
    expect(setAllEditorsHourlyCap).not.toHaveBeenCalled();
    cleanup();
    await openDialog();
    expect(input("USD per week").value).toBe("47");
  });

  it("reloads the selected role and discards unsaved amounts on reopen", async () => {
    vi.mocked(getBulkSpendingLimits).mockImplementation(async (scope) => ({
      ...saved,
      count: scope === "all" ? 4 : 1,
      weeklyCapUsd: scope === "editor" ? 12 : 35,
    }));
    const user = await openDialog();
    await user.clear(input("USD per week"));
    await user.type(input("USD per week"), "99");
    await user.click(screen.getByRole("combobox", { name: "Applies to" }));
    await user.click(screen.getByRole("option", { name: "Editors only (1)" }));
    await waitFor(() => expect(input("USD per week").value).toBe("12"));
    await user.clear(input("USD per week"));
    await user.type(input("USD per week"), "77");
    await user.click(screen.getAllByRole("button", { name: "Close" })[0]!);
    await user.click(screen.getByRole("button", { name: "Spending limits" }));
    await waitFor(() => expect(input("USD per week").value).toBe("12"));
    expect(setAllEditorsWeeklyCap).not.toHaveBeenCalled();
  });

  it("preserves mixed limits when only the daily switch changes", async () => {
    vi.mocked(getBulkSpendingLimits).mockResolvedValue({
      ...saved,
      weeklyCapUsd: "mixed",
      dailyCapUsd: "mixed",
      hourlyCapUsd: "mixed",
    });
    const user = await openDialog();
    expect(input("USD per week").placeholder).toMatch(/Mixed/);
    expect(input("USD per hour").placeholder).toMatch(/Mixed/);
    await user.click(screen.getByRole("switch", { name: /Daily cap/ }));
    await user.click(screen.getByRole("button", { name: "Set for 4" }));
    await screen.findByText(/Changes saved/);
    expect(setUserDailyCapEnabled).toHaveBeenCalledWith(false);
    expect(setAllEditorsWeeklyCap).not.toHaveBeenCalled();
    expect(setAllEditorsDailyCap).not.toHaveBeenCalled();
    expect(setAllEditorsHourlyCap).not.toHaveBeenCalled();
  });

  it("leaves unchanged zero amounts alone", async () => {
    vi.mocked(getBulkSpendingLimits).mockResolvedValue({
      ...saved,
      weeklyCapUsd: 0,
      dailyCapUsd: 0,
      hourlyCapUsd: 0,
    });
    const user = await openDialog();
    await user.click(screen.getByRole("button", { name: "Set for 4" }));
    await screen.findByText(/Changes saved/);
    expect(setAllEditorsWeeklyCap).not.toHaveBeenCalled();
    expect(setAllEditorsDailyCap).not.toHaveBeenCalled();
    expect(setAllEditorsHourlyCap).not.toHaveBeenCalled();
  });

  it("allows an explicit weekly zero with the grant revocation warning", async () => {
    const user = await openDialog();
    expect(
      screen.getByText(/Set to 0 to remove the base allowance and revoke approved grants/),
    ).toBeTruthy();
    await user.clear(input("USD per week"));
    await user.type(input("USD per week"), "0");
    await user.click(screen.getByRole("button", { name: "Set for 4" }));
    await waitFor(() => expect(setAllEditorsWeeklyCap).toHaveBeenCalledWith(0, "all"));
    await screen.findByText(/Changes saved/);
  });

  it("allows an existing zero to be explicitly reapplied to revoke newer grants", async () => {
    vi.mocked(getBulkSpendingLimits).mockResolvedValue({ ...saved, weeklyCapUsd: 0 });
    const user = await openDialog();
    await user.clear(input("USD per week"));
    await user.type(input("USD per week"), "0");
    await user.click(screen.getByRole("button", { name: "Set for 4" }));
    await screen.findByText(/Changes saved/);
    expect(setAllEditorsWeeklyCap).toHaveBeenCalledWith(0, "all");
  });

  it("stores daily amounts before turning on the daily guard", async () => {
    vi.mocked(getBulkSpendingLimits).mockResolvedValue({ ...saved, dailyCapEnabled: false });
    const user = await openDialog();
    await user.click(screen.getByRole("switch", { name: /Daily cap/ }));
    await user.clear(input("USD per day"));
    await user.type(input("USD per day"), "9");
    await user.click(screen.getByRole("button", { name: "Set for 4" }));
    await screen.findByText(/Changes saved/);
    expect(setAllEditorsDailyCap).toHaveBeenCalledWith(9, "all");
    expect(setUserDailyCapEnabled).toHaveBeenCalledWith(true);
    expect(vi.mocked(setAllEditorsDailyCap).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(setUserDailyCapEnabled).mock.invocationCallOrder[0]!,
    );
  });

  it("clears hourly caps when switched off, preserving daily and weekly amounts", async () => {
    const user = await openDialog();
    await user.click(screen.getByRole("switch", { name: /Hourly cap/ }));
    await user.click(screen.getByRole("button", { name: "Set for 4" }));
    await screen.findByText(/Changes saved/);
    expect(setAllEditorsHourlyCap).toHaveBeenCalledWith(null, "all");
    expect(setAllEditorsWeeklyCap).not.toHaveBeenCalled();
    expect(setAllEditorsDailyCap).not.toHaveBeenCalled();
  });

  it.each(["USD per week", "USD per day", "USD per hour"])(
    "rejects an emptied %s instead of saving zero",
    async (label) => {
      const user = await openDialog();
      await user.clear(input(label));
      await user.click(screen.getByRole("button", { name: "Set for 4" }));
      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(setAllEditorsWeeklyCap).not.toHaveBeenCalled();
      expect(setAllEditorsDailyCap).not.toHaveBeenCalled();
      expect(setAllEditorsHourlyCap).not.toHaveBeenCalled();
    },
  );

  it("validates all fields before writing and refuses amounts over the ceiling", async () => {
    const user = await openDialog();
    await user.clear(input("USD per week"));
    await user.type(input("USD per week"), "50");
    await user.clear(input("USD per day"));
    await user.type(input("USD per day"), "101");
    await user.click(screen.getByRole("button", { name: "Set for 4" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(setAllEditorsWeeklyCap).not.toHaveBeenCalled();
  });

  it("clears all overrides and reloads role defaults", async () => {
    const user = await openDialog();
    vi.mocked(getBulkSpendingLimits).mockResolvedValue({
      ...saved,
      weeklyCapUsd: "mixed",
      dailyCapUsd: "mixed",
      hourlyCapUsd: null,
    });
    await user.click(screen.getByRole("button", { name: "Reset to starting values" }));
    await screen.findByText(/Selected accounts are back on role defaults/);
    expect(setAllEditorsWeeklyCap).toHaveBeenCalledWith(null, "all");
    expect(setAllEditorsDailyCap).toHaveBeenCalledWith(null, "all");
    expect(setAllEditorsHourlyCap).toHaveBeenCalledWith(null, "all");
    expect(setUserDailyCapEnabled).not.toHaveBeenCalled();
    expect(input("USD per week").placeholder).toMatch(/Mixed/);
    expect(screen.queryByLabelText("USD per hour")).toBeNull();
  });

  it("reloads saved values and explains partial failures", async () => {
    const user = await openDialog();
    vi.mocked(setAllEditorsDailyCap).mockResolvedValue({ error: "Daily save failed" });
    vi.mocked(getBulkSpendingLimits).mockResolvedValue({ ...saved, weeklyCapUsd: 50 });
    await user.clear(input("USD per week"));
    await user.type(input("USD per week"), "50");
    await user.clear(input("USD per day"));
    await user.type(input("USD per day"), "9");
    await user.click(screen.getByRole("button", { name: "Set for 4" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Daily save failed.*Some changes may have saved/);
    expect(input("USD per week").value).toBe("50");
    expect(input("USD per day").value).toBe("8");
    expect(setAllEditorsHourlyCap).not.toHaveBeenCalled();
  });

  it("blocks writes if saved limits cannot be loaded", async () => {
    vi.mocked(getBulkSpendingLimits).mockRejectedValue(new Error("Read unavailable"));
    render(<AllEditorsAllowanceDialog {...props} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Spending limits" }));
    await screen.findByRole("alert");
    expect((screen.getByRole("button", { name: "Set for 4" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(input("USD per week").disabled).toBe(true);
  });
});
