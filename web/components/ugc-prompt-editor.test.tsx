// @vitest-environment jsdom
//
// The @tag overlay, and the one rule on this screen that is about money
// rather than about typing: an unknown tag must not look like a real one.
// A typo costs exactly what a real reference costs — the render goes ahead
// with nothing behind it and bills the same — so "@jenn" where the operator
// meant "@jen" has to read as a MISS at a glance, and say so when hovered.
//
// What this file does NOT test, and cannot: whether the transparent mirror
// lands pixel-on-pixel over the textarea. jsdom computes no layout, so that
// alignment is unverifiable here and stays a thing to check by eye. What IS
// testable is the mechanism the alignment depends on — both boxes deriving
// their font, size, padding and border from ONE shared constant — so that a
// change to the textarea's padding which forgets the mirror fails here
// rather than drifting quietly on screen.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type JSX } from "react";
import { UgcPromptEditor } from "./ugc-prompt-editor";
import type { ElementTag } from "@/lib/elements";

afterEach(() => {
  cleanup();
});

const ELEMENTS: readonly ElementTag[] = [
  {
    id: "el-1",
    name: "jen",
    category: "character",
    description: "the presenter",
    assetKind: "ref_frame" as const,
    previewUrl: "https://example.test/jen.jpg",
  },
  {
    id: "el-2",
    name: "bottle",
    category: "product",
    description: null,
    assetKind: "ref_frame" as const,
    previewUrl: "https://example.test/bottle.jpg",
  },
];

/**
 * The editor is controlled, so undo has nothing to act on unless something
 * holds the value — this is the parent it has in the app, reduced to the one
 * thing that matters here.
 */
function LiveEditor({ initial, historyKey }: { initial: string; historyKey?: string }): JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <UgcPromptEditor
      id="prompt"
      name="prompt"
      value={value}
      onChange={setValue}
      elements={ELEMENTS}
      historyKey={historyKey}
      placeholder="Describe the shot"
    />
  );
}

