// @vitest-environment jsdom
//
// ActionForm had no tests at all until 2026-09-04, which mattered the moment
// it grew a second branch.
//
// It is the one place that decides what an operator SEES when a Server Action
// comes back, and lib/action-result.ts explains why that has to come back as
// data: React redacts anything thrown from a Server Action in production, so
// a thrown message is one nobody will ever read. Everything downstream of that
// design lands here — and a branch here that silently does nothing produces
// exactly the failure the notice was added to prevent, while looking covered.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach } from "vitest";

// Built inside the factory, not above it: vi.mock is hoisted to the top of
// the file, so a top-level const is not yet initialised when it runs.
vi.mock("sonner", () => {
  const fn = vi.fn() as unknown as ReturnType<typeof vi.fn> & {
    error: ReturnType<typeof vi.fn>;
    success: ReturnType<typeof vi.fn>;
  };
  fn.error = vi.fn();
  fn.success = vi.fn();
  return { toast: fn };
});
vi.mock("next/navigation", () => ({ unstable_rethrow: () => {} }));

import { toast as rawToast } from "sonner";
import { ActionForm } from "./action-form";

const toast = rawToast as unknown as ReturnType<typeof vi.fn> & {
  error: ReturnType<typeof vi.fn>;
  success: ReturnType<typeof vi.fn>;
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
});

async function submitWith(action: (formData: FormData) => Promise<unknown>) {
  const user = userEvent.setup();
  render(
    <ActionForm action={action as never}>
      <button type="submit">Go</button>
    </ActionForm>,
  );
  await user.click(screen.getByRole("button", { name: "Go" }));
}

describe("ActionForm shows what came back", () => {
  it("raises an error as an error", async () => {
    await submitWith(async () => ({ error: "Rendering has already started." }));

    expect(toast.error).toHaveBeenCalledWith("Rendering has already started.");
    expect(toast).not.toHaveBeenCalled();
  });

  it("shows a notice WITHOUT dressing it as a failure", async () => {
    // THE BRANCH THIS FILE WAS WRITTEN FOR. generateClip returns a notice when
    // a prompt names a reference that no longer exists: the clip is queued and
    // billed, and this is the only thing that says so. If it silently did
    // nothing the warning would not exist while appearing to.
    //
    // Not toast.error, deliberately. The action worked; calling it a failure
    // teaches an operator to distrust a render that is fine apart from one
    // missing reference.
    await submitWith(async () => ({ notice: "Rendering without @new — no reference by that name." }));

    expect(toast).toHaveBeenCalledWith(
      "Rendering without @new — no reference by that name.",
      expect.objectContaining({ duration: expect.any(Number) }),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("says nothing at all on a plain success", async () => {
    // The common case, and the one a careless "show whatever came back" would
    // break by toasting undefined.
    await submitWith(async () => undefined);

    expect(toast).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("reports a thrown error, since a throw is what an unanticipated failure does", async () => {
    await submitWith(async () => {
      throw new Error("the database returned an error");
    });

    expect(toast.error).toHaveBeenCalledWith("the database returned an error");
  });

  it("falls back to the given message when a non-Error is thrown", async () => {
    const user = userEvent.setup();
    render(
      <ActionForm
        action={
          (async () => {
            throw "not an Error";
          }) as never
        }
        fallbackErrorMessage="The clip could not be queued."
      >
        <button type="submit">Go</button>
      </ActionForm>,
    );
    await user.click(screen.getByRole("button", { name: "Go" }));

    expect(toast.error).toHaveBeenCalledWith("The clip could not be queued.");
  });
});
