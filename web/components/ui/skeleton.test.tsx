// @vitest-environment jsdom
//
// The same guard render-progress.test.tsx keeps over the status spinner,
// for the same reason and after the same mistake.
//
// This shipped as `motion-safe:animate-shimmer` on the argument that a
// suppressed sweep lands on a flat tinted box, which is a fine static
// placeholder. That was true while a spinner and an explanatory sentence sat
// beside it — and both were removed the same afternoon, which quietly made
// the skeleton the ONLY signal that a paid call was running. An operator
// with reduced motion enabled saw a completely still screen while $0.02 was
// spent, and reported it.

import { describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { Skeleton } from "./skeleton";

afterEach(() => {
  cleanup();
});

describe("Skeleton", () => {
  function classes(): string {
    return screen.getByTestId("s").getAttribute("class") ?? "";
  }

  it("animates unguarded by motion-safe", () => {
    // Reduced motion is aimed at large decorative movement, not at the one
    // thing telling you work is in progress. status-icon.tsx, spinner.tsx
    // and submit-button.tsx all reached this conclusion first.
    render(<Skeleton data-testid="s" />);
    expect(classes()).toContain("animate-shimmer");
    expect(classes()).not.toContain("motion-safe:");
  });

  it("carries the width and no-repeat the sweep needs to be visible", () => {
    // A gradient no wider than its box has nothing to travel, and one that
    // tiles has no edges — either way the animation runs and the box looks
    // static, which is indistinguishable from a frozen page.
    render(<Skeleton data-testid="s" />);
    expect(classes()).toContain("bg-[length:200%_100%]");
    expect(classes()).toContain("bg-no-repeat");
  });

  it("still takes a caller's className", () => {
    render(<Skeleton data-testid="s" className="rounded-none" />);
    expect(classes()).toContain("rounded-none");
  });
});
