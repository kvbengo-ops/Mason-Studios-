// @vitest-environment jsdom
//
// The failure this guards is the one the component exists to fix: a
// composite tile that was pressed and collapsed to a bare spinner where its
// poster had been. A spinner that never renders looks exactly like that bug
// — see link-pending-overlay.test.tsx, this is the same guard for the
// useFormStatus half.

import type ReactDOM from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const mockFormStatus = vi.fn(() => ({ pending: false }));
vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof ReactDOM>("react-dom");
  return { ...actual, useFormStatus: () => mockFormStatus() };
});

afterEach(() => {
  cleanup();
  mockFormStatus.mockReturnValue({ pending: false });
});

describe("FormPendingOverlay", () => {
  it("shows a spinner while its form is pending", async () => {
    mockFormStatus.mockReturnValue({ pending: true });
    const { FormPendingOverlay } = await import("./form-pending-overlay");

    const { container } = render(<FormPendingOverlay label="Setting v1 current" />);

    expect(
      container.querySelector("svg.animate-spin"),
      "the tile was pressed and shows nothing — the bug this component replaced",
    ).not.toBeNull();
  });

  it("says so to a screen reader, not only in pixels", async () => {
    mockFormStatus.mockReturnValue({ pending: true });
    const { FormPendingOverlay } = await import("./form-pending-overlay");

    render(<FormPendingOverlay label="Setting v1 current" />);

    expect(screen.getByRole("status").textContent).toMatch(/setting v1 current/i);
  });

  it("renders nothing at rest", async () => {
    mockFormStatus.mockReturnValue({ pending: false });
    const { FormPendingOverlay } = await import("./form-pending-overlay");

    const { container } = render(<FormPendingOverlay label="Setting v1 current" />);

    expect(container.innerHTML).toBe("");
  });
});
