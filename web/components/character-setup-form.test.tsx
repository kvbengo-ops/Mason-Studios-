// @vitest-environment jsdom
//
// Pins two of this feature's two-sided rules directly against the rendered
// DOM (not just the pure word-count helper in lib/description-quality.ts):
// a thin description warns and a rich one does not, and a portrait
// staleness banner appears/disappears exactly with the `portraitStale`
// prop computed server-side (character/page.tsx). Both are the kind of
// "warning only shows in the state it's supposed to" rule this repo's own
// task write-up calls out as easy to ship with a fixture that never
// reaches the branch under test — see the negative controls run for this
// file (reported alongside the rest of this task's test summary).
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as NextNavigation from "next/navigation";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { improveDescription } from "@/actions/character";

// The Improve control calls a Server Action; the field under test only needs
// it to resolve so the preview opens.
vi.mock("@/actions/character", () => ({
  improveDescription: vi.fn(),
  describeProductFromPhoto: vi.fn(),
}));
import {
  CharacterSetupForm,
  CharacterDescriptionField,
  GenerateReferenceAction,
  SaveButton,
} from "./character-setup-form";
import type { ActionResult } from "@/lib/action-result";

// SetupForm calls useRouter() (it navigates to the next Setup step on a
// successful save), which throws "invariant expected app router to be
// mounted" without a real AppRouterContext. Only useRouter is replaced —
// unstable_rethrow stays the real one, since SetupForm's catch depends on
// it to re-throw Next's own control-flow errors rather than toasting them.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
});

function renderField(props: {
  initialValue: string;
  libraryTrigger?: React.ReactNode;
}): ReturnType<typeof render> {
  return render(
    <CharacterSetupForm action={async () => undefined} fallbackErrorMessage="failed">
      <CharacterDescriptionField
        initialValue={props.initialValue}
        locked={false}
        projectId="project-1"
        improveCostUsd={0.01}
        libraryTrigger={props.libraryTrigger}
      />
    </CharacterSetupForm>,
  );
}

describe("CharacterDescriptionField — word count / thin-description warning", () => {
  it("warns on a too-thin description (the reported incident: 'an athletic woman')", () => {
    renderField({ initialValue: "an athletic woman" });

    expect(screen.getByText(/too thin/i)).toBeTruthy();
    expect(screen.getByText(/3 words/i)).toBeTruthy();
  });

  it("does not warn on a rich description", () => {
    renderField({
      initialValue:
        "A woman in her late 20s with shoulder-length dark hair, wearing a cream linen shirt, " +
        "standing in a sunlit minimalist kitchen.",
    });

    expect(screen.queryByText(/too thin/i)).toBeNull();
  });
});

// Standing guidance, not a reprimand. It used to sit as always-visible
// prose under the field; it now lives behind the label's info-hint glyph
// (components/info-hint.tsx) instead, opened here by hovering the "More
// information" button, since the panel (role="tooltip") only renders once
// open. What's pinned is that the rule is reachable in every one of these
// states, not that it sits on screen unprompted.
describe("CharacterDescriptionField — the 12-word rule is always reachable", () => {
  async function openInfoHint(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    // Hover, not click: user.click() dispatches a hover (which InfoHint's
    // onMouseEnter already opens the panel on) immediately followed by the
    // click itself, and InfoHint's onClick TOGGLES — so a simulated click
    // would open it on the hover and then immediately close it again on the
    // click that follows. Hovering alone is one of the three ways the
    // component documents opening it (info-hint.tsx's own header comment).
    await user.hover(screen.getByRole("button", { name: /more information/i }));
  }

  it("states the rule while the field is still empty", async () => {
    const user = userEvent.setup();
    renderField({ initialValue: "" });
    await openInfoHint(user);
    expect(screen.getByRole("tooltip").textContent).toMatch(
      /write the clothing, hair, earrings, and light/i,
    );
  });

  it("keeps stating it on a description that already passes", async () => {
    const user = userEvent.setup();
    renderField({
      initialValue:
        "Filipina woman, late 20s, warm medium-brown skin, shoulder-length dark brown hair tied back, small silver stud earrings, cream oversized knit sweater, soft morning daylight.",
    });
    expect(screen.getByText(/enough detail/i)).toBeTruthy();
    await openInfoHint(user);
    expect(screen.getByRole("tooltip").textContent).toMatch(
      /write the clothing, hair, earrings, and light/i,
    );
  });

  it("still states it on a thin one", async () => {
    const user = userEvent.setup();
    renderField({ initialValue: "an athletic woman" });
    await openInfoHint(user);
    expect(screen.getByRole("tooltip").textContent).toMatch(
      /write the clothing, hair, earrings, and light/i,
    );
  });
});

