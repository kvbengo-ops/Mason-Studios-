// @vitest-environment jsdom
//
// Every clip project is created as "New project", so this control is on the
// common path rather than a rare one — and the common gesture is select-all,
// type, and either commit or think better of it. Each of those exits has a
// wrong answer that looks like nothing on screen: a rename to the empty
// string, a write for a title that did not change, or a rejected save leaving
// the failed text sitting in the field as though it had been accepted.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Typed with its real parameters rather than `async () => …`: an untyped mock
// infers a zero-argument signature, so `saveTitle.mock.calls[0][1]` is a type
// error and the assertion about what was submitted cannot be written at all.
const saveTitle = vi.fn(
  async (_projectId: string, _formData: FormData): Promise<{ error: string } | undefined> =>
    undefined,
);
const toastError = vi.fn();

vi.mock("@/actions/settings", () => ({
  saveTitle: (projectId: string, formData: FormData) => saveTitle(projectId, formData),
}));
vi.mock("sonner", () => ({ toast: { error: (m: string) => toastError(m) } }));

import { UgcTitle } from "./ugc-title";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The title in its read state — a real control, not a hover-revealed one. */
function titleButton(name: string | RegExp) {
  return screen.getByRole("button", { name });
}

/**
 * Opens the editor and hands back the field, focused.
 *
 * The component focuses via requestAnimationFrame + select(), and jsdom's
 * select() does not move focus — so a test that typed at "whatever has focus"
 * would type into the body and silently assert nothing. Naming the field is
 * the fix; in a real browser select() focuses and this is the same gesture.
 */
async function openEditor(
  user: ReturnType<typeof userEvent.setup>,
  currentTitle: string,
): Promise<HTMLElement> {
  await user.click(titleButton(currentTitle));
  const box = screen.getByRole("textbox", { name: /project name/i });
  await user.click(box);
  return box;
}

describe("UgcTitle is reachable without a pointer", () => {
  it("makes the title itself a button, not a control revealed on hover", () => {
    // A hover-revealed pencil does not exist on touch and misses keyboard
    // users unless it is also shown on :focus — the half that gets forgotten.
    // Since the common case is "this still needs a name", the title IS the
    // control. Asserted rather than left to the comment that explains it.
    render(<UgcTitle projectId="proj-1" title="New project" />);

    const button = titleButton("New project");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("title")).toBe("Rename");
  });

  it("labels the field for a screen reader once editing", async () => {
    const user = userEvent.setup();
    render(<UgcTitle projectId="proj-1" title="New project" />);

    await user.click(titleButton("New project"));
    expect(screen.getByRole("textbox", { name: /project name/i })).toBeTruthy();
  });
});

describe("UgcTitle writes only when the name actually changed", () => {
  it("treats an emptied field as a cancel, not a rename to nothing", async () => {
    // updateProject would refuse it anyway; refusing here means a slip costs
    // no toast and no round trip, and the old name comes straight back.
    const user = userEvent.setup();
    render(<UgcTitle projectId="proj-1" title="New project" />);

    const box = await openEditor(user, "New project");
    await user.clear(box);
    await user.tab();

    await waitFor(() => expect(titleButton("New project")).toBeTruthy());
    expect(saveTitle, "an empty field was submitted as a rename").not.toHaveBeenCalled();
  });

  it("does not write when the name is unchanged", async () => {
    const user = userEvent.setup();
    render(<UgcTitle projectId="proj-1" title="New project" />);

    await openEditor(user, "New project");
    await user.tab();

    await waitFor(() => expect(titleButton("New project")).toBeTruthy());
    expect(saveTitle).not.toHaveBeenCalled();
  });

  it("restores the old name on Escape without writing", async () => {
    const user = userEvent.setup();
    render(<UgcTitle projectId="proj-1" title="New project" />);

    const box = await openEditor(user, "New project");
    await user.clear(box);
    await user.type(box, "Lipstick ad{Escape}");

    await waitFor(() => expect(titleButton("New project")).toBeTruthy());
    expect(saveTitle, "Escape saved the abandoned edit").not.toHaveBeenCalled();
  });

  it("commits on Enter with the trimmed name", async () => {
    const user = userEvent.setup();
    render(<UgcTitle projectId="proj-1" title="New project" />);

    const box = await openEditor(user, "New project");
    await user.clear(box);
    await user.type(box, "  Lipstick ad  {Enter}");

    await waitFor(() => expect(saveTitle).toHaveBeenCalledTimes(1));
    const formData = saveTitle.mock.calls[0]?.[1] as unknown as FormData;
    expect(saveTitle.mock.calls[0]?.[0]).toBe("proj-1");
    expect(formData.get("title")).toBe("Lipstick ad");
  });
});

describe("UgcTitle does not keep a name the server refused", () => {
  it("puts the old name back and says so when the save is rejected", async () => {
    // Leaving the rejected text in the field is the failure that reads as
    // success: the operator sees their new name and believes it was saved.
    saveTitle.mockResolvedValueOnce({ error: "That name is already taken." });
    const user = userEvent.setup();
    render(<UgcTitle projectId="proj-1" title="New project" />);

    const box = await openEditor(user, "New project");
    await user.clear(box);
    await user.type(box, "Lipstick ad{Enter}");

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("That name is already taken."));
    await waitFor(() => expect(titleButton("New project")).toBeTruthy());
  });

  it("says so when the save throws, rather than failing silently", async () => {
    saveTitle.mockRejectedValueOnce(new Error("network"));
    const user = userEvent.setup();
    render(<UgcTitle projectId="proj-1" title="New project" />);

    const box = await openEditor(user, "New project");
    await user.clear(box);
    await user.type(box, "Lipstick ad{Enter}");

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to rename the project."));
    await waitFor(() => expect(titleButton("New project")).toBeTruthy());
  });
});
