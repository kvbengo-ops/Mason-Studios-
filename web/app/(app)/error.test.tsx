// @vitest-environment jsdom
//
// Coverage for the bug class this file exists to prevent: React redacts
// Server Component/Server Action error messages in production (the #441
// behaviour lib/action-result.ts documents at length), but a raw thrown
// message reaching a Client Component error boundary is NOT redacted by
// React itself — it's this component's own job never to render
// `error.message`. A vacuous "renders without crashing" test would not
// catch a future edit that adds `{error.message}` back in, so this
// asserts the sensitive string is absent from the rendered output, not
// just that some fallback text is present.
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import AppError from "./error";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

afterEach(() => {
  cleanup();
});

describe("(app)/error.tsx", () => {
  it("never renders error.message, even when it contains something sensitive", () => {
    const sensitive = "password reset token abc123 leaked from postgres constraint xyz";
    const error = Object.assign(new Error(sensitive), { digest: "abc123digest" });

    render(<AppError error={error} reset={vi.fn()} />);

    expect(screen.queryByText(sensitive, { exact: false })).toBeNull();
    expect(document.body.textContent).not.toContain(sensitive);
  });

  it("shows the digest (a safe correlation id) and offers retry", () => {
    const error = Object.assign(new Error("anything"), { digest: "digest-123" });
    const reset = vi.fn();

    render(<AppError error={error} reset={reset} />);

    expect(screen.getByText(/digest-123/)).toBeTruthy();
    screen.getByRole("button", { name: /try again/i }).click();
    expect(reset).toHaveBeenCalled();
  });

  it("renders without a digest too — digest is optional on the error Next passes in", () => {
    const error = new Error("anything") as Error & { digest?: string };

    expect(() => render(<AppError error={error} reset={vi.fn()} />)).not.toThrow();
  });
});