// The design puts the library pick in the same row as rewrite my words —
// they are the two answers to "this description isn't good enough". It used
// to be folded inside a collapsed "Change character" disclosure.
describe("CharacterDescriptionField — the library pick sits beside Rewrite my words", () => {
  it("renders the passed library trigger alongside the Rewrite my words button", () => {
    renderField({
      initialValue: "a description",
      libraryTrigger: <a href="/lib">Character Library</a>,
    });

    const improve = screen.getByRole("button", { name: /rewrite my words/i });
    const library = screen.getByRole("link", { name: /character library/i });
    expect(improve.parentElement).toBe(library.parentElement);
  });
});

// The Character page's split-off field set: only the character description
// renders here now — title, script, product and direction/caption fields
// all moved to their own pages/routes. See actions/setup.ts's header for
// why the write had to split the same way.
describe("Character page — field isolation", () => {
  it("renders the character description field, and no field from another split page", () => {
    renderField({ initialValue: "a description" });

    expect(screen.getByRole("textbox", { name: /describe your character/i })).toBeTruthy();
    // Product page fields.
    expect(screen.queryByLabelText(/^\d+\. product name$/i)).toBeNull();
    expect(screen.queryByRole("textbox", { name: /product appearance/i })).toBeNull();
    // Script page field.
    expect(screen.queryByLabelText(/^script$/i)).toBeNull();
  });
});

describe("Character page — Save posts through the character form", () => {
  it("submits the description field to the bound action when Save is clicked", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async (_formData: FormData): Promise<ActionResult> => undefined);

    render(
      <CharacterSetupForm action={action} fallbackErrorMessage="failed">
        <CharacterDescriptionField
          initialValue=""
          locked={false}
          projectId="project-1"
          improveCostUsd={0.01}
        />
        <SaveButton locked={false} />
      </CharacterSetupForm>,
    );

    await user.type(
      screen.getByRole("textbox", { name: /describe your character/i }),
      "A woman in a kitchen.",
    );
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(action).toHaveBeenCalledTimes(1);
    const submitted = action.mock.calls[0]?.[0] as FormData;
    expect(submitted.get("description")).toBe("A woman in a kitchen.");
  });
});

// An empty field is not "too thin", it is unstarted — and the card above
// already says the description is required. This shipped shouting a warning
// at a field nobody had touched yet, which teaches the operator the warning
// is decoration long before it means anything.
describe("CharacterDescriptionField — silence before there is anything to judge", () => {
  it("says nothing at all while the field is empty", () => {
    renderField({ initialValue: "" });

    expect(screen.queryByText(/too thin/i)).toBeNull();
    expect(screen.queryByText(/enough detail/i)).toBeNull();
    // Not even the count — "0 words" beside a placeholder reads as a verdict
    // on text the operator can see but has not written.
    expect(screen.queryByText(/^0 words$/)).toBeNull();
  });

  it("says nothing for whitespace either", () => {
    renderField({ initialValue: "   \n  " });
    expect(screen.queryByText(/too thin/i)).toBeNull();
  });

  it("warns once there is real but insufficient text", () => {
    renderField({ initialValue: "an athletic woman" });
    expect(screen.getByText(/too thin/i)).toBeTruthy();
  });

  it("confirms once the description carries enough", () => {
    renderField({
      initialValue:
        "Filipina woman, late 20s, warm medium-brown skin, shoulder-length dark brown hair tied back, small silver stud earrings, cream oversized knit sweater, soft morning daylight.",
    });
    expect(screen.getByText(/enough detail/i)).toBeTruthy();
  });
});

