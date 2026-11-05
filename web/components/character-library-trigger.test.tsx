// @vitest-environment jsdom
//
// The compact row that replaced the Character page's old always-expanded
// Character Library card. Its one job: be a real <Link> to a `library=1`
// URL (so opening the modal is a navigation the URL remembers), not a
// button flipping local state.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CharacterLibraryTrigger } from "./character-library-trigger";

afterEach(() => {
  cleanup();
});

describe("CharacterLibraryTrigger", () => {
  it("links to the given href, not a button with local state", () => {
    render(
      <CharacterLibraryTrigger
        href="/projects/proj-1/character?library=1"
        count={8}
        inUseName={null}
      />,
    );
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/projects/proj-1/character?library=1");
  });

  it("shows the saved count", () => {
    render(
      <CharacterLibraryTrigger
        href="/projects/proj-1/character?library=1"
        count={8}
        inUseName={null}
      />,
    );
    expect(screen.getByText(/8 saved/)).toBeTruthy();
  });

  it("names the in-use character when the project already has one", () => {
    render(
      <CharacterLibraryTrigger
        href="/projects/proj-1/character?library=1"
        count={8}
        inUseName="Jane"
      />,
    );
    expect(screen.getByText(/Jane/)).toBeTruthy();
  });
});
