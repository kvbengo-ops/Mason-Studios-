// @vitest-environment jsdom
//
// Design notes 5 and 6 on the Character screen, pinned where they can
// actually fail: the moment the description changes, the PORTRAIT is what
// gets flagged — dimmed, outlined, and labelled on the card — with the
// regenerate control in that same card, and the app never spends on its own.
// The old shape (a banner in the description block below the photo, saying
// "the portrait below…") would pass any test that only asked "is there a
// staleness message somewhere", which is why these assert the treatment is
// on the image and the card, not merely present.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { CharacterPortraitCard } from "./character-portrait-card";

afterEach(() => {
  cleanup();
});

function renderCard(
  overrides: Partial<ComponentProps<typeof CharacterPortraitCard>> = {},
): ReturnType<typeof render> {
  return render(
    <CharacterPortraitCard
      imageUrl="https://example.com/face.jpg"
      stale={false}
      admin={true}
      fieldsLocked={false}
      regenerateDisabled={false}
      costLabel="$0.04"
      libraryCharacterName={null}
      removeDescription="regenerating it costs $0.04 again."
      removeAction={vi.fn(async () => undefined)}
      regenerateAction={vi.fn(async () => undefined)}
      {...overrides}
    />,
  );
}

describe("CharacterPortraitCard — the stale flag is on the picture", () => {
  it("dims the image and outlines the card when the description has moved on", () => {
    const { container } = renderCard({ stale: true });

    const image = screen.getByAltText("Character reference");
    expect(image.className).toContain("opacity-50");
    expect(container.querySelector(".border-warning")).toBeTruthy();
    expect(screen.getByText(/stale/i)).toBeTruthy();
  });

  it("says nothing and dims nothing while the photo still matches the text", () => {
    const { container } = renderCard({ stale: false });

    const image = screen.getByAltText("Character reference");
    expect(image.className).not.toContain("opacity-50");
    expect(container.querySelector(".border-warning")).toBeNull();
    expect(screen.queryByText(/stale/i)).toBeNull();
  });

  it("puts the priced regenerate control in the same card as the flag", () => {
    renderCard({ stale: true });

    const flag = screen.getByText(/stale/i);
    const regenerate = screen.getByRole("button", { name: /regenerate \(\$0\.04\)/i });
    // Same card, not a warning in one block and the control in another.
    expect(flag.parentElement?.contains(regenerate)).toBe(true);
  });
});

// Design note 6: the app says it is stale and YOU decide whether to spend.
// A viewer who cannot spend must still be told, and told who can — being
// shown a problem with no route to acting on it is the failure here.
describe("CharacterPortraitCard — a non-admin is told, and told who can act", () => {
  it("still flags the stale photo without offering a button that would be refused", () => {
    renderCard({ stale: true, admin: false });

    expect(screen.getByText(/stale/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /regenerate/i })).toBeNull();
    expect(screen.getByText(/ask an admin to bring it back in line/i)).toBeTruthy();
  });
});
