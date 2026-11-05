// @vitest-environment jsdom
//
// CLICKING A VERSION MAKES IT CURRENT.
//
// This file used to assert the opposite, and the change was a product
// decision rather than a bug fix: selecting was a navigation, promoting was a
// separate "Make current" button, and the split bought the ability to inspect
// an old take without promoting it. It cost two controls and a second click
// on the one thing an operator opens this rail to do, and the operator chose
// the second click back.
//
// So the invariant these tests defend has moved. What still has to hold is
// that the write is EXPLICIT and SCOPED: every tile is a form posting to
// setActiveVersion, which actions/ugc.test.ts pins as the only thing that
// writes active_version_id and which refuses a version belonging to another
// scene. The tile that is already current does not post at all — there is
// nothing for it to change, and a spinner on a no-op reads as work.
//
// The cost of the new rule is real and worth stating: comparing v3 then v2
// then v1 leaves v1 current. One click undoes it, and the rail says which is
// current at all times.

import type ReactDOM from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UgcVersionRail, type UgcVersion } from "./ugc-version-rail";

// Radix's DropdownMenu drives its trigger through the Pointer Events capture
// API, which jsdom doesn't implement — opening a tile's menu throws before any
// assertion runs without these stubs. Same block as projects-table.test.tsx.
for (const method of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"] as const) {
  if (!(method in Element.prototype)) {
    Object.defineProperty(Element.prototype, method, { value: () => false, writable: true });
  }
}
if (!("scrollIntoView" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "scrollIntoView", { value: () => {}, writable: true });
}

vi.mock("@/actions/ugc", () => ({
  setActiveVersion: vi.fn(async () => undefined),
  deleteClipVersion: vi.fn(async () => undefined),
}));

// useFormStatus only reports pending inside a real <form action={...}> submit
// in flight, which jsdom cannot drive from a unit test (same reasoning as
// pending-button.test.tsx) — so it is mocked to assert what the tile renders
// WHILE a submit is in flight, on demand, rather than only at rest.
// SubmitButton and FormPendingOverlay both read it, and both read the SAME
// mock, which is exactly the scenario under test: one tile's form pending.
const mockFormStatus = vi.fn(() => ({ pending: false }));
vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof ReactDOM>("react-dom");
  return { ...actual, useFormStatus: () => mockFormStatus() };
});

afterEach(() => {
  cleanup();
  mockFormStatus.mockReturnValue({ pending: false });
});

function aVersion(over: Partial<UgcVersion> & { id: string; n: number }): UgcVersion {
  return {
    createdAt: "2026-08-31T00:00:00.000Z",
    videoPrompt: "a prompt",
    refFrameAssetId: "asset-ref",
    clipAssetId: `clip-${over.id}`,
    renderSettings: null,
    durationS: 8,
    downloadUrl: `https://example.test/${over.id}.mp4`,
    filename: `${over.id}.mp4`,
    posterUrl: `https://example.test/${over.id}.jpg`,
    ...over,
  };
}

/** The tile for one version, found by its "vN" label. */
function tileFor(n: number): HTMLElement {
  const label = screen.getByText(`v${n}`);
  const tile = label.closest("div.relative.flex.flex-col.gap-0\\.5.rounded-md");
  if (!(tile instanceof HTMLElement)) throw new Error(`no tile found for v${n}`);
  return tile;
}

/**
 * The button that PROMOTES this version, as opposed to the menu trigger
 * beside it. Found by its form: the promote control is the only one that
 * posts, which is the property worth selecting on anyway.
 */
function promoteButtonIn(tile: HTMLElement): HTMLButtonElement {
  const button = tile.querySelector("form button");
  if (!(button instanceof HTMLButtonElement)) throw new Error("no promote button in the tile");
  return button;
}

const RAIL = {
  sceneId: "scene-1",
  sceneIdx: 2,
};

