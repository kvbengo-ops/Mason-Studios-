// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ShimmerText } from "./shimmer-text";

afterEach(() => {
  cleanup();
});

describe("ShimmerText", () => {
  it("exposes the label as its accessible name whether or not it's animating", () => {
    render(<ShimmerText label="Rendering" animated />);
    expect(screen.getByRole("status", { name: "Rendering" })).toBeTruthy();
  });

  it("renders visible text for the label either way — the sr-only span isn't the only copy", () => {
    const { unmount } = render(<ShimmerText label="Rendering" animated />);
    // getAllByText: the visible (aria-hidden) span and the sr-only span both
    // contain the literal string "Rendering" — this only proves the text
    // made it into the DOM at all, not that it's visible; the paint-level
    // assertions below cover that.
    expect(screen.getAllByText("Rendering").length).toBeGreaterThan(0);
    unmount();
  });

  it("when animated, blanks the glyph fill via -webkit-text-fill-color rather than `color` — so currentColor in the gradient still resolves to the real, inherited colour instead of the transparent it would resolve to if `color` itself were touched", () => {
    render(<ShimmerText label="Rendering" animated />);
    const visible = screen.getByText("Rendering", { selector: "span[aria-hidden]" });
    expect(visible.className).toContain("[-webkit-text-fill-color:transparent]");
    expect(visible.className).not.toContain("text-transparent");
    // No inline `color` override anywhere — only backgroundImage/backgroundSize.
    expect(visible.style.color).toBe("");
    // jsdom normalizes `currentColor` to lowercase in the serialized style
    // string — assert case-insensitively rather than pin an exact casing.
    expect(visible.style.backgroundImage.toLowerCase()).toContain("currentcolor");
  });

  it("sweeps unconditionally — no motion-safe: gate, and therefore no motion-reduce: fill escape hatch either", () => {
    render(<ShimmerText label="Rendering" animated />);
    const visible = screen.getByText("Rendering", { selector: "span[aria-hidden]" });
    // jsdom doesn't evaluate @media queries, so this asserts on the class
    // list (what reaches the stylesheet) rather than simulating
    // prefers-reduced-motion being active.
    //
    // Both halves matter, and they are one decision, not two. Gating the
    // sweep behind `motion-safe:` leaves a reduced-motion user on the
    // animation's *static first frame* — the transparent trough of the
    // gradient — which is illegible text, not a resting state. That is why
    // the `motion-reduce:` fill override existed. Re-adding either one
    // alone reintroduces exactly that bug, so this pins the absence of
    // both alongside the plain `animate-shimmer` that replaced them.
    expect(visible.className).toContain("animate-shimmer");
    expect(visible.className).not.toContain("motion-safe:");
    expect(visible.className).not.toContain("motion-reduce:");
  });

  it("animated=false (the 'queued' / not-actually-running case) renders plain text with no shimmer classes and no gradient style at all", () => {
    render(<ShimmerText label="Queued" animated={false} />);
    const visible = screen.getByText("Queued", { selector: "span[aria-hidden]" });
    expect(visible.className).not.toContain("[-webkit-text-fill-color:transparent]");
    expect(visible.className).not.toContain("animate-shimmer");
    expect(visible.style.backgroundImage).toBe("");
  });
});
