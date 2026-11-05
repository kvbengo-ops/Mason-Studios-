// @vitest-environment jsdom
//
// Pins the two things this dialog has to get right for the URL-state
// contract character/page.tsx relies on:
//   1. It renders open/closed strictly off the `open` PROP — never off its
//      own state — because that prop is a direct read of the `library`
//      search param on the server. If this component ever grew its own
//      "is it open" state, a real navigation (the search form, pagination)
//      would remount it with that state reset and the modal would appear
//      to close on its own.
//   2. Closing (✕, Escape, overlay click) navigates to `closeHref` via
//      router.push — it must NOT just flip local state, or the URL would
//      drift out of sync with what's on screen.
// Also covers the accessible name Radix wires from DialogTitle, since a
// dialog with no name is a dialog assistive tech can't announce.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CharacterLibraryDialog } from "./character-library-dialog";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

afterEach(() => {
  cleanup();
  pushMock.mockReset();
});

describe("CharacterLibraryDialog", () => {
  it("renders nothing when open is false", () => {
    render(
      <CharacterLibraryDialog open={false} closeHref="/projects/proj-1/character" count={8}>
        <p>panel body</p>
      </CharacterLibraryDialog>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders open, with an accessible name, when open is true", () => {
    render(
      <CharacterLibraryDialog open={true} closeHref="/projects/proj-1/character" count={8}>
        <p>panel body</p>
      </CharacterLibraryDialog>,
    );
    expect(screen.getByRole("dialog", { name: /character library/i })).toBeTruthy();
  });

  it("shows the passed-through server-rendered children", () => {
    render(
      <CharacterLibraryDialog open={true} closeHref="/projects/proj-1/character" count={8}>
        <p>panel body</p>
      </CharacterLibraryDialog>,
    );
    expect(screen.getByText("panel body")).toBeTruthy();
  });

  it("navigates to closeHref via router.push when the close button is clicked", async () => {
    const user = userEvent.setup();
    render(
      <CharacterLibraryDialog open={true} closeHref="/projects/proj-1/character" count={8}>
        <p>panel body</p>
      </CharacterLibraryDialog>,
    );
    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(pushMock).toHaveBeenCalledWith("/projects/proj-1/character");
  });

  it("navigates to closeHref via router.push on Escape", async () => {
    const user = userEvent.setup();
    render(
      <CharacterLibraryDialog open={true} closeHref="/projects/proj-1/character" count={8}>
        <p>panel body</p>
      </CharacterLibraryDialog>,
    );
    await user.keyboard("{Escape}");
    expect(pushMock).toHaveBeenCalledWith("/projects/proj-1/character");
  });
});
