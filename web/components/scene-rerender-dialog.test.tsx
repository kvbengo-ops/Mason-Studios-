// @vitest-environment jsdom
//
// Regression coverage for the tier-1 (money-spending) shape this codebase's
// priced dialogs already share: Confirm has to disable itself the instant
// it's pressed, so a second click can never fire a second paid
// rerenderScene call, and a refused save (returned as ActionResult data,
// not thrown — see lib/action-result.ts's #441 note) still has to reach the
// operator once the pending state clears rather than being redacted or
// dropped on the floor. Nothing in this suite pinned that shape yet even
// though several dialogs (this one, render-confirm-dialog.tsx,
// scene-reopen-dialog.tsx, RetryAllFailedDialog in render-progress.tsx) all
// depend on it identically.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SceneRerenderDialog } from "./scene-rerender-dialog";
import { rerenderScene, retryScene } from "@/actions/enqueue";
import type { RenderBudgetFigures } from "@/lib/render-budget";

vi.mock("@/actions/enqueue", () => ({
  rerenderScene: vi.fn(),
  enqueueScene: vi.fn(),
  retryScene: vi.fn(),
}));

const BUDGET: RenderBudgetFigures = {
  dailyRemainingUsd: 10,
  dailyCapUsd: 10,
  weeklyRemainingUsd: 50,
  weeklyCapUsd: 50,
  globalRemainingUsd: 100,
  globalCapUsd: 100,
};

afterEach(() => {
  cleanup();
  vi.mocked(rerenderScene).mockReset();
  vi.mocked(retryScene).mockReset();
});

/** Opens the dialog and returns its Confirm button — distinct from the trigger, which stays mounted underneath and shares no text with it ("Confirm — $X.XX" vs "Re-render — $X.XX"). */
async function openAndGetConfirmButton(): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /^re-render/i }));
  const dialog = screen.getByRole("dialog");
  return within(dialog).getByRole("button", { name: /^confirm/i });
}

