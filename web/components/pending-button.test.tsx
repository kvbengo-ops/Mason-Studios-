// @vitest-environment jsdom
//
// jsdom, not the suite default (see vitest.config.ts) — this renders a lucide
// icon and reads real DOM attributes. Same reasoning as status-icon.test.tsx.
import type ReactDOM from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PendingButton } from "./pending-button";

// useFormStatus only reports pending inside a real <form action={...}> submit,
// which cannot be driven from a unit test — so the form half of this component
// is mocked and the explicit-prop half is exercised for real. That split is
// why the precedence test below matters: it is the seam between the two.
const mockFormStatus = vi.fn(() => ({ pending: false }));
vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof ReactDOM>("react-dom");
  return { ...actual, useFormStatus: () => mockFormStatus() };
});

afterEach(() => {
  cleanup();
  mockFormStatus.mockReturnValue({ pending: false });
});

describe("PendingButton", () => {
  it("is an ordinary button when nothing is in flight", () => {
    render(<PendingButton>Save</PendingButton>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.querySelector(".animate-spin")).toBeNull();
  });

  // Both halves asserted together, on purpose. Disabling is what actually
  // stops the second click; the spinner only explains it. A version that
  // spun without disabling would look completely correct and still bill
  // twice, so neither is allowed to pass on its own.
  it("disables AND spins while pending", () => {
    render(<PendingButton pending>Compile</PendingButton>);
    const button = screen.getByRole("button", { name: /Compile/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.querySelector("svg.animate-spin")).toBeTruthy();
  });

  it("keeps its label while pending, so you can still tell which button you pressed", () => {
    render(<PendingButton pending>Render scene 3</PendingButton>);
    expect(screen.getByRole("button").textContent).toContain("Render scene 3");
  });

  it("hides the spinner from assistive tech, which reads the disabled state instead", () => {
    render(<PendingButton pending>Save</PendingButton>);
    const spinner = screen.getByRole("button").querySelector("svg.animate-spin");
    expect(spinner?.getAttribute("aria-hidden")).toBe("true");
  });

  it("takes its pending state from an enclosing form action when not told otherwise", () => {
    mockFormStatus.mockReturnValue({ pending: true });
    render(<PendingButton>Save</PendingButton>);
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
  });

  // The precedence the first draft had backwards: it read the form status
  // whenever an opt-out flag was unset, so the obvious `<PendingButton
  // pending={busy}>` outside a form silently never spun. An explicit prop is
  // a decision the caller made; a form status of false is merely the absence
  // of one.
  it("lets an explicit pending prop win over the form status", () => {
    mockFormStatus.mockReturnValue({ pending: false });
    render(<PendingButton pending>Describe from photo</PendingButton>);
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
  });

  it("and win in the other direction too", () => {
    mockFormStatus.mockReturnValue({ pending: true });
    render(<PendingButton pending={false}>Save</PendingButton>);
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(false);
  });

  // The two reasons a button is unclickable arrive separately and must not
  // cancel each other: improve-description-button.tsx is disabled for a
  // delivered project AND while its own call runs. An earlier draft refused
  // `disabled` outright, which pushed that OR back onto every caller.
  it("stays disabled for a caller's own reason while nothing is pending", () => {
    render(<PendingButton disabled>Improve with AI</PendingButton>);
    const button = screen.getByRole("button");
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.querySelector(".animate-spin")).toBeNull();
  });

  it("cannot be re-enabled mid-flight by a caller passing disabled={false}", () => {
    render(
      <PendingButton pending disabled={false}>
        Compile
      </PendingButton>,
    );
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
  });

  it("passes Button's own props through", () => {
    render(
      <PendingButton variant="destructive" size="sm">
        Delete
      </PendingButton>,
    );
    const button = screen.getByRole("button", { name: "Delete" });
    expect(button.className).toContain("bg-destructive");
  });
});
