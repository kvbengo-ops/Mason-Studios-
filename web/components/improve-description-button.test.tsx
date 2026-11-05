// @vitest-environment jsdom
//
// Pins the one rule this control exists to enforce, and that this repo has
// already shipped the OPPOSITE of once: a generated suggestion must be
// PREVIEWED, never silently written. Apply (actions/brief.ts) used to
// overwrite an operator's hand-edited scene prompt with a fresh generation
// on a single click, no warning, the edit just gone — this control's whole
// shape (preview -> explicit Accept, or Discard) is the fix for that same
// class of bug on the Character/Product screens.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImproveDescriptionButton, diffWords } from "./improve-description-button";
import { improveDescription } from "@/actions/character";

vi.mock("@/actions/character", () => ({
  improveDescription: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.mocked(improveDescription).mockReset();
});

describe("ImproveDescriptionButton", () => {
  it("shows a preview and does NOT call onAccept until Accept is pressed", async () => {
    const user = userEvent.setup();
    vi.mocked(improveDescription).mockResolvedValue({
      suggestion: "an athletic woman with shoulder-length dark hair, wearing running gear",
    });
    const onAccept = vi.fn();

    render(
      <ImproveDescriptionButton
        projectId="project-1"
        subject="character"
        description="an athletic woman"
        costUsd={0.01}
        disabled={false}
        onAccept={onAccept}
      />,
    );

    await user.click(screen.getByRole("button", { name: /rewrite my words/i }));

    await waitFor(() => {
      expect(screen.getByText(/shoulder-length dark hair/i)).toBeTruthy();
    });
    // The suggestion is on screen, but nothing has been "written" yet —
    // onAccept must not have fired from the generate click alone.
    expect(onAccept).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^accept$/i }));
    expect(onAccept).toHaveBeenCalledWith(
      "an athletic woman with shoulder-length dark hair, wearing running gear",
    );
  });

  it("Discard drops the suggestion without ever calling onAccept", async () => {
    const user = userEvent.setup();
    vi.mocked(improveDescription).mockResolvedValue({
      suggestion: "an athletic woman with shoulder-length dark hair",
    });
    const onAccept = vi.fn();

    render(
      <ImproveDescriptionButton
        projectId="project-1"
        subject="character"
        description="an athletic woman"
        costUsd={0.01}
        disabled={false}
        onAccept={onAccept}
      />,
    );

    await user.click(screen.getByRole("button", { name: /rewrite my words/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /discard/i })).toBeTruthy();
    });

    await user.click(screen.getByRole("button", { name: /discard/i }));

    // The original control (offering to try again) is back; the suggestion
    // text is gone, and the caller's field was never touched.
    expect(screen.queryByText(/shoulder-length dark hair/i)).toBeNull();
    expect(onAccept).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /rewrite my words/i })).toBeTruthy();
  });

  it("shows the price before the click, on the button itself", () => {
    render(
      <ImproveDescriptionButton
        projectId="project-1"
        subject="character"
        description="an athletic woman"
        costUsd={0.03}
        disabled={false}
        onAccept={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /\$0\.03/ })).toBeTruthy();
  });

  it("is disabled while a request is in flight, so a slow call can't be double-clicked", async () => {
    const user = userEvent.setup();
    let resolveCall: (value: { suggestion: string }) => void = () => {};
    vi.mocked(improveDescription).mockReturnValue(
      new Promise((resolve) => {
        resolveCall = resolve;
      }),
    );

    render(
      <ImproveDescriptionButton
        projectId="project-1"
        subject="character"
        description="an athletic woman"
        costUsd={0.01}
        disabled={false}
        onAccept={vi.fn()}
      />,
    );

    const button = screen.getByRole("button", { name: /rewrite my words/i });
    await user.click(button);

    // The button keeps its own label and price while running — the spinner
    // is what changes (see PendingButton). So this looks the button up by
    // the name it had before the click, which is the point: an operator
    // watching a slow call can still read what they pressed and what it
    // costs.
    await waitFor(() => {
      const running = screen.getByRole("button", { name: /rewrite my words/i });
      expect((running as HTMLButtonElement).disabled).toBe(true);
      expect(running.querySelector("svg.animate-spin")).toBeTruthy();
    });
    // Only ever called once — the disabled state actually prevented a second
    // in-flight request from firing.
    expect(improveDescription).toHaveBeenCalledTimes(1);

    resolveCall({ suggestion: "done" });
  });
});

// The preview leaves the textarea above fully editable, and Accept replaces
// the WHOLE field. So an operator who keeps typing while the suggestion sits
// on screen loses those keystrokes the moment they Accept — text generated
// from the older version wins, silently. That is the Apply bug again,
// arriving through the one door preview-then-accept leaves open.
describe("ImproveDescriptionButton — the field moved while you were reading", () => {
  async function generateFrom(initial: string): Promise<void> {
    vi.mocked(improveDescription).mockResolvedValue({ suggestion: "A fuller description." });
    const user = userEvent.setup();
    render(
      <ImproveDescriptionButton
        projectId="p1"
        subject="character"
        description={initial}
        costUsd={0.01}
        disabled={false}
        onAccept={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /rewrite my words/i }));
    await waitFor(() => expect(screen.getByText("A fuller description.")).toBeTruthy());
  }

  it("says nothing extra while the description still matches what it generated from", async () => {
    await generateFrom("an athletic woman");
    expect(screen.queryByText(/edited the description since/i)).toBeNull();
  });

  it("warns that Accept will drop edits made after the suggestion arrived", async () => {
    // Re-render with a CHANGED description prop — the same thing typing into
    // the (uncontrolled) textarea above does, since the parent reads it live
    // and passes it down on every keystroke.
    vi.mocked(improveDescription).mockResolvedValue({ suggestion: "A fuller description." });
    const user = userEvent.setup();
    const { rerender } = render(
      <ImproveDescriptionButton
        projectId="p1"
        subject="character"
        description="an athletic woman"
        costUsd={0.01}
        disabled={false}
        onAccept={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /rewrite my words/i }));
    await waitFor(() => expect(screen.getByText("A fuller description.")).toBeTruthy());

    rerender(
      <ImproveDescriptionButton
        projectId="p1"
        subject="character"
        description="an athletic woman in a red jacket"
        costUsd={0.01}
        disabled={false}
        onAccept={vi.fn()}
      />,
    );

    expect(screen.getByText(/edited the description since/i)).toBeTruthy();
    // Accept stays available — the operator may be happy to lose a typo fix.
    // The bug was that it was a surprise, not that it was possible.
    expect(screen.getByRole("button", { name: "Accept" }).hasAttribute("disabled")).toBe(false);
  });
});

