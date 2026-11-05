// @vitest-environment jsdom
//
// setup-form.tsx builds one bundle per Setup page. This file drives that
// factory directly with its own throwaway formId, rather than importing one
// of the real Character/Product/Script pages, since the two behaviours under
// test — the pending spinner and redirectOnSuccessTo — live entirely in
// createSetupForm itself.
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as NextNavigation from "next/navigation";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createSetupForm } from "./setup-form";
import { RailBusyProvider, useRailBusySetter } from "@/components/project-rail";
import { useEffect } from "react";
import type { ActionResult } from "@/lib/action-result";
import type { JSX } from "react";

// Matches product-setup-form.test.tsx's mock exactly: only useRouter is
// replaced, unstable_rethrow stays real so SetupForm's catch can still
// re-throw Next's own control-flow errors instead of toasting them.
const push = vi.fn();
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

afterEach(() => {
  cleanup();
  push.mockClear();
  toastError.mockClear();
});

const { SetupForm, SaveButton, useSetupFormState } = createSetupForm("test-setup-form");

// The only field this file needs: a text input that marks the form dirty on
// change, wired to the form via the `form` attribute rather than DOM
// nesting — the whole point of createSetupForm, see its header comment.
function TestField(): JSX.Element {
  const { markDirty } = useSetupFormState();
  return <input aria-label="Name" form="test-setup-form" name="name" onChange={markDirty} />;
}

describe("SetupForm — dirty tracking", () => {
  it("keeps Save disabled, and shows the nothing-to-save line, until a field is dirty", async () => {
    const user = userEvent.setup();
    render(
      <SetupForm action={async () => undefined} fallbackErrorMessage="failed">
        <TestField />
        <SaveButton locked={false} />
      </SetupForm>,
    );

    const button = screen.getByRole("button", { name: /^save$/i });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/nothing to save/i)).toBeTruthy();

    await user.type(screen.getByLabelText("Name"), "x");

    expect(button.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText(/nothing to save/i)).toBeNull();
  });
});

describe("SetupForm — the Save spinner paints while the action is in flight", () => {
  // The whole point of the PendingStore rewrite: handleAction runs inside the
  // transition React opens for <form action={...}>, so this MUST be a real
  // form submit driven through the button rendered by SaveButton, not a
  // hand-mounted pending reporter — a fabricated pending value would never
  // touch the transition this bug lived in.
  it("shows the spinner while the save promise is unresolved, then hides it once it resolves", async () => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    const action = vi.fn(
      (): Promise<ActionResult | void> =>
        new Promise((resolve) => {
          release = () => resolve(undefined);
        }),
    );

    render(
      <SetupForm action={action} fallbackErrorMessage="failed">
        <TestField />
        <SaveButton locked={false} />
      </SetupForm>,
    );

    await user.type(screen.getByLabelText("Name"), "x");

    const button = screen.getByRole("button", { name: /^save$/i });
    expect(button.querySelector("svg.animate-spin")).toBeNull();

    await act(async () => {
      fireEvent.click(button);
    });

    // The action is in flight — its promise is still unresolved — and the
    // spinner must already be on screen, not merely scheduled.
    expect(action).toHaveBeenCalledTimes(1);
    expect(button.querySelector("svg.animate-spin")).toBeTruthy();
    expect(button.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      release?.();
      await Promise.resolve();
    });

    // Disabled here because the successful save cleared `dirty`, not because
    // it is still pending — the spinner is what proves pending is gone.
    expect(button.querySelector("svg.animate-spin")).toBeNull();
  });
});

