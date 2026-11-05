// @vitest-environment jsdom
//
// The one thing this whole feature exists to protect: the Character
// Library's search form and pagination are REAL SERVER NAVIGATIONS (a GET
// form and <Link>s that change `?q=`/`?page=` on this same route) — not a
// client-side state flip. Once the library lives in a modal whose
// open/closed state is driven by a `library` search param, every one of
// those navigations has to carry `library=1` forward, or the very first
// search an operator types slams the modal shut. This suite pins that
// specifically, not just "the panel renders" — a test that only checked
// rendering would pass on a version that closes on every search.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import {
  CharacterLibraryPanel,
  buildCharacterLibraryHref,
  buildCharacterLibraryOpenHref,
} from "./character-library-panel";
import type { CharacterLibraryRow } from "@/lib/character-library-query";

vi.mock("@/actions/character-library", () => ({
  useCharacter: vi.fn(),
}));

// UseCharacterButton (rendered in the footer's confirm control) calls
// useRouter().replace on the already-in-use path — without this mock,
// useRouter() throws "invariant expected app router to be mounted" as soon
// as that button renders, since no real AppRouterContext exists here.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

afterEach(() => {
  cleanup();
});

const CHARACTERS: CharacterLibraryRow[] = [
  { id: "char-1", name: "Jane", description: "A person", storage_key: "k1" },
  { id: "char-2", name: "Bob", description: null, storage_key: "k2" },
];

function renderPanel(
  overrides: Partial<ComponentProps<typeof CharacterLibraryPanel>> = {},
): ReturnType<typeof render> {
  return render(
    <CharacterLibraryPanel
      projectId="proj-1"
      q=""
      totalCount={2}
      characters={CHARACTERS}
      imageUrls={["https://example.com/1.jpg", null]}
      browsing={false}
      requestedPage={1}
      totalPages={1}
      peekCount={12}
      sourceCharacterId={null}
      projectHasDescription={false}
      fieldsLocked={false}
      usageCounts={{ "char-1": 4 }}
      canCreate={false}
      closeHref="/projects/proj-1/character"
      {...overrides}
    />,
  );
}

describe("buildCharacterLibraryHref", () => {
  it("always carries library=1 alongside q/page", () => {
    const href = buildCharacterLibraryHref("proj-1", "jane", 2);
    expect(href).toBe("/projects/proj-1/character?library=1&q=jane&page=2");
  });

  it("omits q when empty but still writes page and library", () => {
    const href = buildCharacterLibraryHref("proj-1", "", 1);
    expect(href).toBe("/projects/proj-1/character?library=1&page=1");
  });
});

describe("buildCharacterLibraryOpenHref", () => {
  it("opens the modal fresh, in peek mode", () => {
    expect(buildCharacterLibraryOpenHref("proj-1")).toBe("/projects/proj-1/character?library=1");
  });
});

describe("CharacterLibraryPanel — the search form keeps the modal open", () => {
  it("carries library=1 as a hidden field on the search form", () => {
    const { container } = renderPanel();
    const hidden = container.querySelector('input[name="library"]');
    expect(hidden).toBeTruthy();
    expect(hidden?.getAttribute("value")).toBe("1");
  });

  it("carries library=1 on the Clear link once a search is active", () => {
    renderPanel({ q: "jane" });
    const clearLink = screen.getByRole("link", { name: /clear/i });
    // Not buildCharacterLibraryHref(…, "", 1) — that always writes `page`,
    // which would flip browsing mode back on instead of resetting to the
    // peek. See the Clear link's own comment in character-library-panel.tsx.
    expect(clearLink.getAttribute("href")).toBe("/projects/proj-1/character?library=1");
  });

  it("carries library=1 on the Show all link", () => {
    renderPanel({ totalCount: 50, peekCount: 12, browsing: false });
    const showAll = screen.getByRole("link", { name: /show all/i });
    expect(showAll.getAttribute("href")).toBe("/projects/proj-1/character?library=1&page=1");
  });

  it("carries library=1 on both pagination links", () => {
    renderPanel({ browsing: true, requestedPage: 2, totalPages: 3, totalCount: 50 });
    const previous = screen.getByRole("link", { name: /previous/i });
    const next = screen.getByRole("link", { name: /next/i });
    expect(previous.getAttribute("href")).toBe("/projects/proj-1/character?library=1&page=1");
    expect(next.getAttribute("href")).toBe("/projects/proj-1/character?library=1&page=3");
  });
});

describe("CharacterLibraryPanel — grid content", () => {
  it("shows the in-use badge for the row matching sourceCharacterId", () => {
    renderPanel({ sourceCharacterId: "char-2" });
    expect(screen.getByText("In use")).toBeTruthy();
  });

  it("shows the no-description note when neither the row nor the project has one", () => {
    renderPanel({ sourceCharacterId: null, projectHasDescription: false });
    expect(screen.getByText(/no description/i)).toBeTruthy();
  });

  it("renders 'no matches' instead of a grid when the search comes back empty", () => {
    renderPanel({ characters: [], q: "zzz" });
    expect(screen.getByText(/no characters match/i)).toBeTruthy();
  });

  // The text this card is about to copy into the project is the only thing
  // the compiler reads. Picking on thumbnail and name alone imports it
  // unseen.
  it("shows each row's description snippet, not just its name", () => {
    renderPanel();
    expect(screen.getByText("A person")).toBeTruthy();
  });

  // Design note 9: the fastest read on which saved character actually works.
  it("shows how many projects each character is in use in", () => {
    renderPanel();
    expect(screen.getByText("in use in 4 projects")).toBeTruthy();
    // char-2 is absent from usageCounts, which reads as zero.
    expect(screen.getByText("not in use anywhere")).toBeTruthy();
  });

  it("offers a create card only to a viewer who may add library entries", () => {
    const { unmount } = renderPanel({ canCreate: false });
    expect(screen.queryByRole("link", { name: /new character/i })).toBeNull();
    unmount();

    renderPanel({ canCreate: true });
    expect(screen.getByRole("link", { name: /new character/i }).getAttribute("href")).toBe(
      "/library",
    );
  });
});

// A single stray click used to copy a library entry's photo AND description
// over this project's own — no confirm, no undo, in the densest and most
// mis-clickable layout on the screen. Clicking a card now only selects it.
describe("CharacterLibraryPanel — picking is select-then-confirm", () => {
  it("renders no per-card Use button; the only confirm is in the footer", () => {
    renderPanel();
    // One disabled Use in the footer, waiting for a selection — not one per
    // card (two cards are rendered).
    const useButtons = screen.getAllByRole("button", { name: /^use$/i });
    expect(useButtons.length).toBe(1);
    expect(useButtons[0]?.hasAttribute("disabled")).toBe(true);
  });

  it("names the character in the footer's overwrite warning only after one is picked", async () => {
    const user = userEvent.setup();
    renderPanel();

    expect(screen.getByText(/replaces this project's description and photo/i)).toBeTruthy();
    expect(screen.queryByText(/Jane's copy of each/)).toBeNull();

    await user.click(screen.getByRole("button", { name: /Jane/ }));

    expect(screen.getByText(/Jane's copy of each/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^use$/i }).hasAttribute("disabled")).toBe(false);
  });

  it("offers Cancel as a real control, not only the dialog's ✕", () => {
    renderPanel();
    expect(screen.getByRole("link", { name: /cancel/i }).getAttribute("href")).toBe(
      "/projects/proj-1/character",
    );
  });
});
