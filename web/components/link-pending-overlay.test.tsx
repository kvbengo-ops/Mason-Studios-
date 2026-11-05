// @vitest-environment jsdom
//
// The failure this guards is the one the component exists to fix: a control
// that was pressed and says nothing. A spinner that never renders looks
// exactly like the bug it replaced, and nothing else in the suite would
// notice — the strip's own tests pass either way, because outside a real
// navigation useLinkStatus reports pending: false.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const useLinkStatus = vi.fn();
vi.mock("next/link", () => ({ useLinkStatus: () => useLinkStatus() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LinkPendingOverlay", () => {
  it("shows a spinner while its link is pending", async () => {
    useLinkStatus.mockReturnValue({ pending: true });
    const { LinkPendingOverlay } = await import("./link-pending-overlay");

    const { container } = render(<LinkPendingOverlay />);

    expect(
      container.querySelector("svg.animate-spin"),
      "the tile was pressed and shows nothing — the bug this component replaced",
    ).not.toBeNull();
  });

  it("says so to a screen reader, not only in pixels", async () => {
    useLinkStatus.mockReturnValue({ pending: true });
    const { LinkPendingOverlay } = await import("./link-pending-overlay");

    render(<LinkPendingOverlay />);

    expect(screen.getByRole("status").textContent).toMatch(/loading scene/i);
  });

  it("renders nothing at rest", async () => {
    useLinkStatus.mockReturnValue({ pending: false });
    const { LinkPendingOverlay } = await import("./link-pending-overlay");

    const { container } = render(<LinkPendingOverlay />);

    expect(container.innerHTML).toBe("");
  });
});