describe("SetupForm — redirectOnSuccessTo", () => {
  it("navigates to the given href on a successful save", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async (): Promise<ActionResult> => undefined);

    render(
      <SetupForm action={action} fallbackErrorMessage="failed" redirectOnSuccessTo="/next-step">
        <TestField />
        <SaveButton locked={false} />
      </SetupForm>,
    );

    await user.type(screen.getByLabelText("Name"), "x");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(push).toHaveBeenCalledWith("/next-step");
  });

  it("does not navigate on a failed save, toasts the error, and releases the spinner", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async (): Promise<ActionResult> => ({ error: "Save failed" }));

    render(
      <SetupForm action={action} fallbackErrorMessage="failed" redirectOnSuccessTo="/next-step">
        <TestField />
        <SaveButton locked={false} />
      </SetupForm>,
    );

    await user.type(screen.getByLabelText("Name"), "x");
    const button = screen.getByRole("button", { name: /^save$/i });
    await user.click(button);

    expect(push).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("Save failed");
    // The real trap: an early version left the button spinning forever on a
    // failed save on a redirecting page.
    expect(button.querySelector("svg.animate-spin")).toBeNull();
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("does not navigate at all when no redirectOnSuccessTo is given, and releases the spinner", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async (): Promise<ActionResult> => undefined);

    render(
      <SetupForm action={action} fallbackErrorMessage="failed">
        <TestField />
        <SaveButton locked={false} />
      </SetupForm>,
    );

    await user.type(screen.getByLabelText("Name"), "x");
    const button = screen.getByRole("button", { name: /^save$/i });
    await user.click(button);

    expect(push).not.toHaveBeenCalled();
    // Disabled here because the successful save cleared `dirty`, not because
    // it is still pending — the spinner is what proves pending is gone.
    expect(button.querySelector("svg.animate-spin")).toBeNull();
  });

  it("keeps the button pending after a successful redirecting save resolves — it releases only when the new route paints", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async (): Promise<ActionResult> => undefined);

    render(
      <SetupForm action={action} fallbackErrorMessage="failed" redirectOnSuccessTo="/next-step">
        <TestField />
        <SaveButton locked={false} />
      </SetupForm>,
    );

    await user.type(screen.getByLabelText("Name"), "x");
    const button = screen.getByRole("button", { name: /^save$/i });
    await user.click(button);

    expect(push).toHaveBeenCalledWith("/next-step");
    // Deliberately still spinning: the save resolved, but this page never
    // sets pendingStore back to false on the navigating path.
    expect(button.querySelector("svg.animate-spin")).toBeTruthy();
    expect(button.hasAttribute("disabled")).toBe(true);
  });
});

// A paid generation on a Setup page is its own <ActionForm> on the Server
// Component page, so this form's `pending` never sees it. That is how the
// Product step came to offer a live Save underneath a card reading
// "Generating…": the description could be edited and saved while an image
// was being built from the OLD text, and nothing recorded which version the
// image came from. The signal was already being WRITTEN
// (RailBusyWhileSubmitting); nothing read it.
describe("SetupForm — Save while a paid generation runs", () => {
  function MarkBusy({ entryId }: { entryId: string }): null {
    const setRailBusy = useRailBusySetter();
    useEffect(() => {
      setRailBusy(entryId, true);
    }, [entryId, setRailBusy]);
    return null;
  }

  function renderWithBusy(busyEntryId: string | undefined, busy: boolean): void {
    render(
      <RailBusyProvider>
        {busy ? <MarkBusy entryId="setup-character" /> : null}
        <SetupForm action={async () => undefined} fallbackErrorMessage="failed">
          <TestField />
          <SaveButton locked={false} busyEntryId={busyEntryId} />
        </SetupForm>
      </RailBusyProvider>,
    );
  }

  function save(): HTMLButtonElement {
    return screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
  }

  it("shuts Save while this page's generation is running", () => {
    renderWithBusy("setup-character", true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    expect(save().disabled).toBe(true);
  });

  it("says why, rather than greying it in silence", () => {
    // The complaint that produced the "Nothing to save" sentence was about a
    // greyed button with nothing explaining it. This is the third reason
    // Save can be inert and the only temporary one.
    renderWithBusy("setup-character", true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    expect(screen.getByText(/An image is generating from what is currently stored/)).toBeTruthy();
  });

  it("leaves Save alone when nothing is generating", () => {
    renderWithBusy("setup-character", false);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    expect(save().disabled).toBe(false);
  });

  it("ignores another page's generation", () => {
    // The store is keyed per entry. A character image must not freeze the
    // Product page's Save.
    renderWithBusy("setup-product", true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    expect(save().disabled).toBe(false);
  });

  it("is unaffected on a page that declares no busy entry at all", () => {
    // The Script step has no paid generation beside its fields.
    renderWithBusy(undefined, true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    expect(save().disabled).toBe(false);
  });
});