describe("SceneRerenderDialog — a money-spending control", () => {
  it("disables Confirm while the paid call is in flight, and a second press dispatches no second call", async () => {
    const user = userEvent.setup();
    let resolveRerender: () => void = () => {};
    vi.mocked(rerenderScene).mockReturnValue(
      new Promise((resolve) => {
        resolveRerender = () => resolve(undefined);
      }),
    );

    render(
      <SceneRerenderDialog sceneId="scene-1" sceneLabel="Scene 4" costUsd={0.42} budget={BUDGET} />,
    );
    const confirmButton = await openAndGetConfirmButton();

    // The label does NOT change — the ring appears beside it. That is the
    // point on this particular button: its text IS the price, and swapping
    // it for "Re-rendering…" deletes the number at the exact moment the
    // operator is waiting to find out what they agreed to spend. The
    // disabled state is what a screen reader and a sighted user share here;
    // the ring is aria-hidden, so the accessible name stays the price too.
    await user.click(confirmButton);
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
    expect(confirmButton.hasAttribute("aria-label")).toBe(false);
    expect(confirmButton.textContent).toContain("$0.42");
    expect(confirmButton.querySelector("svg.animate-spin")).not.toBeNull();

    await user.click(confirmButton);
    expect(rerenderScene).toHaveBeenCalledTimes(1);

    // A successful rerenderScene closes the dialog (setOpen(false)) rather
    // than re-enabling Confirm in place — the button itself unmounts, so
    // the settled state to check for is the dialog closing, not its own
    // disabled attribute flipping back.
    resolveRerender();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a returned ActionResult error survives the pending state and reaches the operator", async () => {
    const user = userEvent.setup();
    vi.mocked(rerenderScene).mockResolvedValue({ error: "This project is over its daily cap." });

    render(
      <SceneRerenderDialog sceneId="scene-1" sceneLabel="Scene 4" costUsd={0.42} budget={BUDGET} />,
    );
    const confirmButton = await openAndGetConfirmButton();

    await user.click(confirmButton);

    // Pending clears (the dialog stays open on a refusal, unlike a
    // success) and the message from the ActionResult — not a generic
    // fallback — is what's on screen.
    await waitFor(() => expect((confirmButton as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText("This project is over its daily cap.")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

// The trigger used to append min(daily, weekly, global) in USD and call it
// "left". That is the account's own spend caps — a different quantity from
// the vendor balance the design names, and one that can read "$40.00 left"
// while kie's credits are exhausted and every render is refused. The two
// numbers move independently, so the button has to name the one it means,
// in that vendor's own unit.
describe("SceneRerenderDialog — the balance on the button is the vendor's, not the caps'", () => {
  it("shows the vendor balance in the vendor's own unit, and never the caps figure", () => {
    render(
      <SceneRerenderDialog
        sceneId="scene-1"
        sceneLabel="Scene 4"
        costUsd={1.89}
        vendor="kie"
        vendorBalanceLabel="442 cr"
        budget={BUDGET}
      />,
    );

    const trigger = screen.getByRole("button", { name: /^re-render/i });
    expect(trigger.textContent).toContain("442 cr left on kie");
    // BUDGET's smallest cap is $10.00 — the old figure. If it is back on
    // the button, the button is quoting spend caps as a balance again.
    expect(trigger.textContent).not.toContain("$10.00");
  });

  it("says nothing at all when the balance could not be read, rather than showing a zero", () => {
    render(
      <SceneRerenderDialog
        sceneId="scene-1"
        sceneLabel="Scene 4"
        costUsd={1.89}
        vendor="kie"
        vendorBalanceLabel={null}
        budget={BUDGET}
      />,
    );

    const trigger = screen.getByRole("button", { name: /^re-render/i });
    expect(trigger.textContent).not.toContain("left");
    expect(trigger.textContent).toContain("$1.89");
  });
});

// A retry is a fresh attempt at the same price as the one that failed, so it
// gets the same dialog as everything else here. What it must NOT get is the
// new-vs-update choice: that question only exists where there is a standing
// clip to overwrite, and a failed attempt has none.
describe('SceneRerenderDialog — kind="retry"', () => {
  it("asks first, retries on Confirm, and offers no version choice", async () => {
    const user = userEvent.setup();
    vi.mocked(retryScene).mockResolvedValue(undefined);

    render(
      <SceneRerenderDialog
        kind="retry"
        sceneId="scene-1"
        sceneLabel="Scene 4"
        costUsd={1.89}
        settingsLabel="Seedance 2.5 · 720p · 6s"
        budget={BUDGET}
      />,
    );

    await user.click(screen.getByRole("button", { name: /^retry/i }));
    const dialog = await screen.findByRole("dialog");

    expect(dialog.textContent).toContain("Retry Scene 4?");
    expect(dialog.textContent).toContain("Seedance 2.5 · 720p · 6s");
    expect(
      within(dialog).queryByRole("radiogroup"),
      "offered to overwrite a version on a scene whose attempt produced no clip",
    ).toBeNull();
    expect(retryScene).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: /^confirm/i }));
    await waitFor(() => expect(retryScene).toHaveBeenCalledWith("scene-1"));
    expect(rerenderScene).not.toHaveBeenCalled();
  });

  it("cancelling retries nothing", async () => {
    const user = userEvent.setup();

    render(
      <SceneRerenderDialog
        kind="retry"
        sceneId="scene-1"
        sceneLabel="Scene 4"
        costUsd={1.89}
        budget={BUDGET}
      />,
    );

    await user.click(screen.getByRole("button", { name: /^retry/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^cancel/i }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(retryScene).not.toHaveBeenCalled();
  });
});

// The settings line exists because a price on its own cannot be checked
// against anything — see settingsLabel's doc comment.
describe("SceneRerenderDialog — the settings behind the price", () => {
  it("names model, resolution and duration beside the cost", async () => {
    const user = userEvent.setup();

    render(
      <SceneRerenderDialog
        sceneId="scene-1"
        sceneLabel="Scene 4"
        costUsd={0.56}
        settingsLabel="Seedance 2.5 · 480p · 4s"
        budget={BUDGET}
      />,
    );

    await user.click(screen.getByRole("button", { name: /^re-render/i }));
    const dialog = await screen.findByRole("dialog");

    expect(dialog.textContent).toContain("$0.56");
    expect(dialog.textContent).toContain("Seedance 2.5 · 480p · 4s");
  });
});

describe("SceneRerenderDialog — published price source", () => {
  it("labels the unpublished Seedance estimate as BytePlus ModelArk", async () => {
    const user = userEvent.setup();

    render(
      <SceneRerenderDialog
        sceneId="scene-1"
        sceneLabel="Scene 4"
        costUsd={0.41}
        unpaidRate
        rateSource="BytePlus"
        budget={BUDGET}
      />,
    );

    await user.click(screen.getByRole("button", { name: /^re-render/i }));
    expect(
      await screen.findByText(/BytePlus ModelArk’s published token price, not a receipt/i),
    ).toBeTruthy();
    expect(screen.queryByText(/kie’s published figure/i)).toBeNull();
  });
});
