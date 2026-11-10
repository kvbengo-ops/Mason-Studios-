// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JSX, ReactNode } from "react";
import { Dialog } from "@/components/ui/dialog";
import { manilaDayKeys } from "@/lib/burn";
import type { AccountBurnDetail } from "@/actions/burn";

vi.mock("@/actions/burn", () => ({ getAccountBurn: vi.fn() }));

import { BurnDrawerBody, type BurnDrawerAccount } from "./burn-drawer";

afterEach(cleanup);

// Wednesday 12:00 Manila: three days into the week, four to go.
const WED = new Date("2026-11-11T04:00:00Z");

// The body's title and description are Radix dialog parts: they need a Dialog around them, as in the real drawer.
function inDialog(children: ReactNode): JSX.Element {
  return <Dialog open>{children}</Dialog>;
}

const account: BurnDrawerAccount = {
  userId: "11111111-1111-4111-8111-111111111111",
  email: "editor@example.com",
  role: "trusted_editor",
  weekSpentUsd: 70.25,
  weekTotalUsd: 700,
  dailyAllowanceUsd: 25,
};

const detail: AccountBurnDetail = {
  dates: manilaDayKeys(WED, 14),
  days: Array.from({ length: 14 }, () => 5),
  models: [
    { label: "Seedance 2.5 · Kie", runs: 7, costUsd: 49.5 },
    { label: "Seedance 2.5 · BytePlus", runs: 1, costUsd: 20.5 },
  ],
};

function renderBody(
  overrides: Partial<{
    account: BurnDrawerAccount;
    detail: AccountBurnDetail | null;
    status: "loading" | "error" | "ready";
    onWindowChange: (days: 14 | 30) => void;
    windowDays: 14 | 30;
  }> = {},
): void {
  render(
    inDialog(
      <BurnDrawerBody
        account={overrides.account ?? account}
        detail={overrides.detail === undefined ? detail : overrides.detail}
        windowDays={overrides.windowDays ?? 14}
        onWindowChange={overrides.onWindowChange ?? vi.fn()}
        status={overrides.status ?? "ready"}
        now={WED}
      />,
    ),
  );
}

describe("BurnDrawerBody", () => {
  it("heads the panel with the email, role and the week so far", () => {
    renderBody();
    expect(screen.getByText("editor@example.com")).toBeTruthy();
    expect(screen.getByText("Trusted editor")).toBeTruthy();
    expect(screen.getByText(/\$70\.25 of \$700\.00 this week/)).toBeTruthy();
  });

  it("charts the window with the daily allowance as a dashed line", () => {
    renderBody();
    expect(document.querySelectorAll("rect")).toHaveLength(14);
    const line = screen.getByTestId("daily-allowance-line");
    expect(line.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(
      screen.getByRole("img", { name: /Daily spend over the last 14 days.*\$70\.00/ }),
    ).toBeTruthy();
  });

  it("draws no allowance line when the account has no daily allowance", () => {
    renderBody({ account: { ...account, dailyAllowanceUsd: null } });
    expect(screen.queryByTestId("daily-allowance-line")).toBeNull();
  });

  const figure = (label: string): string | null =>
    screen.getByText(label).nextElementSibling?.textContent ?? null;

  it("shows the average, the projected week and 'not this week' when out of reach", () => {
    renderBody();
    expect(figure("Avg per day (14d)")).toBe("$5.00");
    // $70.25 so far + $5 x 4 days left.
    expect(figure("Projected week")).toBe("$90.25");
    expect(figure("Reaches weekly total")).toBe("not this week");
  });

  it("names the day the weekly total is reached at this pace", () => {
    renderBody({ account: { ...account, weekTotalUsd: 80 } });
    // $9.75 to go at $5/day: two days on from Wednesday.
    expect(figure("Reaches weekly total")).toBe("Fri Nov 13");
  });

  it("leaves the reach day blank when the weekly total is unknown", () => {
    renderBody({ account: { ...account, weekTotalUsd: null } });
    expect(figure("Reaches weekly total")).toBe("—");
    expect(screen.getByText(/\$70\.25 this week/)).toBeTruthy();
  });

  it("lists spend by model", () => {
    renderBody();
    const section = screen.getByRole("region", { name: "Spend by model" });
    const rows = within(section).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Seedance 2.5 · Kie");
    expect(rows[0]!.textContent).toContain("$49.50 · 7 runs");
    expect(rows[1]!.textContent).toContain("$20.50 · 1 run");
  });

  it("says so when there is no spend by model", () => {
    renderBody({ detail: { ...detail, days: detail.days.map(() => 0), models: [] } });
    expect(screen.getByText("No spend in this window.")).toBeTruthy();
  });

  it("switches between 14 and 30 days", async () => {
    const onWindowChange = vi.fn();
    renderBody({ onWindowChange });
    expect(screen.getByRole("button", { name: "14 days" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await userEvent.click(screen.getByRole("button", { name: "30 days" }));
    expect(onWindowChange).toHaveBeenCalledWith(30);
  });

  it("links to the account in Accounts Control", () => {
    renderBody();
    expect(
      screen.getByRole("link", { name: "Open in Accounts Control" }).getAttribute("href"),
    ).toBe(`/accounts-control?view=accounts&user=${account.userId}`);
  });

  it("shows a loading placeholder and dashes before the data arrives", () => {
    renderBody({ detail: null, status: "loading" });
    expect(screen.getByLabelText("Loading")).toBeTruthy();
    expect(figure("Projected week")).toBe("—");
  });

  it("shows an error instead of a chart when the read failed", () => {
    renderBody({ detail: null, status: "error" });
    expect(screen.getByRole("alert").textContent).toContain("Could not load");
  });
});
