// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Wallet } from "lucide-react";
import { AreaChart } from "./area-chart";
import { DonutChart } from "./donut-chart";
import { ChangeLine, KpiTile } from "./kpi-tile";
import { NeedsAttention } from "./needs-attention";
import { TableColumnsMenu } from "./table-columns-menu";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("KpiTile", () => {
  it("is one link when given an href, marked current when active", () => {
    render(
      <KpiTile label="Pending approvals" value="3" sub="waiting" icon={Wallet} href="/users?filter=pending" active />,
    );
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/users?filter=pending");
    expect(link.getAttribute("aria-current")).toBe("true");
    expect(link.textContent).toContain("3");
  });

  it("is not a link without an href", () => {
    render(<KpiTile label="Today" value="$4.00" sub="x" icon={Wallet} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("$4.00")).toBeTruthy();
  });
});

describe("ChangeLine", () => {
  it("shows spend going up in red", () => {
    render(<ChangeLine change={{ direction: "up", deltaUsd: 15, pct: 50 }} vs="last week" />);
    const line = screen.getByText(/50% vs last week/);
    expect(line.className).toContain("text-destructive");
    expect(line.textContent).toContain("Up");
  });

  it("shows spend going down in green", () => {
    render(<ChangeLine change={{ direction: "down", deltaUsd: -4, pct: -4 }} vs="last week" />);
    expect(screen.getByText(/4\.0% vs last week/).className).toContain("text-success");
  });

  it("falls back to dollars when there is no previous spend", () => {
    render(<ChangeLine change={{ direction: "up", deltaUsd: 12, pct: null }} vs="last week" />);
    expect(screen.getByText(/\$12\.00 vs last week/)).toBeTruthy();
  });

  it("is muted when flat or unavailable", () => {
    render(<ChangeLine change={{ direction: "flat", deltaUsd: 0, pct: null }} vs="last week" />);
    expect(screen.getByText("No change vs last week").className).toContain("text-muted-foreground");
    cleanup();
    render(<ChangeLine change={null} vs="last week" />);
    expect(screen.getByText("No comparison available")).toBeTruthy();
  });
});

describe("DonutChart", () => {
  it("names every slice and the total in its accessible label", () => {
    render(
      <DonutChart
        ariaLabel="Spend by role this week"
        slices={[
          { label: "Editor", valueUsd: 30 },
          { label: "Admin", valueUsd: 10 },
        ]}
      />,
    );
    expect(
      screen.getByRole("img", {
        name: "Spend by role this week: $40.00 total, Editor $30.00 (75%), Admin $10.00 (25%)",
      }),
    ).toBeTruthy();
  });
});

describe("AreaChart", () => {
  const points = [
    { date: "2026-11-09", valueUsd: 5 },
    { date: "2026-11-10", valueUsd: 20 },
    { date: "2026-11-11", valueUsd: 12.5 },
  ];

  it("carries the numbers in its accessible label", () => {
    render(<AreaChart ariaLabel="Team daily spend" points={points} />);
    expect(
      screen.getByRole("img", {
        name: "Team daily spend: Nov 9 $5.00, Nov 10 $20.00, Nov 11 $12.50",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Peak $20.00")).toBeTruthy();
  });

  it("opens the tooltip from the keyboard and moves with the arrow keys", () => {
    render(<AreaChart ariaLabel="Team daily spend" points={points} />);
    const chart = screen.getByRole("group");
    act(() => chart.focus());
    expect(screen.getByRole("status").textContent).toBe("Nov 11 $12.50");
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(screen.getByRole("status").textContent).toBe("Nov 10 $20.00");
    fireEvent.keyDown(chart, { key: "Home" });
    expect(screen.getByRole("status").textContent).toBe("Nov 9 $5.00");
    fireEvent.keyDown(chart, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("AreaChart details", () => {
  it("lists each point's breakdown in the tooltip and the accessible name", () => {
    render(
      <AreaChart
        ariaLabel="Daily spend"
        points={[
          {
            date: "2026-11-11",
            valueUsd: 5,
            details: [
              { label: "Video", valueUsd: 4 },
              { label: "Images", valueUsd: 1 },
            ],
          },
        ]}
      />,
    );
    expect(
      screen.getByRole("img", { name: "Daily spend: Nov 11 $5.00 (Video $4.00, Images $1.00)" }),
    ).toBeTruthy();
    act(() => screen.getByRole("group").focus());
    expect(screen.getByRole("status").textContent).toBe("Nov 11 $5.00Video $4.00Images $1.00");
  });
});

describe("NeedsAttention", () => {
  const nothing = {
    pendingAccounts: 0,
    pendingAllowanceRequests: 0,
    nearCapAccounts: 0,
    failedRunErrors: [],
    kieBalanceUsd: null,
    bytePlusBalanceUsd: null,
  };

  it("shows one muted line when nothing needs attention", () => {
    render(<NeedsAttention input={nothing} />);
    expect(screen.getByText("Nothing needs attention.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("lists each item as a link", () => {
    render(<NeedsAttention input={{ ...nothing, pendingAccounts: 2 }} />);
    expect(
      screen.getByRole("link", { name: "2 accounts waiting for approval" }).getAttribute("href"),
    ).toBe("/users?filter=pending");
  });
});

describe("TableColumnsMenu", () => {
  const columns = [
    { id: "joined", label: "Joined", defaultHidden: true },
    { id: "role", label: "Role" },
  ];

  it("hides default-hidden columns on first render", () => {
    const { container } = render(
      <TableColumnsMenu storageKey="t" columns={columns}>
        <span data-col="joined">j</span>
      </TableColumnsMenu>,
    );
    const css = container.querySelector("style")?.textContent ?? "";
    expect(css).toContain('[data-col="joined"]{display:none}');
    expect(css).not.toContain("role");
  });

  it("restores the saved choice from localStorage", () => {
    window.localStorage.setItem("t", JSON.stringify(["role"]));
    const { container } = render(
      <TableColumnsMenu storageKey="t" columns={columns}>
        <span />
      </TableColumnsMenu>,
    );
    const css = container.querySelector("style")?.textContent ?? "";
    expect(css).toContain('[data-col="role"]');
    expect(css).not.toContain("joined");
  });
});