function box(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

const undoButton = (): HTMLButtonElement =>
  screen.getByRole("button", { name: /undo the last edit/i }) as HTMLButtonElement;
const redoButton = (): HTMLButtonElement =>
  screen.getByRole("button", { name: /redo the edit/i }) as HTMLButtonElement;
const clearButton = (): HTMLButtonElement =>
  screen.getByRole("button", { name: "Clear" }) as HTMLButtonElement;

describe("the prompt box can be walked back", () => {
  it("has nothing to undo or redo until something is edited", () => {
    render(<LiveEditor initial="a woman holds the bottle" />);

    expect(undoButton().disabled).toBe(true);
    expect(redoButton().disabled).toBe(true);
    expect(clearButton().disabled).toBe(false);
  });

  it("clears the prompt as an undoable edit", async () => {
    const user = userEvent.setup();
    render(<LiveEditor initial="a woman holds the bottle" />);

    await user.click(clearButton());
    expect(box().value).toBe("");
    expect(undoButton().disabled).toBe(false);

    await user.click(undoButton());
    expect(box().value).toBe("a woman holds the bottle");

    await user.click(redoButton());
    expect(box().value).toBe("");
  });

  it("takes back a tag insertion — the edit native undo cannot reach", async () => {
    // THE REASON THIS EXISTS. A textarea's own undo covers typing, and
    // breaks the moment the value is written programmatically, which is what
    // picking from the suggestion menu does. So the one edit an operator
    // most wants back is the one the browser will not give them.
    const user = userEvent.setup();
    render(<LiveEditor initial="" />);

    await user.click(box());
    await user.keyboard("@je");
    await user.click(await screen.findByRole("option", { name: /@jen/i }));
    expect(box().value).toBe("@jen ");

    await user.click(undoButton());

    expect(box().value).toBe("@je");
  });

  it("puts back what undo removed, and only until the next edit", async () => {
    const user = userEvent.setup();
    render(<LiveEditor initial="" />);

    await user.click(box());
    await user.keyboard("@je");
    await user.click(await screen.findByRole("option", { name: /@jen/i }));
    await user.click(undoButton());
    expect(redoButton().disabled).toBe(false);

    await user.click(redoButton());
    expect(box().value).toBe("@jen ");

    // A NEW EDIT ENDS THE REDO PATH: keeping it would let Redo jump to text
    // that never followed what is on screen.
    await user.click(undoButton());
    // Back into the box first: pressing Undo moves focus to the button, and
    // restore() returns it on the next frame — which a real browser runs and
    // jsdom does not.
    await user.click(box());
    await user.keyboard("n");
    expect(redoButton().disabled).toBe(true);
  });

  it("does not reach across a scene change", async () => {
    // Picking another scene replaces the whole box. An undo that crossed
    // that boundary would paste one scene's prompt into another, with
    // nothing on screen saying where the words came from.
    const user = userEvent.setup();
    const { rerender } = render(<LiveEditor initial="" historyKey="scene-1" />);

    await user.click(box());
    await user.keyboard("hello");
    expect(undoButton().disabled).toBe(false);

    rerender(<LiveEditor initial="" historyKey="scene-2" />);

    expect(undoButton().disabled).toBe(true);
  });
});

function renderEditor(value: string, onChange = vi.fn()) {
  const result = render(
    <UgcPromptEditor
      id="prompt"
      name="prompt"
      value={value}
      onChange={onChange}
      elements={ELEMENTS}
      placeholder="Describe the shot"
    />,
  );
  return { ...result, onChange };
}

describe("UgcPromptEditor tells a real reference from a typo", () => {
  it("marks an unknown tag as a miss and says it costs the same", () => {
    // The standing rule. A tag that resolves to nothing still renders and
    // still bills, so the failure has to be visible BEFORE the press.
    renderEditor("@jenn holds the bottle");

    const unknown = screen.getByLabelText(/unknown reference: jenn/i);
    expect(unknown, "an unknown tag was not labelled as unknown").toBeTruthy();
    // The card mounts only while a tag is hovered or focused.
    fireEvent.focus(unknown);
    expect(screen.getByRole("tooltip", { hidden: true }).textContent ?? "").toMatch(
      /same cost, no reference/i,
    );
  });

  it("labels a known tag as a reference, with its own preview and category", () => {
    renderEditor("@jen holds the bottle");

    fireEvent.focus(screen.getByLabelText("Reference: jen"));
    const tooltip = screen.getByRole("tooltip", { hidden: true });
    expect(tooltip.textContent ?? "").toContain("character");
    expect(tooltip.textContent ?? "").toContain("the presenter");
    expect(tooltip.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.test/jen.jpg",
    );
  });

  it("styles the two differently, not just labels them", () => {
    // The label is for screen readers; the operator scanning the field sees
    // only colour and underline. Both have to disagree, or a typo passes.
    renderEditor("@jen and @jenn");

    const known = screen.getByLabelText("Reference: jen");
    const unknown = screen.getByLabelText(/unknown reference: jenn/i);

    expect(known.className).toContain("bg-primary/25");
    expect(unknown.className).toContain("bg-destructive/25");
    expect(
      unknown.className,
      "the unknown tag is painted like a real reference",
    ).not.toContain("bg-primary/25");
  });

  it("matches a tag name case-insensitively", () => {
    renderEditor("@JEN holds it");
    expect(screen.getByLabelText("Reference: JEN")).toBeTruthy();
  });

  it("stops a tag at punctuation, so @jen, still resolves", () => {
    // TAG_PATTERN deliberately excludes spaces and punctuation: "@jen," is
    // what an operator visually reads as one word.
    renderEditor("@jen, then the bottle");
    expect(screen.getByLabelText("Reference: jen")).toBeTruthy();
  });
});

describe("UgcPromptEditor's mirror stays out of the way", () => {
  it("hides the mirror from assistive tech — the textarea already carries the text", () => {
    const { container } = renderEditor("@jen holds the bottle");

    const mirror = container.querySelector('[aria-hidden="true"]');
    expect(mirror).not.toBeNull();
    expect(mirror?.className).toContain("pointer-events-none");
  });

  it("lets a tag span opt back into the pointer, and nothing else", () => {
    // This is what makes hovering a tag work without breaking typing
    // everywhere else in the field.
    renderEditor("plain words @jen more words");

    expect(screen.getByLabelText("Reference: jen").className).toContain(
      "pointer-events-auto",
    );
  });

  it("derives the mirror and the textarea from ONE box definition", () => {
    // The alignment itself cannot be checked here — jsdom has no layout — so
    // this checks the thing it depends on. Every class that controls the box
    // (font, size, leading, padding, border, wrapping) must appear on both,
    // which is what fails if someone re-pads the textarea alone.
    const { container } = renderEditor("@jen");

    const mirror = container.querySelector('[aria-hidden="true"]');
    const textarea = screen.getByRole("textbox");

    for (const shared of [
      "whitespace-pre-wrap",
      "break-words",
      "rounded-md",
      "border",
      "px-3",
      "py-2",
      "font-mono",
      "text-xs",
      "leading-relaxed",
    ]) {
      expect(mirror?.className, `mirror is missing ${shared}`).toContain(shared);
      expect(textarea.className, `textarea is missing ${shared}`).toContain(shared);
    }
  });

  it("ends a newline-terminated mirror with a NON-BREAKING space", () => {
    // Without a trailing character the mirror's final blank line collapses to
    // zero height on that side only, and every highlight below it drifts up a
    // row. The character has to be U+00A0 rather than a plain space: under
    // `whitespace-pre-wrap` a trailing ordinary space at a line end may be
    // hung or collapsed by the line-breaking algorithm, so it cannot be relied
    // on to hold the line open — which is exactly the alignment drift this
    // mirror exists to avoid.
    //
    // Written first as endsWith(" ") and it failed: the character is 160, not
    // 32. That is a deliberate \u{a0} in the source, and pinning it here is
    // what stops someone tidying the odd-looking escape into a normal space.
    const { container } = renderEditor("@jen\n");
    const mirror = container.querySelector('[aria-hidden="true"]');
    const text = mirror?.textContent ?? "";

    expect(text.endsWith("\u00a0"), "the mirror's line-holding character is not a non-breaking space").toBe(true);
    expect(text.endsWith(" "), "a plain space cannot be relied on to hold the line open").toBe(false);
  });
});

describe("UgcPromptEditor's autocomplete", () => {
  it("suggests the saved references matching the tag under the cursor", async () => {
    const user = userEvent.setup();
    renderEditor("@b");

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    await user.click(textarea);
    textarea.setSelectionRange(2, 2);
    await user.keyboard("{ArrowRight}");

    const list = await screen.findByRole("listbox", { name: /saved references/i });
    expect(within(list).getByText(/bottle/i)).toBeTruthy();
    expect(
      within(list).queryByText(/^jen$/i),
      "a reference that does not match the prefix was offered",
    ).toBeNull();
  });

  it("shows nothing until the field has focus", () => {
    renderEditor("@b");
    expect(screen.queryByRole("listbox", { name: /saved references/i })).toBeNull();
  });
});