describe("UgcVersionRail promotes the version you click", () => {
  it("gives the promote button a height that can stretch to the whole tile", () => {
    // A CLASS ASSERTION, deliberately, and the only kind jsdom can make here:
    // it computes no layout, so nothing in this suite can measure that the hit
    // target actually covers the poster.
    //
    // It is worth having anyway because of how this broke. The button is
    // `absolute inset-0`, but Button's default size carries `h-9`, and CSS
    // ignores `bottom` when `top`, `height` and `bottom` are all set — so the
    // target silently became a 36px strip across the top of a ~180px tile,
    // exactly where the chevron menu already sits. Clicking a version's poster
    // did nothing, and every other test here still passed: they query the
    // button by role and press it directly, which no operator can do.
    render(
      <UgcVersionRail
        {...RAIL}
        versions={[aVersion({ id: "v1", n: 1 }), aVersion({ id: "v2", n: 2 })]}
        activeVersionId="v2"
        selectedVersionId={null}
      />,
    );

    const promote = promoteButtonIn(tileFor(1));
    expect(promote.className, "absolute inset-0 cannot stretch against an inherited h-9").toContain(
      "h-auto",
    );
  });

  it("makes every superseded tile a control, and the current one inert", async () => {
    render(
      <UgcVersionRail
        {...RAIL}
        versions={[aVersion({ id: "v1", n: 1 }), aVersion({ id: "v2", n: 2 })]}
        activeVersionId="v2"
        selectedVersionId="v1"
      />,
    );

    const superseded = promoteButtonIn(tileFor(1));
    expect(superseded.hasAttribute("disabled"), "a superseded take cannot be promoted").toBe(false);

    const standing = promoteButtonIn(tileFor(2));
    expect(
      standing.hasAttribute("disabled"),
      "the current version's tile still posts — a spinner on a no-op reads as work",
    ).toBe(true);
  });

  // THE CURRENT VERSION MUST NOT BE THE FADED ONE.
  //
  // Button's base carries `disabled:opacity-50`, and this tile is disabled
  // exactly when it is current — so the take the operator is actually using
  // rendered as the greyed-out one, which reads as "unavailable". A read-only
  // viewer got it on every tile, on the screen whose only purpose for them is
  // looking at those posters.
  //
  // Asserted on the class rather than a computed style because jsdom does not
  // apply Tailwind: the utility being present IS the mechanism, and its
  // absence is the bug.
  it("does not dim the current version, which is the one being used", () => {
    render(
      <UgcVersionRail
        {...RAIL}
        versions={[aVersion({ id: "v1", n: 1 })]}
        activeVersionId="v1"
        selectedVersionId="v1"
      />,
    );

    const standing = promoteButtonIn(tileFor(1));
    expect(standing.hasAttribute("disabled"), "the current tile must still not post").toBe(true);
    expect(
      standing.className,
      "the version in use is rendered at half opacity — it reads as unavailable",
    ).toContain("disabled:opacity-100");
  });

  it("posts the version and the scene, and nothing else", async () => {
    // setActiveVersion refuses a version from another scene, and it can only
    // do that if the scene travels with it. Both ids are hidden fields on the
    // tile's own form.
    render(
      <UgcVersionRail
        {...RAIL}
        versions={[aVersion({ id: "v1", n: 1 }), aVersion({ id: "v2", n: 2 })]}
        activeVersionId="v2"
        selectedVersionId={null}
      />,
    );

    const form = promoteButtonIn(tileFor(1)).closest("form");
    expect(form, "the tile is not a form — clicking it writes nothing").not.toBeNull();

    const fields = new Map(
      Array.from(form?.querySelectorAll("input[type=hidden]") ?? []).map((i) => [
        i.getAttribute("name"),
        i.getAttribute("value"),
      ]),
    );
    expect(fields.get("versionId")).toBe("v1");
    expect(fields.get("sceneId")).toBe("scene-1");
  });

  it("no longer carries a separate Make current button", () => {
    // Removed at the operator's request. Asserted rather than assumed, so a
    // future re-add is a decision instead of a drift back.
    render(
      <UgcVersionRail
        {...RAIL}
        versions={[aVersion({ id: "v1", n: 1 }), aVersion({ id: "v2", n: 2 })]}
        activeVersionId="v2"
        selectedVersionId={null}
      />,
    );

    expect(screen.queryByRole("button", { name: /make current/i })).toBeNull();
  });

  it("labels exactly one version current, and the rest superseded", () => {
    render(
      <UgcVersionRail
        {...RAIL}
        versions={[
          aVersion({ id: "v1", n: 1 }),
          aVersion({ id: "v2", n: 2 }),
          aVersion({ id: "v3", n: 3 }),
        ]}
        activeVersionId="v2"
        selectedVersionId="v3"
      />,
    );

    expect(screen.getAllByText("current")).toHaveLength(1);
    expect(within(tileFor(2)).getByText("current")).toBeTruthy();
    expect(within(tileFor(1)).getByText("superseded")).toBeTruthy();
    expect(within(tileFor(3)).getByText("superseded")).toBeTruthy();
  });

  it("puts the newest attempt first, whatever order it was given", () => {
    // The attempt just paid for should not need a scroll to find.
    render(
      <UgcVersionRail
        {...RAIL}
        versions={[
          aVersion({ id: "v2", n: 2 }),
          aVersion({ id: "v5", n: 5 }),
          aVersion({ id: "v1", n: 1 }),
        ]}
        activeVersionId="v5"
        selectedVersionId={null}
      />,
    );

    const shown = screen.getAllByText(/^v\d+$/).map((el) => el.textContent);
    expect(shown).toEqual(["v5", "v2", "v1"]);
  });
});

