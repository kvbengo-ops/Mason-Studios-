// @vitest-environment jsdom
//
// Mirrors project-rail.test.tsx's own transition tests almost line for line,
// on purpose: this store exists to avoid the exact bug RailBusyStore's doc
// comment describes, and the only test that actually proves that is one
// that drives a REAL `<form action={...}>` submit and checks the bar while
// it is still pending — not one that calls the setter by hand. A regression
// back to `useState` inside UploadProgressProvider passes every other test
// in this file and fails only these two, which is how it is known this
// coverage is load-bearing rather than ceremony.

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JSX } from "react";
import {
  UploadProgressProvider,
  UploadProgressWhileSubmitting,
  useUploadProgress,
  useUploadProgressSetter,
} from "./upload-progress-store";
import { UploadProgressBar } from "./upload-progress-bar";

afterEach(() => {
  cleanup();
});

describe("UploadProgressBar, driven by an imperative setter", () => {
  function Reporter(): JSX.Element {
    const setProgress = useUploadProgressSetter();
    return (
      <>
        <button type="button" onClick={() => setProgress({ done: 1, total: 3 })}>
          report
        </button>
        <button type="button" onClick={() => setProgress(null)}>
          clear
        </button>
      </>
    );
  }

  it("renders nothing while no batch is reported", () => {
    render(
      <UploadProgressProvider>
        <UploadProgressBar />
      </UploadProgressProvider>,
    );
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it("shows the reported batch, and clears when the setter reports null", async () => {
    const user = userEvent.setup();
    render(
      <UploadProgressProvider>
        <UploadProgressBar />
        <Reporter />
      </UploadProgressProvider>,
    );

    await user.click(screen.getByRole("button", { name: "report" }));
    const bar = await waitFor(() => {
      const el = document.querySelector('[role="status"]');
      if (!el) throw new Error("bar not rendered");
      return el;
    });
    expect(bar.getAttribute("aria-label")).toBe("Uploading 1 of 3");

    await user.click(screen.getByRole("button", { name: "clear" }));
    await waitFor(() => expect(document.querySelector('[role="status"]')).toBeNull());
  });

  it("is a no-op outside a provider, same fallback RailBusyStore uses", () => {
    // A component rendered in isolation (a story, a test that doesn't wrap
    // the provider) must neither crash nor show a stale bar.
    render(<UploadProgressBar />);
    expect(document.querySelector('[role="status"]')).toBeNull();
  });
});

// The regression this whole file exists to catch: a form's own pending
// state is a React transition (that is what `<form action={fn}>` +
// useFormStatus IS), so a provider holding this in `useState` would defer
// the bar's own re-render until the transition settles — the moment the
// upload was already done. See RailBusyStore's doc comment in
// project-rail.tsx for the full story of why that shipped once already.
describe("UploadProgressWhileSubmitting — a form reports itself to the bar", () => {
  function FormScreen({ action }: { action: () => Promise<void> }): JSX.Element {
    return (
      <form action={action}>
        <UploadProgressWhileSubmitting />
        <button type="submit">Upload</button>
      </form>
    );
  }

  it("shows the bar while the form's action is in flight, and clears when it settles", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => {};
    const action = () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      });

    render(
      <UploadProgressProvider>
        <UploadProgressBar />
        <FormScreen action={action} />
      </UploadProgressProvider>,
    );
    expect(document.querySelector('[role="status"]')).toBeNull();

    await user.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(document.querySelector('[role="status"]')).toBeTruthy());

    await act(async () => {
      settle();
    });
    await waitFor(() => expect(document.querySelector('[role="status"]')).toBeNull());
  });

  it("clears the bar when the form unmounts mid-submit", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => {};
    const action = () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      });

    const { rerender } = render(
      <UploadProgressProvider>
        <UploadProgressBar />
        <FormScreen action={action} />
      </UploadProgressProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(document.querySelector('[role="status"]')).toBeTruthy());

    // The page (and the form on it) navigates away while the submit is
    // still pending — the bar must not stay lit for the rest of the session.
    rerender(
      <UploadProgressProvider>
        <UploadProgressBar />
      </UploadProgressProvider>,
    );
    await waitFor(() => expect(document.querySelector('[role="status"]')).toBeNull());

    await act(async () => {
      settle();
    });
  });
});

// Reading the store directly, for anything that wants the raw {done,total}
// rather than the bar's own rendering of it (not exercised elsewhere).
describe("useUploadProgress outside a provider", () => {
  it("reads null rather than throwing", () => {
    function Reader(): JSX.Element {
      const progress = useUploadProgress();
      return <span>{progress === null ? "idle" : "busy"}</span>;
    }
    render(<Reader />);
    expect(screen.getByText("idle")).toBeTruthy();
  });
});
