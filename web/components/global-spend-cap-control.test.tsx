// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setGlobalSpendCap } from "@/actions/account";
import { GlobalSpendCapControl } from "./global-spend-cap-control";

vi.mock("@/actions/account", () => ({ setGlobalSpendCap: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: (): { refresh: ReturnType<typeof vi.fn> } => ({ refresh: vi.fn() }),
  unstable_rethrow: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("GlobalSpendCapControl", () => {
  it("uses refreshed settings when reopened instead of an abandoned edit", async () => {
    const user = userEvent.setup();
    const view = render(
      <GlobalSpendCapControl
        settings={{ enabled: true, capUsd: 100, period: "daily" }}
        spentUsd={10}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Edit team spending limit" }));
    await user.clear(screen.getByLabelText("Global cap in USD"));
    await user.type(screen.getByLabelText("Global cap in USD"), "5");
    await user.click(screen.getByRole("button", { name: "Close team spending limit" }));
    view.rerender(
      <GlobalSpendCapControl
        settings={{ enabled: true, capUsd: 200, period: "daily" }}
        spentUsd={10}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Edit team spending limit" }));
    expect((screen.getByLabelText("Global cap in USD") as HTMLInputElement).value).toBe("200");
    expect(setGlobalSpendCap).not.toHaveBeenCalled();
  });

  it("rejects a blank cap instead of silently pausing the whole team at zero", async () => {
    const user = userEvent.setup();
    render(
      <GlobalSpendCapControl
        settings={{ enabled: true, capUsd: 100, period: "daily" }}
        spentUsd={10}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Edit team spending limit" }));
    await user.clear(screen.getByLabelText("Global cap in USD"));
    await user.click(screen.getByRole("button", { name: "Save cap" }));
    expect(screen.getByRole("status").textContent).toMatch(/Enter zero or a positive/);
    expect(setGlobalSpendCap).not.toHaveBeenCalled();
  });

  it("still allows an intentionally entered zero cap", async () => {
    const user = userEvent.setup();
    vi.mocked(setGlobalSpendCap).mockResolvedValue(undefined);
    render(
      <GlobalSpendCapControl
        settings={{ enabled: true, capUsd: 100, period: "weekly" }}
        spentUsd={10}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Edit team spending limit" }));
    await user.clear(screen.getByLabelText("Global cap in USD"));
    await user.type(screen.getByLabelText("Global cap in USD"), "0");
    await user.click(screen.getByRole("button", { name: "Save cap" }));
    await screen.findByText("Global cap saved.");
    expect(setGlobalSpendCap).toHaveBeenCalledWith(true, 0, "weekly");
  });
});
