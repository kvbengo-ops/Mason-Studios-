// @vitest-environment jsdom
//
// This pager (shared by /projects, /users, /allowances — see this file's
// own header) already navigated via next/link's client-side soft nav
// before this pass; what's new is the pending-state UI added on top: a
// spinner in place of the arrow, and the control refusing a second click
// while its own navigation is in flight. This suite tests exactly that
// layer, not next/link's routing machinery itself — Link and useLinkStatus
// are mocked so the tests control `pending` directly instead of needing a
// real AppRouterContext/RSC fetch to drive it.
import type { AnchorHTMLAttributes, JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PaginationControls } from "./pagination-controls";

let mockPending = false;

vi.mock("next/link", () => ({
  // A dumb stand-in for next/link's <Link>: renders a real <a>, forwards
  // every prop (href, onClick, className, aria-disabled, tabIndex) as-is.
  // No prefetching, no router context, no actual navigation — this file
  // only tests what PagerLink/PagerLinkBody built on top of Link, not
  // Link's own internals.
  default: ({
    href,
    children,
    ...rest
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }): JSX.Element => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  // Controlled by the module-level `mockPending` each test sets before
  // rendering — stands in for the real hook's dependency on a Link's own
  // internal navigation state (see pagination-controls.tsx's PagerLinkBody
  // comment for why the real hook can only be called from inside a Link's
  // subtree at all).
  useLinkStatus: (): { pending: boolean } => ({ pending: mockPending }),
}));

afterEach(() => {
  cleanup();
  mockPending = false;
});

describe("PaginationControls — pending state", () => {
  it("renders nothing (no spinner, fully interactive) while idle", () => {
    mockPending = false;
    render(
      <PaginationControls
        page={2}
        totalPages={5}
        previousHref={"/projects?page=1"}
        nextHref={"/projects?page=3"}
      />,
    );

    const next = screen.getByRole("link", { name: /Next/ });
    expect(next.getAttribute("aria-disabled")).toBeNull();
    // classList, not className.includes(): buttonVariants' own base class
    // string already contains the substring "pointer-events-none" (inside
    // "disabled:pointer-events-none", a Tailwind variant that only applies
    // to a real disabled *button*, never to this anchor) — a plain
    // substring check would false-positive on that unconditionally.
    expect(next.classList.contains("pointer-events-none")).toBe(false);
    expect(screen.queryByLabelText(/loading/i)).toBeNull();
  });

  it("shows a spinner and marks the control non-interactive while a navigation is pending", () => {
    mockPending = true;
    render(
      <PaginationControls
        page={2}
        totalPages={5}
        previousHref={"/projects?page=1"}
        nextHref={"/projects?page=3"}
      />,
    );

    const next = screen.getByRole("link", { name: /Next/ });
    expect(next.getAttribute("aria-disabled")).toBe("true");
    expect(next.classList.contains("pointer-events-none")).toBe(true);
    expect(next.getAttribute("tabindex")).toBe("-1");
    // The chevron is gone — the shared Spinner (components/spinner.tsx, a
    // plain aria-hidden <svg>) stands in for it instead. Its own base class
    // is `animate-spin`, but PagerLinkBody passes
    // `motion-safe:animate-spin animate-none`, and twMerge (lib/utils.ts's
    // cn) treats `animate-spin`/`animate-none` as the same conflicting
    // group, so the bare `animate-spin` class does not survive onto the
    // rendered element — querying for `animate-none` (its actual resting
    // state absent motion-safe) instead.
    expect(next.querySelector("svg.animate-none")).not.toBeNull();
    expect(next.querySelector('[class*="lucide-chevron-right"]')).toBeNull();
  });

  it("swallows a click on the anchor while pending, instead of letting a second navigation queue", () => {
    mockPending = true;
    render(
      <PaginationControls
        page={2}
        totalPages={5}
        previousHref={"/projects?page=1"}
        nextHref={"/projects?page=3"}
      />,
    );

    const next = screen.getByRole("link", { name: /Next/ });
    const event = fireEvent.click(next);
    // jsdom's fireEvent.click returns `false` when some handler called
    // preventDefault() — exactly the guard PagerLink's onClick adds for
    // the pending case.
    expect(event).toBe(false);
  });

  // Negative control: the exact same click, not pending, is NOT swallowed
  // — proves the assertion above is reading the pending guard, not some
  // default browser behaviour that would make every click on this anchor
  // read as "prevented".
  it("negative control — the same click is not prevented when idle", () => {
    mockPending = false;
    render(
      <PaginationControls
        page={2}
        totalPages={5}
        previousHref={"/projects?page=1"}
        nextHref={"/projects?page=3"}
      />,
    );

    const next = screen.getByRole("link", { name: /Next/ });
    const event = fireEvent.click(next);
    expect(event).toBe(true);
  });
});

describe("PaginationControls — unchanged behaviour", () => {
  it("still renders nothing for a single-page result", () => {
    const { container } = render(
      <PaginationControls page={1} totalPages={1} previousHref={null} nextHref={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("still renders a disabled (non-link) Previous button on page 1", () => {
    render(
      <PaginationControls
        page={1}
        totalPages={3}
        previousHref={null}
        nextHref={"/projects?page=2"}
      />,
    );
    const previous = screen.getByRole("button", { name: /Previous/ });
    expect((previous as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("link", { name: /Previous/ })).toBeNull();
  });

  it("still renders a disabled (non-link) Next button on the last page", () => {
    render(
      <PaginationControls
        page={3}
        totalPages={3}
        previousHref={"/projects?page=2"}
        nextHref={null}
      />,
    );
    const next = screen.getByRole("button", { name: /Next/ });
    expect((next as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("link", { name: /Next/ })).toBeNull();
  });
});
