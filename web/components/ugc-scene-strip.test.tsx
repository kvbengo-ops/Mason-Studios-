// @vitest-environment jsdom
//
// The strip is the selector for the whole screen: three separate things react
// to `?scene=` — the column loads that scene's prompt, the result shows its
// current version, the rail lists its attempts. So the hrefs it builds are not
// cosmetic, and one of its structural rules is the kind a refactor breaks
// without any visible sign.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UgcSceneStrip, type UgcScene } from "./ugc-scene-strip";
import {
  __resetAllGeneratePendingForTests,
  beginGeneratePending,
  clearGeneratePending,
  resolveGeneratePending,
} from "@/lib/ugc-generate-pending-store";

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

afterEach(() => {
  cleanup();
  // The pending store is a module singleton (lib/ugc-generate-pending-
  // store.ts's own doc comment on why) — it survives across `it()` blocks in
  // this file, so a test that begins one must not leak it into the next.
  __resetAllGeneratePendingForTests();
});

function aScene(over: Partial<UgcScene> & { id: string; idx: number }): UgcScene {
  return {
    duration_s: 8,
    status: "done",
    versionCount: 1,
    downloadUrl: `https://example.test/${over.id}.mp4`,
    filename: `${over.id}.mp4`,
    posterUrl: `https://example.test/${over.id}.jpg`,
    usdBilled: 2.52,
    ...over,
  };
}

/** The anchor that SELECTS a scene, found by href — its text is not stable. */
function selectingLinkFor(sceneId: string): HTMLAnchorElement {
  const link = Array.from(document.querySelectorAll("a")).find((a) =>
    (a.getAttribute("href") ?? "").includes(`?scene=${sceneId}`),
  );
  if (!link) throw new Error(`no selecting link found for ${sceneId}`);
  return link;
}

describe("UgcSceneStrip takes", () => {
  it("shows every take of a regenerated scene as its own tile, selected by version", () => {
    render(
      <UgcSceneStrip
        projectId="proj-1"
        scenes={[
          aScene({ id: "scene-1", idx: 1, versionId: "ver-b", take: 2, isCurrentTake: true }),
          aScene({ id: "scene-1", idx: 1, versionId: "ver-a", take: 1 }),
        ]}
        selectedSceneId="scene-1"
        selectedVersionId="ver-a"
      />,
    );

    const hrefs = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"))
      .filter((href) => href?.includes("?scene=scene-1"));
    // Oldest take first, each linking to its own version.
    expect(hrefs).toEqual([
      "/ugc/proj-1?scene=scene-1&v=ver-a",
      "/ugc/proj-1?scene=scene-1&v=ver-b",
    ]);
    expect(screen.getByText("v1")).toBeTruthy();
    expect(screen.getByText("v2")).toBeTruthy();
    // Only the take named by ?v= carries the selection.
    const selected = screen
      .getAllByRole("link")
      .filter((l) => l.getAttribute("aria-current") === "true");
    expect(selected.map((l) => l.getAttribute("href"))).toEqual([
      "/ugc/proj-1?scene=scene-1&v=ver-a",
    ]);
  });
});

