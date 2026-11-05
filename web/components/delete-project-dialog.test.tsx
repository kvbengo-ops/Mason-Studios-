// @vitest-environment jsdom
//
// Regression coverage for the gap this file's own header comment
// documents: handleDelete used to await deleteProject with no try/catch at
// all, so a real (non-redirecting) failure became an unhandled rejection
// inside startTransition — invisible to the operator, and liable to take
// the whole route down the way action-form.tsx exists specifically to
// prevent everywhere else. These tests pin the three things that fix has
// to hold: the destructive Confirm button disables the instant it's
// pressed (so a second click can't fire a second delete), it never fires a
// second call while the first is still in flight, and a thrown failure
// still reaches the operator (via toast) once the pending state clears,
// instead of being swallowed or crashing the page.
//
// The dialog is now controlled (`open`/`onOpenChange`), not self-owned —
// its only trigger is a DropdownMenu.Item (project-row-actions.tsx), and
// Radix tears down a menu's Content the instant it closes, before a
// nested dialog would ever get to open (see the component's own header
// comment). So these tests render it already `open`, instead of clicking a
// trigger button that no longer exists here.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { DeleteProjectDialog } from "./delete-project-dialog";
import { deleteProject } from "@/actions/project";

vi.mock("@/actions/project", () => ({
  deleteProject: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.mocked(deleteProject).mockReset();
  vi.mocked(toast.error).mockReset();
});

/** Renders the dialog already open and returns its Confirm ("Delete") button. */
function renderOpenAndGetConfirmButton(
  onOpenChange: (open: boolean) => void = vi.fn(),
): HTMLElement {
  render(
    <DeleteProjectDialog
      open
      onOpenChange={onOpenChange}
      projectId="proj-1"
      projectTitle="NeuroBlast Q4"
    />,
  );
  const dialog = screen.getByRole("dialog");
  return within(dialog).getByRole("button", { name: /^delete$/i });
}

describe("DeleteProjectDialog", () => {
  it("disables Confirm the instant it's pressed, and a second press before the first settles fires no second call", async () => {
    const user = userEvent.setup();
    // Deferred, not resolved immediately — needs to still be in flight for
    // the second-press assertion below to mean anything.
    let resolveDelete: () => void = () => {};
    vi.mocked(deleteProject).mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDelete = resolve;
      }),
    );

    const confirmButton = renderOpenAndGetConfirmButton();

    await user.click(confirmButton);
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
    // The label does NOT swap to "Deleting…" — PendingButton keeps the word
    // that says which button was pressed and adds the ring beside it. The
    // ring is the in-flight signal, so that is what this asserts.
    expect(confirmButton.textContent).toBe("Delete");
    expect(confirmButton.querySelector("svg.animate-spin")).not.toBeNull();

    // A second, stray press while still pending — a real button is
    // disabled at the DOM level, so this can't dispatch, but asserting the
    // call count directly is what actually proves no second delete fired
    // rather than just proving the attribute is set.
    await user.click(confirmButton);
    expect(deleteProject).toHaveBeenCalledTimes(1);

    resolveDelete();
    await waitFor(() => expect((confirmButton as HTMLButtonElement).disabled).toBe(false));
  });

  it("a thrown, non-redirect failure surfaces via toast once pending clears, instead of being swallowed", async () => {
    const user = userEvent.setup();
    vi.mocked(deleteProject).mockRejectedValue(
      new Error("Failed to delete project: still rendering"),
    );

    const confirmButton = renderOpenAndGetConfirmButton();

    await user.click(confirmButton);

    await waitFor(() => expect((confirmButton as HTMLButtonElement).disabled).toBe(false));
    expect(confirmButton.textContent).toBe("Delete");
    expect(confirmButton.querySelector("svg.animate-spin")).toBeNull();
    expect(toast.error).toHaveBeenCalledWith("Failed to delete project: still rendering");
  });

  it("a notFound()-shaped rejection (deleteProject's requireProject 404 — not owned, or already gone) surfaces via toast instead of being silently swallowed by unstable_rethrow", async () => {
    const user = userEvent.setup();
    const notFoundError = Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK"), {
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    vi.mocked(deleteProject).mockRejectedValue(notFoundError);

    const confirmButton = renderOpenAndGetConfirmButton();

    await user.click(confirmButton);

    await waitFor(() => expect((confirmButton as HTMLButtonElement).disabled).toBe(false));
    expect(toast.error).toHaveBeenCalledWith(
      "This project is no longer available, or isn't yours to delete.",
    );
  });

  it("a redirect()-shaped rejection (the success path) still propagates instead of being toasted, pinning navigation behaviour", async () => {
    const user = userEvent.setup();
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;push;/projects;307;",
    });
    vi.mocked(deleteProject).mockRejectedValue(redirectError);

    const confirmButton = renderOpenAndGetConfirmButton();

    // unstable_rethrow letting a redirect through here is exactly what a
    // real redirect looks like from inside startTransition's async
    // callback: nothing downstream awaits that promise, so — same as it
    // would in the browser, where Next's router intercepts it before it
    // ever reaches the console — it surfaces here as an uncaught
    // exception/rejection rather than something `await`-able. We capture
    // that via the process-level hooks instead of letting it fail the
    // run, and assert it's the untouched redirect error, not a toast.
    const caught = new Promise<unknown>((resolve) => {
      const onUncaught = (err: unknown): void => {
        process.off("uncaughtException", onUncaught);
        process.off("unhandledRejection", onUncaught);
        resolve(err);
      };
      process.once("uncaughtException", onUncaught);
      process.once("unhandledRejection", onUncaught);
    });

    await user.click(confirmButton);

    expect(await caught).toBe(redirectError);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("Cancel calls onOpenChange(false) instead of owning its own open state", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <DeleteProjectDialog
        open
        onOpenChange={onOpenChange}
        projectId="proj-1"
        projectTitle="NeuroBlast Q4"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