describe("UgcVersionRail reports what it does not know", () => {
  it("shows a version with no recorded duration as 'not recorded'", () => {
    // 0059's whole reason for existing: a pre-snapshot version must NOT be
    // filled in from the scene's current settings. Showing 8s here because
    // the scene is set to 8s today would state, as fact, a duration nobody
    // was billed for.
    render(
      <UgcVersionRail
        {...RAIL}
        versions={[aVersion({ id: "v1", n: 1, durationS: null })]}
        activeVersionId="v1"
        selectedVersionId={null}
      />,
    );

    expect(within(tileFor(1)).getByText("not recorded")).toBeTruthy();
    expect(screen.queryByText(/^\d+s$/), "an unrecorded duration was filled in").toBeNull();
  });

  it("shows a version that never produced a clip, with nothing to download", async () => {
    // Download moved into the tile's menu, and Radix renders no items until
    // the menu opens — so the assertion opens each one. Two claims, one per
    // version: v1 says "no clip" on its face and offers no Download inside;
    // v2 has a clip and offers one.
    const user = userEvent.setup();
    render(
      <UgcVersionRail
        {...RAIL}
        versions={[
          aVersion({ id: "v1", n: 1, clipAssetId: null, downloadUrl: null, filename: null }),
          aVersion({ id: "v2", n: 2 }),
        ]}
        activeVersionId="v2"
        selectedVersionId={null}
      />,
    );

    expect(within(tileFor(1)).getByText("no clip")).toBeTruthy();

    await user.click(screen.getByLabelText("Actions for v1"));
    expect(
      screen.queryByRole("menuitem", { name: /download/i }),
      "a version with no clip offered a download",
    ).toBeNull();
    await user.keyboard("{Escape}");

    await user.click(screen.getByLabelText("Actions for v2"));
    expect(screen.getByRole("menuitem", { name: /download/i })).toBeTruthy();
  });

  // A render in flight has no clip yet, and "no clip" is what this rail says
  // about an attempt that finished and produced nothing. Seen live: v2 was
  // rendering and its tile read "no clip", telling the operator their render
  // had come back empty while it was still being made.
  it("calls the attempt being rendered rendering, not 'no clip'", () => {
    render(
      <UgcVersionRail
        {...RAIL}
        versions={[
          aVersion({ id: "v1", n: 1 }),
          aVersion({ id: "v2", n: 2, clipAssetId: null, downloadUrl: null, filename: null }),
        ]}
        activeVersionId="v1"
        selectedVersionId="v1"
        workingVersionId="v2"
      />,
    );

    expect(within(tileFor(2)).getByText("rendering")).toBeTruthy();
    expect(within(tileFor(2)).queryByText("no clip")).toBeNull();
    // The take standing while it renders is still the current one.
    expect(within(tileFor(1)).getByText("current")).toBeTruthy();
  });

  it("distinguishes queued from rendering on that same tile", () => {
    render(
      <UgcVersionRail
        {...RAIL}
        versions={[
          aVersion({ id: "v2", n: 2, clipAssetId: null, downloadUrl: null, filename: null }),
        ]}
        activeVersionId={null}
        selectedVersionId={null}
        workingVersionId="v2"
        workingIsQueued
      />,
    );

    expect(within(tileFor(2)).getByText("queued")).toBeTruthy();
  });

  it("says nothing has been rendered rather than showing an empty rail", () => {
    render(
      <UgcVersionRail
        {...RAIL}
        sceneId={null}
        sceneIdx={null}
        versions={[]}
        activeVersionId={null}
        selectedVersionId={null}
      />,
    );

    expect(screen.getByText(/each render of a scene adds a version here/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /make current/i })).toBeNull();
  });
});