describe("UgcSceneStrip", () => {
  it("totals billed dollars once per scene across takes", () => {
    render(
      <UgcSceneStrip
        projectId="proj-1"
        scenes={[
          aScene({ id: "scene-1", idx: 1, usdBilled: 2.52 }),
          aScene({ id: "scene-1", idx: 1, versionId: "ver-2", take: 2, usdBilled: 2.52 }),
          aScene({ id: "scene-2", idx: 2, usdBilled: 1.08 }),
          aScene({ id: "scene-3", idx: 3, usdBilled: null }),
        ]}
        selectedSceneId={null}
      />,
    );

    expect(screen.getByText(/\$3\.60 billed/i)).toBeTruthy();
  });

  it("keeps the action menu a SIBLING of the selecting link, never inside it", () => {
    // An anchor nested inside another anchor is invalid HTML, and browsers
    // resolve it by making one of the two clicks unreliable — so an operator
    // pressing Download would sometimes just select the scene instead, or
    // vice versa. Nothing about that shows up on screen, which is why it is
    // asserted structurally rather than left to the comment that explains it.
    render(
      <UgcSceneStrip
        projectId="proj-1"
        scenes={[aScene({ id: "scene-1", idx: 1 })]}
        selectedSceneId={null}
      />,
    );

    const menu = screen.getByLabelText("Actions for scene 1");
    const selecting = selectingLinkFor("scene-1");

    expect(selecting.getAttribute("href")).toBe("/ugc/proj-1?scene=scene-1");
    expect(
      selecting.contains(menu),
      "the action menu is nested inside the selecting link — a button inside an anchor is invalid HTML, and one of the two clicks becomes unreliable",
    ).toBe(false);
  });

  it("makes New scene a DESELECT, not a new row", () => {
    // A scene only exists once something has been rendered, so "new" is the
    // absence of a selection. A New scene link that carried a ?scene= would
    // be selecting something instead of clearing.
    render(
      <UgcSceneStrip
        projectId="proj-1"
        scenes={[aScene({ id: "scene-1", idx: 1 })]}
        selectedSceneId="scene-1"
      />,
    );

    const newScene = screen.getByRole("link", { name: /new scene/i });
    expect(newScene.getAttribute("href")).toBe("/ugc/proj-1");
  });

  it("rings New scene when nothing is selected, and the tile when something is", () => {
    const { rerender } = render(
      <UgcSceneStrip
        projectId="proj-1"
        scenes={[aScene({ id: "scene-1", idx: 1 })]}
        selectedSceneId={null}
      />,
    );

    expect(screen.getByRole("link", { name: /new scene/i }).className).toContain("ring-2");
    expect(selectingLinkFor("scene-1").getAttribute("aria-current")).toBeNull();

    rerender(
      <UgcSceneStrip
        projectId="proj-1"
        scenes={[aScene({ id: "scene-1", idx: 1 })]}
        selectedSceneId="scene-1"
      />,
    );

    expect(screen.getByRole("link", { name: /new scene/i }).className).not.toContain("ring-2");
    expect(selectingLinkFor("scene-1").getAttribute("aria-current")).toBe("true");
  });

  it("puts New scene first, then scenes oldest to newest", () => {
    // Given newest-first, as the page reads them.
    render(
      <UgcSceneStrip
        projectId="proj-1"
        scenes={[
          aScene({ id: "scene-3", idx: 3 }),
          aScene({ id: "scene-2", idx: 2 }),
          aScene({ id: "scene-1", idx: 1 }),
        ]}
        selectedSceneId={null}
      />,
    );

    const links = screen.getAllByRole("link");
    expect(links[0]?.textContent).toMatch(/new scene/i);
    expect(links.slice(1).map((link) => link.getAttribute("href"))).toEqual([
      "/ugc/proj-1?scene=scene-1",
      "/ugc/proj-1?scene=scene-2",
      "/ugc/proj-1?scene=scene-3",
    ]);
  });
});