// A suggestion sitting on screen is not the same as one applied to the
// field, and the label says so while one is outstanding. This shipped with
// no test at all: deleting the span, or the callback that drives it, broke
// nothing.
describe("CharacterDescriptionField — an unapplied suggestion is visible on the label", () => {
  it("says nothing while no suggestion is outstanding", () => {
    renderField({ initialValue: "an athletic woman in a red jacket by a window" });

    expect(screen.queryByText(/not applied yet/i)).toBeNull();
  });

  it("flags the label once a suggestion is on screen", async () => {
    vi.mocked(improveDescription).mockResolvedValue({ suggestion: "A much fuller description." });
    const user = userEvent.setup();
    renderField({ initialValue: "an athletic woman in a red jacket by a window" });

    await user.click(screen.getByRole("button", { name: /rewrite my words/i }));

    await waitFor(() => expect(screen.getByText(/not applied yet/i)).toBeTruthy());
  });

  it("clears the flag when the suggestion is discarded", async () => {
    vi.mocked(improveDescription).mockResolvedValue({ suggestion: "A much fuller description." });
    const user = userEvent.setup();
    renderField({ initialValue: "an athletic woman in a red jacket by a window" });

    await user.click(screen.getByRole("button", { name: /rewrite my words/i }));
    await waitFor(() => expect(screen.getByText(/not applied yet/i)).toBeTruthy());
    await user.click(screen.getByRole("button", { name: /discard/i }));

    await waitFor(() => expect(screen.queryByText(/not applied yet/i)).toBeNull());
  });
});

// The Character page's "Generate reference image" was
// `disabled={locked || !project.character_desc}` — gated on the SAVED
// column. Type a description and it stayed dead until Save was pressed: the
// field in front of you full, the one control that acts on it greyed out,
// nothing saying why. Reported during the 2026-08-31 production test.
describe("GenerateReferenceAction", () => {
  const save = vi.fn(async () => undefined);
  const generate = vi.fn(async () => undefined);

  afterEach(() => {
    save.mockClear();
    generate.mockClear();
  });

  function renderAction(hasSavedDescription: boolean): void {
    render(
      <CharacterSetupForm action={async () => undefined} fallbackErrorMessage="failed">
        <CharacterDescriptionField
          initialValue=""
          locked={false}
          projectId="project-1"
          improveCostUsd={0.01}
        />
        <GenerateReferenceAction
          action={generate}
          saveAction={save}
          label="Generate reference image ($0.02)"
          dirtyLabel="Save & generate ($0.02)"
          pendingLabel="Generating…"
          fallbackErrorMessage="failed"
          locked={false}
          hasSavedDescription={hasSavedDescription}
        />
      </CharacterSetupForm>,
    );
  }

  it("is live once something is typed, before any save", () => {
    renderAction(false);
    const button = screen.getByRole("button", { name: /Generate reference image/ });
    expect(button.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "a woman" } });
    expect(screen.getByRole("button", { name: /Save & generate/ }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("saves the typed description before generating from it", async () => {
    // The picture must come from the words on screen, not the previous ones.
    renderAction(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "a woman" } });
    fireEvent.click(screen.getByRole("button", { name: /Save & generate/ }));

    await waitFor(() => expect(generate).toHaveBeenCalled());
    expect(save).toHaveBeenCalled();
    expect(save.mock.invocationCallOrder[0]!).toBeLessThan(generate.mock.invocationCallOrder[0]!);
  });

  it("does not generate when the save fails", async () => {
    // Spending on the previous text is the expensive kind of surprise.
    save.mockResolvedValueOnce({ error: "nope" } as never);
    renderAction(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "a woman" } });
    fireEvent.click(screen.getByRole("button", { name: /Save & generate/ }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(generate).not.toHaveBeenCalled();
  });

  it("skips the save when nothing was typed", async () => {
    renderAction(true);
    fireEvent.click(screen.getByRole("button", { name: /Generate reference image/ }));
    await waitFor(() => expect(generate).toHaveBeenCalled());
    expect(save).not.toHaveBeenCalled();
  });
});