// Design note 4. Accept replaces the operator's whole description in one
// click, and the question it has to answer first is "did this drop anything
// I wrote". Two paragraphs of near-identical prose do not answer it — a
// human reads the first line of each, sees they match, and accepts. The
// marks and the counts do.
describe("diffWords", () => {
  it("marks an insertion and leaves the surrounding words alone", () => {
    expect(diffWords("a cream knit sweater", "a cream oversized knit sweater")).toEqual([
      { kind: "same", text: "a cream" },
      { kind: "added", text: "oversized" },
      { kind: "same", text: "knit sweater" },
    ]);
  });

  it("marks a deletion, which is the case the counts exist for", () => {
    expect(diffWords("a cream knit sweater", "a knit sweater")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "cream" },
      { kind: "same", text: "knit sweater" },
    ]);
  });

  it("treats a completely rewritten description as a removal plus an addition", () => {
    expect(diffWords("an athletic woman", "Filipina woman in a kitchen")).toEqual([
      { kind: "removed", text: "an athletic" },
      { kind: "added", text: "Filipina" },
      { kind: "same", text: "woman" },
      { kind: "added", text: "in a kitchen" },
    ]);
  });
});

describe("ImproveDescriptionButton — the preview shows what changed", () => {
  async function preview(description: string, suggestion: string): Promise<void> {
    vi.mocked(improveDescription).mockResolvedValue({ suggestion });
    const user = userEvent.setup();
    render(
      <ImproveDescriptionButton
        projectId="p1"
        subject="character"
        description={description}
        costUsd={0.01}
        disabled={false}
        onAccept={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /rewrite my words/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^accept$/i })).toBeTruthy());
  }

  it("highlights the added words and prints the before/after count", async () => {
    await preview("a cream knit sweater", "a cream oversized knit sweater");

    const added = screen.getByText("oversized");
    expect(added.tagName).toBe("MARK");
    expect(screen.getByText("4 → 5 words")).toBeTruthy();
    expect(screen.getByText("1 added, 0 removed")).toBeTruthy();
  });

  it("strikes through what the model dropped, so 'nothing was deleted' is checkable", async () => {
    await preview("a cream knit sweater", "a knit sweater");

    const removed = screen.getByText("cream");
    expect(removed.tagName).toBe("DEL");
    expect(screen.getByText("0 added, 1 removed")).toBeTruthy();
  });
});

// Re-rolling used to mean Discard then Improve again — which throws the
// first suggestion away before you can compare the two, for the same money.
describe("ImproveDescriptionButton — Retry re-rolls without dropping the preview", () => {
  it("asks for a second suggestion and swaps it in, preview still open", async () => {
    const user = userEvent.setup();
    vi.mocked(improveDescription).mockResolvedValue({ suggestion: "first suggestion" });
    render(
      <ImproveDescriptionButton
        projectId="p1"
        subject="character"
        description="an athletic woman"
        costUsd={0.01}
        disabled={false}
        onAccept={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /rewrite my words/i }));
    await waitFor(() => expect(screen.getByText("first suggestion")).toBeTruthy());

    vi.mocked(improveDescription).mockResolvedValue({ suggestion: "second suggestion" });
    await user.click(screen.getByRole("button", { name: /retry \(\$0\.01\)/i }));

    await waitFor(() => expect(screen.getByText("second suggestion")).toBeTruthy());
    expect(screen.queryByText("first suggestion")).toBeNull();
    // Never dropped back to the plain Improve button in between.
    expect(screen.getByRole("button", { name: /^accept$/i })).toBeTruthy();
    expect(improveDescription).toHaveBeenCalledTimes(2);
  });
});

// The library pick belongs in the same row as Improve, and NOT among
// Accept/Discard/Retry — a route out of the screen sitting beside those is a
// way to lose an outstanding suggestion by misclick.
describe("ImproveDescriptionButton — the secondary action", () => {
  it("renders beside Improve, and disappears while a suggestion is on screen", async () => {
    const user = userEvent.setup();
    vi.mocked(improveDescription).mockResolvedValue({ suggestion: "a fuller description" });
    render(
      <ImproveDescriptionButton
        projectId="p1"
        subject="character"
        description="an athletic woman"
        costUsd={0.01}
        disabled={false}
        onAccept={vi.fn()}
        secondaryAction={<a href="/lib">Character Library</a>}
      />,
    );

    const improve = screen.getByRole("button", { name: /rewrite my words/i });
    const library = screen.getByRole("link", { name: /character library/i });
    expect(improve.parentElement).toBe(library.parentElement);

    await user.click(improve);
    await waitFor(() => expect(screen.getByRole("button", { name: /^accept$/i })).toBeTruthy());
    expect(screen.queryByRole("link", { name: /character library/i })).toBeNull();
  });
});