describe("UgcSceneStrip", () => {
  it("offers no download for a scene with no clip, and refuses to delete one mid-render", async () => {
    // The menu itself is always present now — a scene with no clip can still
    // be deleted, which is most of why an operator wants the menu on a failed
    // render. What must not appear is a Download for bytes that do not exist.
    //
    // Radix renders no items until the menu is opened, so this opens it. That
    // also covers the one state where deleting is refused: a render in flight
    // is the worker's row, and deleting it mid-flight leaves a submitted job
    // whose result arrives to nothing.
    const user = userEvent.setup();
    render(
      <UgcSceneStrip
        projectId="proj-1"
        scenes={[
          aScene({
            id: "scene-1",
            idx: 1,
            status: "rendering",
            downloadUrl: null,
            filename: null,
            usdBilled: null,
          }),
        ]}
        selectedSceneId={null}
      />,
    );

    await user.click(screen.getByLabelText("Actions for scene 1"));

    expect(
      screen.queryByRole("menuitem", { name: /download/i }),
      "a scene with no clip offered a download",
    ).toBeNull();

    const refused = screen.getByRole("menuitem", { name: /still rendering/i });
    expect(
      refused.getAttribute("aria-disabled"),
      "a rendering scene offered a delete the action would refuse",
    ).toBe("true");
  });

  // F4: 0088_deleted_scenes.sql (and this project's own "Recently deleted"
  // section, ugc-deleted-scenes.tsx) made a deleted scene restorable — the
  // confirm's own wording used to say the opposite.
  it("tells the operator the deleted scene can be restored, not that the delete is permanent", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <UgcSceneStrip
        projectId="proj-1"
        scenes={[aScene({ id: "scene-1", idx: 1 })]}
        selectedSceneId={null}
      />,
    );

    await user.click(screen.getByLabelText("Actions for scene 1"));
    await user.click(await screen.findByRole("menuitem", { name: /^delete$/i }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const message = confirmSpy.mock.calls[0]?.[0] as string;
    expect(message, "still says which scene and that every version goes with it").toMatch(
      /delete scene 1\? every version of this clip goes with it/i,
    );
    expect(
      message,
      "claims the delete is permanent in the same commit that made it undoable via Recently deleted",
    ).not.toMatch(/cannot be undone/i);
    expect(message, "does not say how to get the scene back").toMatch(/restore.*recently deleted/i);
    confirmSpy.mockRestore();
  });

  it("says what it is for when the project has no scenes, rather than vanishing", () => {
    // It used to return null. A new project then showed nothing at all where
    // the strip belongs, and the first person to see it asked where it had
    // gone — the operator is left deciding whether the page is broken.
    //
    // The Versions rail beside it has always explained itself when empty, so
    // the two were inconsistent and the disappearing one was wrong.
    render(<UgcSceneStrip projectId="proj-1" scenes={[]} selectedSceneId={null} />);

    expect(screen.getByText(/every clip you generate appears here/i)).toBeTruthy();
    expect(
      screen.queryByLabelText(/^Actions for scene/),
      "an empty strip offered a menu for a scene that does not exist",
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// EVERY TILE IN THE STRIP ANSWERS A PRESS, INCLUDING THE LAST ONE.
//
// "New scene" is a <Link> to the same expensive Server Component as the scene
// tiles — deselecting rebuilds the whole page — and it was left out when they
// were given a pending spinner and a prefetch. A control that behaves like its
// neighbours must answer like them, and this one stayed silent.
//
// useLinkStatus is mocked as pending because outside a real navigation it
// reports false, so without this the assertion would pass on a strip that
// shows nothing at all.
// ---------------------------------------------------------------------------
describe("the strip says which tile was pressed", () => {
  it("shows a spinner on every tile, New scene included", async () => {
    vi.doMock("next/link", async () => {
      const actual = await vi.importActual("next/link");
      return { ...actual, useLinkStatus: () => ({ pending: true }) };
    });
    vi.resetModules();
    const { UgcSceneStrip: Strip } = await import("./ugc-scene-strip");

    const { container } = render(
      <Strip projectId="proj-1" scenes={[aScene({ id: "s1", idx: 1 })]} selectedSceneId={null} />,
    );

    // One per scene tile, plus one on New scene.
    expect(
      container.querySelectorAll("svg.animate-spin").length,
      "a tile was pressed and shows nothing — New scene is the one that was missed",
    ).toBe(2);

    vi.doUnmock("next/link");
    vi.resetModules();
  });

  it("prefetches New scene, which costs the same server work as any other tile", () => {
    // A non-empty strip: with no scenes at all the component renders its own
    // empty state and there is no tile row to end with.
    render(
      <UgcSceneStrip
        projectId="proj-1"
        scenes={[aScene({ id: "s1", idx: 1 })]}
        selectedSceneId={null}
      />,
    );

    // Next strips `prefetch` from the DOM, so the observable is that the link
    // exists and is not opted out. The regression worth catching is the tile
    // being dropped from the strip entirely.
    const newScene = screen.getByRole("link", { name: /new scene/i });
    expect(newScene.getAttribute("href")).toBe("/ugc/proj-1");
  });
});

// ---------------------------------------------------------------------------
// THE PLACEHOLDER TILE — generateClip takes 4-5s on a real project (~15
// sequential reads before the scene insert, then attachSceneReferences
// copying each reference one at a time), and the strip used to sit
// perfectly still for the whole wait. These pin what the store-backed
// placeholder (ugc-pending-scene-tile.tsx) does with that time: appears the
// instant something is pending, carries the next scene number and the
// project's own spinner, and steps aside only once the real tile is
// actually in the list — never before, so there is no gap between the two.
// ---------------------------------------------------------------------------
describe("the placeholder tile stands in while Generate is in flight", () => {
  it("renders nothing when nothing is pending", () => {
    render(<UgcSceneStrip projectId="proj-1" scenes={[]} selectedSceneId={null} />);

    expect(screen.queryByText("Queued")).toBeNull();
  });

  it("appears the instant a generate begins, with the next scene number and a spinner", () => {
    render(
      <UgcSceneStrip
        projectId="proj-1"
        scenes={[aScene({ id: "scene-1", idx: 1 })]}
        selectedSceneId={null}
      />,
    );
    expect(screen.queryByText("Queued")).toBeNull();

    act(() => {
      beginGeneratePending("proj-1");
    });

    expect(screen.getByText("Queued")).toBeTruthy();
    // One past the highest idx already in the strip.
    expect(screen.getByText("2")).toBeTruthy();
    const spinner = document.querySelector("svg.animate-spin");
    expect(spinner, "no spinner on the placeholder tile").toBeTruthy();
  });

  it("shows the placeholder even on a brand-new project with zero scenes", () => {
    // The very first Generate a project ever sees is exactly the case this
    // exists for — the strip used to render only an explanatory paragraph
    // here, with no tile row for a placeholder to join.
    render(<UgcSceneStrip projectId="proj-1" scenes={[]} selectedSceneId={null} />);

    act(() => {
      beginGeneratePending("proj-1");
    });

    expect(screen.getByText("Queued")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("keeps showing the placeholder once the scene id is known, until the real tile actually lists it", () => {
    const { rerender } = render(
      <UgcSceneStrip projectId="proj-1" scenes={[]} selectedSceneId={null} />,
    );

    act(() => {
      beginGeneratePending("proj-1");
      resolveGeneratePending("proj-1", "scene-new");
    });
    expect(
      screen.getByText("Queued"),
      "hid before the strip's own scene list ever mentioned the new id — that is the gap this tile exists to close",
    ).toBeTruthy();

    // The server round-trip lands: the strip re-renders with the real scene
    // now in its list.
    rerender(
      <UgcSceneStrip
        projectId="proj-1"
        scenes={[aScene({ id: "scene-new", idx: 1 })]}
        selectedSceneId={null}
      />,
    );

    expect(screen.queryByText("Queued")).toBeNull();
  });

  it("clears immediately on an error, rather than sitting there until the safety timeout", () => {
    render(<UgcSceneStrip projectId="proj-1" scenes={[]} selectedSceneId={null} />);

    act(() => {
      beginGeneratePending("proj-1");
    });
    expect(screen.getByText("Queued")).toBeTruthy();

    act(() => {
      clearGeneratePending("proj-1");
    });

    expect(screen.queryByText("Queued")).toBeNull();
  });

  it("is scoped to its own project — a pending press on another project's strip does not show here", () => {
    render(<UgcSceneStrip projectId="proj-1" scenes={[]} selectedSceneId={null} />);

    act(() => {
      beginGeneratePending("some-other-project");
    });

    expect(screen.queryByText("Queued")).toBeNull();
  });
});

describe("organising the strip (0142)", () => {
  it("orders by the dragged position, keeps each scene's number, and shows its name", () => {
    render(
      <UgcSceneStrip
        projectId="proj-1"
        scenes={[
          aScene({ id: "scene-3", idx: 3, position: 1, title: "Hook" }),
          aScene({ id: "scene-2", idx: 2 }),
          aScene({ id: "scene-1", idx: 1, position: 3, commentCount: 2 }),
        ]}
        selectedSceneId={null}
      />,
    );

    // scene 3 was dragged to the top; scene 1 to the bottom. Numbers unchanged.
    expect(
      screen
        .getAllByRole("link")
        .slice(1)
        .map((link) => link.getAttribute("href")),
    ).toEqual([
      "/ugc/proj-1?scene=scene-3",
      "/ugc/proj-1?scene=scene-2",
      "/ugc/proj-1?scene=scene-1",
    ]);
    expect(screen.getAllByTitle("Rename scene")[0]?.textContent).toBe("Hook");
    expect(screen.getByLabelText("2 comments")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Drag scene 3 to reorder" })).toBeTruthy();
  });

  it("offers a read-only viewer no grip and no rename", () => {
    render(
      <UgcSceneStrip
        projectId="proj-1"
        scenes={[
          aScene({ id: "scene-2", idx: 2, title: "Hook" }),
          aScene({ id: "scene-1", idx: 1 }),
        ]}
        selectedSceneId={null}
        readOnly
      />,
    );

    expect(screen.queryByRole("button", { name: /reorder/i })).toBeNull();
    expect(screen.queryByTitle("Rename scene")).toBeNull();
    expect(screen.getByText("Hook")).toBeTruthy();
  });
});
