// @vitest-environment jsdom
//
// Problem 1's regression coverage: a saved description used to be
// unreachable through the UI once a character had one at all — this is
// what the demo/README.md "vague description → different face every
// scene" failure actually looked like on screen. These tests cover the
// three states an operator can land on: an existing description (editable,
// pre-filled, not just displayed), no description (blocking, urgent, but
// still fixable right here), and a successful save collapsing back to the
// read view.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CharacterCard } from "./character-card";
import type { ActionResult } from "@/lib/action-result";

afterEach(() => {
  cleanup();
});

describe("CharacterCard", () => {
  it("renders an existing description as an editable, pre-filled field once Edit is clicked — not just a display-only excerpt", async () => {
    const user = userEvent.setup();
    const updateCharacter = vi.fn(async (_formData: FormData): Promise<ActionResult> => undefined);
    render(
      <CharacterCard
        name="Nana"
        description="an athletic woman"
        imageUrl="https://example.test/nana.jpg"
        updateCharacter={updateCharacter}
        removeCharacter={vi.fn(async (): Promise<ActionResult> => undefined)}
      />,
    );

    // Read view first: the description is visible as text, not a form —
    // no textbox exists yet.
    expect(screen.getByText("an athletic woman")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /description for nana/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: /edit nana/i }));

    const descriptionField = screen.getByRole("textbox", { name: /description for nana/i });
    expect((descriptionField as HTMLTextAreaElement).value).toBe("an athletic woman");
    // Pre-filled, and editable — not read-only.
    expect(descriptionField.hasAttribute("readonly")).toBe(false);
  });

  it("submitting the edit form saves the new description and collapses back to the read view", async () => {
    const user = userEvent.setup();
    const updateCharacter = vi.fn(async (_formData: FormData): Promise<ActionResult> => undefined);
    render(
      <CharacterCard
        name="Nana"
        description="an athletic woman"
        imageUrl={null}
        updateCharacter={updateCharacter}
        removeCharacter={vi.fn(async (): Promise<ActionResult> => undefined)}
      />,
    );

    await user.click(screen.getByRole("button", { name: /edit nana/i }));
    const descriptionField = screen.getByRole("textbox", { name: /description for nana/i });
    await user.clear(descriptionField);
    await user.type(
      descriptionField,
      "A woman in her late 20s with shoulder-length dark hair, wearing a cream linen shirt.",
    );
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(updateCharacter).toHaveBeenCalledTimes(1);
    const submittedFormData = updateCharacter.mock.calls[0]?.[0] as FormData;
    expect(submittedFormData.get("description")).toBe(
      "A woman in her late 20s with shoulder-length dark hair, wearing a cream linen shirt.",
    );

    // Collapsed back to the read view on a successful save (a real save
    // triggers revalidatePath, which is what would actually refresh the
    // displayed text server-side — out of scope for a component test, so
    // this only asserts the form itself closed, not the post-revalidate
    // text). waitFor, not waitForElementToBeRemoved: the mocked action
    // resolves fast enough that the button can already be gone by the
    // time this line runs, which the latter treats as a setup error.
    await waitFor(() => expect(screen.queryByRole("button", { name: /^save$/i })).toBeNull());
  });

  it("a character with no description renders the blocking state directly, with no click required to reach an editable field", () => {
    render(
      <CharacterCard
        name="Orphan"
        description={null}
        imageUrl={null}
        updateCharacter={vi.fn(async (): Promise<ActionResult> => undefined)}
        removeCharacter={vi.fn(async (): Promise<ActionResult> => undefined)}
      />,
    );

    // The urgent, blocking message is visible without any interaction —
    // useCharacter refuses to hand this card to a project with no
    // description of its own either, so this can't be one click deeper
    // than the has-a-description case.
    expect(screen.getByText(/no description/i)).toBeTruthy();
    const descriptionField = screen.getByRole("textbox", { name: /description for orphan/i });
    expect((descriptionField as HTMLTextAreaElement).value).toBe("");
    // No Cancel button — there is nothing yet to cancel back to.
    expect(screen.queryByRole("button", { name: /^cancel$/i })).toBeNull();
  });
});