describe("UgcVersionRail's pending tile keeps its poster", () => {
  // The bug this guards: SubmitButton's own pending state replaces its
  // children wholesale with a spinner and a short label, which used to BE
  // this tile's children — so pressing a version swapped its poster for a
  // small ring and the word "Setting" where the picture had been. A
  // regression back to that shape fails this the same way it would fail an
  // operator: the poster and the label are gone.
  it("keeps the poster and the label visible while its own version is pending", () => {
    mockFormStatus.mockReturnValue({ pending: true });
    render(
      <UgcVersionRail
        {...RAIL}
        versions={[aVersion({ id: "v1", n: 1 }), aVersion({ id: "v2", n: 2 })]}
        activeVersionId="v2"
        selectedVersionId={null}
      />,
    );

    const tile = tileFor(1);
    expect(
      tile.querySelector("img"),
      "the poster disappeared while the tile's own form was pending",
    ).not.toBeNull();
    expect(within(tile).getByText("v1")).toBeTruthy();
  });

  // Asserted on the role="status" announcement, not on "a spinner exists
  // somewhere in the tile". SubmitButton renders its OWN svg.animate-spin
  // whenever it is pending regardless of what mutes it visually —
  // [&_svg]:hidden is a CSS rule jsdom never applies — so a bare
  // `svg.animate-spin` query keeps passing even with FormPendingOverlay
  // deleted outright: it was a hardcoded pass wearing the shape of a test.
  // role="status" with this exact label is produced by FormPendingOverlay
  // alone — SubmitButton's own pending content is sr-only text with no
  // role — so this is the query that actually falls when the overlay goes.
  it("announces the pending tile via FormPendingOverlay, and disables its button", () => {
    mockFormStatus.mockReturnValue({ pending: true });
    render(
      <UgcVersionRail
        {...RAIL}
        versions={[aVersion({ id: "v1", n: 1 }), aVersion({ id: "v2", n: 2 })]}
        activeVersionId="v2"
        selectedVersionId={null}
      />,
    );

    const tile = tileFor(1);
    expect(within(tile).getByRole("status").textContent).toMatch(/setting v1 current/i);
    expect(promoteButtonIn(tile).hasAttribute("disabled")).toBe(true);
  });

  it("shows no spinner at rest", () => {
    render(
      <UgcVersionRail
        {...RAIL}
        versions={[aVersion({ id: "v1", n: 1 }), aVersion({ id: "v2", n: 2 })]}
        activeVersionId="v2"
        selectedVersionId={null}
      />,
    );

    expect(tileFor(1).querySelector("svg.animate-spin")).toBeNull();
  });
});

describe("UgcVersionRail tells current and selected apart", () => {
  // CURRENT (what the scene IS) and SELECTED (what `?v=` is looking at) are
  // two different facts about the same tile, and an operator needs both —
  // this fails if a future change collapses them into one look. See the
  // header note on why CURRENT had to get louder without a second ring.
  it("gives the current tile its own marker, distinct from the selected ring", () => {
    render(
      <UgcVersionRail
        {...RAIL}
        versions={[aVersion({ id: "v1", n: 1 }), aVersion({ id: "v2", n: 2 })]}
        activeVersionId="v2"
        selectedVersionId="v1"
      />,
    );

    const currentTile = tileFor(2);
    const selectedTile = tileFor(1);

    // Current: the Badge pill, not just a bare word — asserted via Badge's
    // own data-slot rather than a CSS colour, so this does not depend on
    // jsdom applying Tailwind.
    expect(within(currentTile).getByText("current").getAttribute("data-slot")).toBe("badge");
    expect(selectedTile.className).not.toContain("border-l-[3px]");

    // Selected: the ring, on the tile that is NOT current.
    expect(selectedTile.className).toContain("ring-2");
    expect(currentTile.className).not.toContain("ring-2");

    // Current is the one tile exempt from the dim every OTHER tile gets —
    // including this one, which is selected but not current, and still
    // recedes relative to it.
    expect(selectedTile.className).toContain("opacity-80");
    expect(currentTile.className).not.toContain("opacity-80");
  });

  it("dims a tile that is neither current nor selected", () => {
    render(
      <UgcVersionRail
        {...RAIL}
        versions={[
          aVersion({ id: "v1", n: 1 }),
          aVersion({ id: "v2", n: 2 }),
          aVersion({ id: "v3", n: 3 }),
        ]}
        activeVersionId="v2"
        selectedVersionId="v3"
      />,
    );

    expect(tileFor(1).className).toContain("opacity-80");
  });
});
