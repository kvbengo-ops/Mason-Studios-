// @vitest-environment jsdom
//
// Covers the Deliver grid's own behaviour: the reorder controls (drag handle
// + keyboard added by dnd-kit, plus a move-left/move-right button pair), the
// re-assembly a reorder now triggers on its own, the Mark delivered gate, and
// the action row's two exports. "@/actions/deliver" is mocked for the same
// reason render-progress.test.tsx mocks "@/actions/enqueue" — the real module
// pulls in Supabase/next/headers machinery that throws outside a request.
// Real pointer-drag simulation (dnd-kit's PointerSensor reading
// getBoundingClientRect etc under jsdom) is heavy scaffolding for what the
// button path already exercises end to end — see the header note above the
// drag-specific describe block below for exactly what is and isn't covered
// there.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClipGrid, buildCutCsv, cutCsvFilename, type ClipGridClip } from "./clip-grid";
import { markDelivered, reassembleProject, reorderCut, type CutStatus } from "@/actions/deliver";
import type { ProjectStatus } from "@/types/db";

vi.mock("@/actions/deliver", () => ({
  getManifest: vi.fn(async () => ({})),
  markDelivered: vi.fn(async () => undefined),
  reopenProject: vi.fn(async () => ({ reopened: true })),
  reassembleProject: vi.fn(async () => undefined),
  reorderCut: vi.fn(async () => undefined),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// jsdom implements neither URL.createObjectURL nor a real anchor download, so
// the two export buttons need both stubbed: the first to capture what would
// have been written to disk, the second so a<download>.click() doesn't try to
// navigate.
const savedBlobs: Blob[] = [];

beforeEach(() => {
  savedBlobs.length = 0;
  URL.createObjectURL = vi.fn((obj: Blob | MediaSource) => {
    if (obj instanceof Blob) savedBlobs.push(obj);
    return "blob:clip-grid-test";
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(reorderCut).mockReset();
  vi.mocked(reorderCut).mockResolvedValue(undefined);
  vi.mocked(reassembleProject).mockReset();
  vi.mocked(reassembleProject).mockResolvedValue(undefined);
  vi.mocked(markDelivered).mockReset();
  vi.mocked(markDelivered).mockResolvedValue(undefined);
});

const CURRENT: CutStatus = { state: "current" };
const STALE: CutStatus = {
  state: "stale",
  reason: "order",
  finalCreatedAt: "2026-08-01T00:00:00.000Z",
  cutOrderUpdatedAt: "2026-08-02T00:00:00.000Z",
};

function clip(overrides: Partial<ClipGridClip> = {}): ClipGridClip {
  return {
    id: "scene-a",
    idx: 0,
    isTalkingHead: false,
    durationS: 6,
    videoUrl: "https://example.com/a.mp4",
    filename: "scene-01.mp4",
    ...overrides,
  };
}

function renderGrid(props: {
  clips: ClipGridClip[];
  sceneOrder: string[];
  allTerminal?: boolean;
  allScenesDone?: boolean;
  cutStatus?: CutStatus;
  readOnly?: boolean;
  initialStatus?: ProjectStatus;
  hasFinal?: boolean;
  finalUrl?: string | null;
}): ReturnType<typeof render> {
  return render(
    <ClipGrid
      projectId="project-1"
      projectTitle="My Project"
      clips={props.clips}
      hasFinal={props.hasFinal ?? false}
      buildInProgress={false}
      hasFinalVersion={props.hasFinal ?? false}
      finalUrl={props.finalUrl ?? null}
      initialStatus={props.initialStatus ?? "complete"}
      sceneOrder={props.sceneOrder}
      allTerminal={props.allTerminal ?? true}
      allScenesDone={props.allScenesDone ?? true}
      unfinishedSceneCount={props.allScenesDone === false ? 1 : 0}
      cutStatus={props.cutStatus ?? CURRENT}
      readOnly={props.readOnly ?? false}
    />,
  );
}

// Three clips (A, B, C) plus one failed scene (F) with no clip, sitting
// between A and B in the real scene order — exactly the shape the "failed
// scene's id must still be sent, in its existing relative position" rule
// exists for.
const A = clip({ id: "scene-a", idx: 0, durationS: 6, filename: "scene-01.mp4" });
const B = clip({
  id: "scene-b",
  idx: 1,
  isTalkingHead: true,
  durationS: 4,
  filename: "scene-02.mp4",
});
const C = clip({ id: "scene-c", idx: 2, durationS: 8, filename: "scene-03.mp4" });
const FULL_ORDER = ["scene-a", "scene-f", "scene-b", "scene-c"];

describe("ClipGrid — reorder via move buttons", () => {
  it("move-right on the first card calls reorderCut with the complete id list, failed scene included in place", async () => {
    const user = userEvent.setup();
    renderGrid({ clips: [A, B, C], sceneOrder: FULL_ORDER });

    const moveRight = screen.getByRole("button", { name: "Move Scene 1 later" });
    await user.click(moveRight);

    expect(reorderCut).toHaveBeenCalledTimes(1);
    // Visible order was [A, B, C]; moving A right one swaps it with B ->
    // [B, A, C]. Merged back into the full order (which keeps scene-f
    // exactly where it was, between the two clipped slots it sits between):
    // [B, F, A, C].
    expect(reorderCut).toHaveBeenCalledWith("project-1", [
      "scene-b",
      "scene-f",
      "scene-a",
      "scene-c",
    ]);
  });

  it("renumbers scene labels to match the new order", async () => {
    const user = userEvent.setup();
    renderGrid({ clips: [A, B, C], sceneOrder: FULL_ORDER });

    // getByText matches an element's own text nodes, so the sr-only
    // "Scene" word (a child element) is not part of these strings — the
    // visible text is exactly "1 · 6s".
    expect(screen.getByText("1 · 6s")).toBeTruthy();
    expect(screen.getByText("3 · 4s")).toBeTruthy();
    expect(screen.getByText("4 · 8s")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Move Scene 1 later" }));

    // A (was position 1, now behind the failed scene-f and B) reads as
    // Scene 3; B (now first) reads as Scene 1; C stays Scene 4. The duration
    // travels with the clip, not with the slot.
    expect(screen.getByText("1 · 4s")).toBeTruthy();
    expect(screen.getByText("3 · 6s")).toBeTruthy();
    expect(screen.getByText("4 · 8s")).toBeTruthy();
  });

  it("reverts the optimistic order and surfaces the error message when reorderCut fails", async () => {
    const { toast } = await import("sonner");
    vi.mocked(reorderCut).mockResolvedValue({ error: 'Scene scene-b is still "rendering".' });
    const user = userEvent.setup();
    renderGrid({ clips: [A, B, C], sceneOrder: FULL_ORDER });

    await user.click(screen.getByRole("button", { name: "Move Scene 1 later" }));

    expect(toast.error).toHaveBeenCalledWith('Scene scene-b is still "rendering".');
    // Reverted: Scene 1 is still A's card (move-right button still targets
    // "Move Scene 1 later", not "Move Scene 3 later" as it would if the
    // optimistic reorder had stuck).
    expect(screen.getByRole("button", { name: "Move Scene 1 later" })).toBeTruthy();
  });
});

// The mockup's rail lists final assembly as something that happens on the
// Final video step by itself; reordering is presented as the whole gesture.
// Before this, a reorder left the mp4 in the old order until the operator
// noticed a warning banner and clicked Assemble.
describe("ClipGrid — a reorder rebuilds the assembled video by itself", () => {
  it("re-assembles the cut after a successful reorder, with no second click", async () => {
    const user = userEvent.setup();
    renderGrid({ clips: [A, B], sceneOrder: ["scene-a", "scene-b"], hasFinal: true });

    await user.click(screen.getByRole("button", { name: "Move Scene 1 later" }));

    await waitFor(() => expect(reassembleProject).toHaveBeenCalledWith("project-1", "new"));
    // Order first, rebuild second — reassembleProject records the recipe from
    // scenes.idx as it stands when it runs, so a rebuild that ran first would
    // record and build the OLD order.
    expect(vi.mocked(reorderCut).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(reassembleProject).mock.invocationCallOrder[0]!,
    );
  });

  it("does not re-assemble when the reorder itself was refused", async () => {
    vi.mocked(reorderCut).mockResolvedValue({ error: "This project has already been delivered" });
    const user = userEvent.setup();
    renderGrid({ clips: [A, B], sceneOrder: ["scene-a", "scene-b"], hasFinal: true });

    await user.click(screen.getByRole("button", { name: "Move Scene 1 later" }));

    expect(reorderCut).toHaveBeenCalledTimes(1);
    expect(reassembleProject).not.toHaveBeenCalled();
  });

  it("does not re-assemble when there is no assembled video yet", async () => {
    const user = userEvent.setup();
    renderGrid({ clips: [A, B], sceneOrder: ["scene-a", "scene-b"], hasFinal: false });

    await user.click(screen.getByRole("button", { name: "Move Scene 1 later" }));

    expect(reorderCut).toHaveBeenCalledTimes(1);
    expect(reassembleProject).not.toHaveBeenCalled();
  });
});

describe("ClipGrid — stale cut notice", () => {
  it("shows the notice and Assemble button only when cutStatus is 'stale'", () => {
    renderGrid({ clips: [A], sceneOrder: ["scene-a"], cutStatus: CURRENT });
    expect(screen.queryByText(/no longer matches the current clip order/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Assemble" })).toBeNull();

    cleanup();
    renderGrid({ clips: [A], sceneOrder: ["scene-a"], cutStatus: STALE });
    expect(screen.getByText(/no longer matches the current clip order/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Assemble" })).toBeTruthy();
  });

  it("Assemble calls reassembleProject", async () => {
    const user = userEvent.setup();
    renderGrid({ clips: [A], sceneOrder: ["scene-a"], cutStatus: STALE });

    await user.click(screen.getByRole("button", { name: "Assemble" }));

    // "new" explicitly: the stale banner must not silently replace the cut it
    // is warning about.
    expect(reassembleProject).toHaveBeenCalledWith("project-1", "new");
  });
});

// The soft gate. This screen opens at 1/2 on purpose — you come here to see
// what has finished — and Mark delivered is the single control that closes
// until the cut is whole.
describe("ClipGrid — Mark delivered gate", () => {
  it("disables Mark delivered, and says why, while a scene has not finished", () => {
    renderGrid({ clips: [A], sceneOrder: ["scene-a", "scene-b"], allScenesDone: false });

    const button = screen.getByRole("button", { name: "Mark delivered" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Delivery unlocks once every scene has rendered.")).toBeTruthy();
  });

  it("leaves the rest of the screen open on a partial cut", () => {
    renderGrid({
      clips: [A],
      sceneOrder: ["scene-a", "scene-b"],
      allScenesDone: false,
      hasFinal: false,
    });

    // Everything that only reads is still usable — the gate is one button,
    // not the page.
    expect(screen.getByRole("button", { name: /^Download all/ }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(screen.getByRole("button", { name: "Export CSV" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("link", { name: "Download Scene 1" })).toBeTruthy();
  });

  it("marks delivered once every scene is done", async () => {
    const user = userEvent.setup();
    renderGrid({ clips: [A], sceneOrder: ["scene-a"], allScenesDone: true });

    const button = screen.getByRole("button", { name: "Mark delivered" });
    expect(button.hasAttribute("disabled")).toBe(false);
    await user.click(button);

    expect(markDelivered).toHaveBeenCalledWith("project-1");
    await waitFor(() => expect(screen.getByRole("button", { name: "Delivered" })).toBeTruthy());
  });
});

describe("ClipGrid — action row", () => {
  it("offers the assembled mp4 as a download in the action row", () => {
    renderGrid({
      clips: [A],
      sceneOrder: ["scene-a"],
      hasFinal: true,
      finalUrl: "https://example.com/final.mp4",
    });

    const link = screen.getByRole("link", { name: "Download mp4" });
    expect(link.getAttribute("href")).toBe("https://example.com/final.mp4");
    expect(link.getAttribute("download")).toBe("My Project.mp4");
  });

  it("has no mp4 download when nothing has been assembled yet", () => {
    renderGrid({ clips: [A], sceneOrder: ["scene-a"], hasFinal: false, finalUrl: null });

    expect(screen.queryByRole("link", { name: "Download mp4" })).toBeNull();
  });

  it("Export CSV writes the cut in the order currently on screen", async () => {
    const user = userEvent.setup();
    renderGrid({ clips: [A, B], sceneOrder: ["scene-a", "scene-b"] });

    // Reorder first: the file has to follow the grid, not the props it was
    // first rendered with.
    await user.click(screen.getByRole("button", { name: "Move Scene 1 later" }));
    await user.click(screen.getByRole("button", { name: "Export CSV" }));

    expect(savedBlobs).toHaveLength(1);
    const csv = await savedBlobs[0]!.text();
    expect(csv).toBe(
      "Scene,Roll,Duration (s),File\r\n" +
        "1,A-roll,4,scene-02.mp4\r\n" +
        "2,B-roll,6,scene-01.mp4\r\n",
    );
  });
});

describe("buildCutCsv", () => {
  it("emits a header and one RFC 4180 row per clip", () => {
    expect(
      buildCutCsv([
        { position: 1, isTalkingHead: true, durationS: 6, filename: "scene-01.mp4" },
        { position: 2, isTalkingHead: false, durationS: 4, filename: "scene-02.mp4" },
      ]),
    ).toBe(
      "Scene,Roll,Duration (s),File\r\n" +
        "1,A-roll,6,scene-01.mp4\r\n" +
        "2,B-roll,4,scene-02.mp4\r\n",
    );
  });

  it("quotes a filename that contains a comma rather than shifting the column", () => {
    const csv = buildCutCsv([
      { position: 1, isTalkingHead: false, durationS: 6, filename: "scene-01, take 2.mp4" },
    ]);
    expect(csv).toContain('"scene-01, take 2.mp4"');
  });

  it("names the file after the project", () => {
    expect(cutCsvFilename("My Project")).toBe("My Project-cut.csv");
  });
});

describe("ClipGrid — read-only and delivered lock out reorder/Assemble controls", () => {
  it("hides drag handles, move buttons, and the Assemble button when not the owner", () => {
    renderGrid({
      clips: [A, B],
      sceneOrder: ["scene-a", "scene-b"],
      cutStatus: STALE,
      readOnly: true,
    });

    expect(screen.queryByRole("button", { name: /Drag to reorder/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Move Scene/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Assemble" })).toBeNull();
  });

  // The zip and the manifest are owner-only routes, so they are hidden for a
  // read-only viewer — but the mp4 and the per-clip files are signed URLs the
  // server already resolved, and they are the only files this viewer can get.
  it("keeps the assembled mp4 and per-clip downloads for a read-only viewer", () => {
    renderGrid({
      clips: [A],
      sceneOrder: ["scene-a"],
      readOnly: true,
      hasFinal: true,
      finalUrl: "https://example.com/final.mp4",
    });

    expect(screen.getByRole("link", { name: "Download mp4" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download Scene 1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Download all/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download manifest" })).toBeNull();
  });

  it("hides drag handles, move buttons, and the Assemble button once the project is delivered", () => {
    renderGrid({
      clips: [A, B],
      sceneOrder: ["scene-a", "scene-b"],
      cutStatus: STALE,
      initialStatus: "delivered",
    });

    expect(screen.queryByRole("button", { name: /Drag to reorder/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Move Scene/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Assemble" })).toBeNull();
  });

  it("hides the controls when a scene is not yet terminal, even for the owner", () => {
    renderGrid({ clips: [A], sceneOrder: ["scene-a", "scene-b"], allTerminal: false });

    expect(screen.queryByRole("button", { name: /Drag to reorder/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Move Scene/ })).toBeNull();
    expect(screen.getByText(/reordering unlocks once every scene/i)).toBeTruthy();
  });
});

// Drag coverage: dnd-kit's PointerSensor drives drags off real
// getBoundingClientRect()/pointer-event geometry, which jsdom doesn't lay
// out — simulating an actual drag here would mean faking measurement
// internals rather than testing this component's own logic. What IS
// covered above is everything the drag path shares with the button path:
// the same handleDragEnd would call the same applyReorder/mergeFullOrder
// logic the move-button tests already exercise (arrayMove -> mergeFullOrder
// -> reorderCut -> optimistic revert on error), and the keyboard sensor
// (KeyboardSensor + sortableKeyboardCoordinates) rides dnd-kit's own,
// separately-tested keyboard handling on top of that. NOT covered: the
// pointer drag gesture itself, and dnd-kit's built-in drag announcements
// (the `announcements` object passed to DndContext) — both would need a
// much heavier DOM/geometry mock to exercise meaningfully.
describe("ClipGrid — the clip cards show the cut, not spend", () => {
  it("renders a drag handle per card when reorder is enabled", () => {
    renderGrid({ clips: [A, B], sceneOrder: ["scene-a", "scene-b"] });
    expect(screen.getByRole("button", { name: "Drag to reorder Scene 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Drag to reorder Scene 2" })).toBeTruthy();
  });

  it("carries no per-clip repair controls — those live on the scene itself", () => {
    renderGrid({ clips: [A, B], sceneOrder: ["scene-a", "scene-b"] });

    expect(screen.queryByRole("button", { name: /^Re-render/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Fix the prompt/ })).toBeNull();
    // And no money anywhere on a card: the two dialogs that used to sit here
    // each printed a dollar figure.
    expect(screen.queryByText(/\$\d/)).toBeNull();
  });

  it("labels the list with one heading", () => {
    renderGrid({ clips: [A], sceneOrder: ["scene-a"] });

    const headings = screen.getAllByRole("heading");
    expect(headings).toHaveLength(1);
    expect(headings[0]!.textContent).toBe("Order");
  });
});

// handleExportCsv formats rows the viewer already has on screen, entirely in
// the browser — there is no request for a server to refuse. It sat inside the
// readOnly gate anyway, which removed an affordance from a read-only admin
// without protecting anything.
describe("ClipGrid — Export CSV is a client-side format, not a privileged action", () => {
  it("offers it to a read-only viewer", () => {
    renderGrid({ clips: [clip({ id: "s1" })], sceneOrder: ["s1"], readOnly: true });

    expect(screen.getByRole("button", { name: /export csv/i })).toBeTruthy();
  });

  it("still hides the controls that do call the server", () => {
    // The gate is not pointless — Mark delivered and the manifest go through
    // requireProject, and those stay hidden.
    renderGrid({ clips: [clip({ id: "s1" })], sceneOrder: ["s1"], readOnly: true });

    expect(screen.queryByRole("button", { name: /mark delivered/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /download manifest/i })).toBeNull();
  });

  it("offers it to an owner too", () => {
    renderGrid({ clips: [clip({ id: "s1" })], sceneOrder: ["s1"], readOnly: false });

    expect(screen.getByRole("button", { name: /export csv/i })).toBeTruthy();
  });
});
