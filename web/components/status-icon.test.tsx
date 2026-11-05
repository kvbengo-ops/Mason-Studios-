// @vitest-environment jsdom
//
// jsdom, not the suite default (see vitest.config.ts) — this renders lucide
// icons, which need a real DOM. Same reasoning as project-rail.test.tsx.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Settings } from "lucide-react";
import { StatusIcon } from "./status-icon";

afterEach(() => {
  cleanup();
});

describe("StatusIcon", () => {
  it("names every state for assistive tech", () => {
    const { container } = render(<StatusIcon status="rendering" />);
    expect(container.querySelector('[aria-label="Rendering"]')).toBeTruthy();
  });

  it("hides the visible word when asked, without dropping the accessible name", () => {
    // components/project-rail.tsx renders this with showLabel={false} because
    // every rail row already carries its own label. The accessible name must
    // survive that — it comes from aria-label, never from the visible span,
    // which is aria-hidden precisely so the two cannot compete.
    const { container } = render(<StatusIcon status="done" showLabel={false} />);
    expect(container.textContent).toBe("");
    expect(container.querySelector('[aria-label="Done"]')).toBeTruthy();
  });
});

// The filled badge has to be composed, not styled. Handing lucide's
// CircleCheck a `fill` fills the circle AND the check path inside it — both
// are children of one svg — so the tick disappears into a solid dot. That
// shipped. These pin that the glyph is a separate element from the disc.
describe("StatusIcon, filled", () => {
  it("keeps the check visible inside the disc for a done scene", () => {
    const { container } = render(<StatusIcon status="done" filled showLabel={false} />);
    const disc = container.querySelector(".bg-current");
    expect(disc).toBeTruthy();
    // The glyph is its own child painted in the surface colour — not the disc
    // with a fill applied to the whole icon.
    expect(disc!.querySelector(".text-background")).toBeTruthy();
  });

  it("does the same for a failed scene", () => {
    const { container } = render(<StatusIcon status="failed" filled showLabel={false} />);
    expect(container.querySelector(".bg-current .text-background")).toBeTruthy();
  });

  // DONE IS FILLED EVERYWHERE NOW, prop or no prop.
  //
  // This test used to assert the opposite — that an unprompted `done` kept
  // the outline, with only project-rail opting in. That was right until Done
  // started appearing on top of a poster in the /ugc strip and the version
  // rail, where a 2px --success outline over a photograph is a shape you have
  // to hunt for. Done is the only glyph in this set that ever sits on an
  // arbitrary image, because it is the only one that appears once a clip
  // exists.
  it("fills a done glyph without being asked, because it lands on a poster", () => {
    const { container } = render(<StatusIcon status="done" showLabel={false} />);
    expect(
      container.querySelector(".bg-current .text-background"),
      "a done tick over a poster has to be a disc, not an outline",
    ).toBeTruthy();
  });

  // The blast radius, pinned. Filling `done` says nothing about `failed`: a
  // solid red disc is a louder decision than a solid green one, and nobody
  // asked for it. It stays on the prop, so project-rail keeps the matched
  // pair it opted into and every other caller keeps a quiet X.
  it("still leaves failed on the prop, so nothing else turned into a red disc", () => {
    const { container } = render(<StatusIcon status="failed" showLabel={false} />);
    expect(
      container.querySelector(".bg-current"),
      "failed was filled as a side effect of filling done",
    ).toBeNull();
  });
});

// components/project-rail.tsx swaps the Render settings row's tick for a gear
// while you are standing on that screen. The override is handed to this
// component rather than hand-rolled beside it so the aria-label/role decision
// stays in one place — which is the half that must survive the swap.
describe("StatusIcon, with a glyph override", () => {
  it("draws the given icon instead of the status shape", () => {
    const { container } = render(
      <StatusIcon status="done" filled showLabel={false} icon={Settings} />,
    );

    expect(container.querySelector("svg.lucide-settings")).toBeTruthy();
    // Not the filled check the same status draws without an override.
    expect(container.querySelector(".bg-current")).toBeNull();
  });

  it("still says the status word, so the row loses nothing to a screen reader", () => {
    const { container } = render(
      <StatusIcon status="done" filled showLabel={false} icon={Settings} />,
    );

    expect(container.querySelector('[aria-label="Done"]')).toBeTruthy();
  });
});
