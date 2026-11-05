import { describe, expect, it } from "vitest";
import { deriveProjectStatus, deriveReachedSteps, STATUS_ROUTE } from "./project-status";

// 'draft' storedStatus is used throughout below except where a case is
// specifically about 'delivered' — deriveProjectStatus ignores every
// storedStatus value except 'delivered', so any non-'delivered' value would
// do, but 'draft' keeps the intent of each case obvious at a glance.

describe("deriveProjectStatus", () => {
  it("is 'draft' for a project with no scenes yet, regardless of storedStatus", () => {
    expect(deriveProjectStatus("draft", [])).toBe("draft");
    // Belt-and-braces: even a stale 'rendering'/'framed' write from before a
    // recompile cleared the scenes table must not survive an empty list.
    expect(deriveProjectStatus("rendering", [])).toBe("draft");
  });

  it("is 'briefed' once scenes exist but none has a reference frame yet", () => {
    expect(
      deriveProjectStatus("draft", [
        { status: "draft", ref_frame_asset_id: null },
        { status: "draft", ref_frame_asset_id: null },
      ]),
    ).toBe("briefed");
  });

  it("is 'briefed' when only some scenes have a reference frame", () => {
    expect(
      deriveProjectStatus("draft", [
        { status: "draft", ref_frame_asset_id: "asset-1" },
        { status: "frame_ready", ref_frame_asset_id: null },
      ]),
    ).toBe("briefed");
  });

  it("is 'framed' once every scene has a reference frame and none has rendered yet", () => {
    expect(
      deriveProjectStatus("draft", [
        { status: "frame_ready", ref_frame_asset_id: "asset-1" },
        { status: "frame_ready", ref_frame_asset_id: "asset-2" },
      ]),
    ).toBe("framed");
  });

  it("is 'rendering' when any scene is queued", () => {
    expect(
      deriveProjectStatus("draft", [
        { status: "queued", ref_frame_asset_id: "asset-1" },
        { status: "frame_ready", ref_frame_asset_id: "asset-2" },
      ]),
    ).toBe("rendering");
  });

  it("is 'rendering' when any scene is actively rendering", () => {
    expect(
      deriveProjectStatus("draft", [
        { status: "rendering", ref_frame_asset_id: "asset-1" },
        { status: "done", ref_frame_asset_id: "asset-2" },
      ]),
    ).toBe("rendering");
  });

  it("is 'complete' once every scene has left queued/rendering — this is the bug this fix closes", () => {
    // storedStatus is deliberately still 'rendering' here: this is exactly
    // the drifted row the bug report described — every scene finished, but
    // nothing ever wrote 'complete' to the projects.status column.
    expect(
      deriveProjectStatus("rendering", [
        { status: "done", ref_frame_asset_id: "asset-1" },
        { status: "done", ref_frame_asset_id: "asset-2" },
      ]),
    ).toBe("complete");
  });

  it("is 'complete' when some scenes failed and none is still in flight", () => {
    // A failed clip needs a human to hit retryScene, not a different
    // top-level project status — retryScene puts that one scene back to
    // 'queued', which flips this project straight back to 'rendering'.
    expect(
      deriveProjectStatus("rendering", [
        { status: "done", ref_frame_asset_id: "asset-1" },
        { status: "failed", ref_frame_asset_id: "asset-2" },
      ]),
    ).toBe("complete");
  });

  it("is 'complete' even when every scene failed", () => {
    expect(
      deriveProjectStatus("rendering", [{ status: "failed", ref_frame_asset_id: "asset-1" }]),
    ).toBe("complete");
  });

  it("is NOT 'complete' when one scene is back at frame_ready mid-correction alongside done siblings — the bug this fix closes", () => {
    // unfreezeScene (actions/brief.ts) moves a previously-'done' scene back
    // to 'frame_ready' so its prompt can be corrected — it deletes that
    // scene's clip and the project's 'final' asset, but never touches
    // ref_frame_asset_id. The old condition was `scenes.some(!isEditable)`,
    // which the two 'done' siblings alone already satisfied: this project
    // used to derive as 'complete' and route straight to /deliver while the
    // reopened scene had no clip and the project had no 'final'.
    //
    // Every scene here still has a ref_frame_asset_id, so with 'complete'
    // correctly excluded the derivation falls through to 'framed' — not
    // 'rendering' (nothing is queued/rendering) and not 'complete' (one
    // scene is still editable). This keeps deriveProjectStatus in agreement
    // with worker/internal/store/store.go's ProjectsReadyToAssemble, which
    // the matching fix keeps out of this project's `final` build until the
    // reopened scene re-renders.
    expect(
      deriveProjectStatus("rendering", [
        { status: "frame_ready", ref_frame_asset_id: "asset-1" },
        { status: "done", ref_frame_asset_id: "asset-2" },
        { status: "done", ref_frame_asset_id: "asset-3" },
      ]),
    ).toBe("framed");
  });

  it("is NOT 'complete' when one scene is still at draft alongside done siblings ('test scene 1 only')", () => {
    // The latent twin of the case above, reachable without unfreezeScene at
    // all: a scene queued individually finishes rendering while a sibling
    // that was never queued sits at 'draft'. 'draft' has no
    // ref_frame_asset_id yet, so this falls all the way through to
    // 'briefed', not 'framed'.
    expect(
      deriveProjectStatus("rendering", [
        { status: "draft", ref_frame_asset_id: null },
        { status: "done", ref_frame_asset_id: "asset-2" },
      ]),
    ).toBe("briefed");
  });

  it("is 'delivered' whenever storedStatus is 'delivered', no matter what scenes say", () => {
    // Delivery is a human act (actions/deliver.ts markDelivered) with no
    // scene-derived equivalent — it must win even against scene rows that,
    // read alone, would derive to something else entirely.
    expect(
      deriveProjectStatus("delivered", [{ status: "queued", ref_frame_asset_id: "asset-1" }]),
    ).toBe("delivered");
    expect(deriveProjectStatus("delivered", [])).toBe("delivered");
  });
});

describe("STATUS_ROUTE", () => {
  it("routes 'complete' to the deliver step, not back to render", () => {
    // Regression test for the confirmed defect: 'complete' (a project with
    // no scenes left queued/rendering, possibly including a permanently
    // failed one — see deriveProjectStatus above) used to map back to
    // "render", which is where the batch had already finished running.
    // That left an operator with clips they'd already paid for and no
    // route to go collect them — both the bare /projects/[id] redirect
    // (app/(app)/projects/[id]/page.tsx) and, formerly, step-rail.tsx's
    // reachability check read this same map. step-rail.tsx now reads
    // deriveReachedSteps instead (see below) — this entry still matters for
    // the bare-redirect landing spot.
    expect(STATUS_ROUTE.complete).toBe("deliver");
  });
});

describe("deriveReachedSteps", () => {
  // These two shapes are the confirmed regression this function exists to
  // close (see its doc comment): deriveProjectStatus's 'complete' check was
  // correctly tightened from `some` to `every`, but step-rail.tsx kept
  // comparing STATUS_ROUTE positions against the resulting (now
  // backwards-capable) derived status, greying out Render and Deliver for
  // clips the operator had already paid for. Both are asserted against the
  // full ReachedSteps object, not just render/deliver, so a future change
  // that quietly regresses brief/frames reachability alongside a correct
  // render/deliver fix would still fail here.

  it("pins the routing consequence of [frame_ready, done, done] — exactly what unfreezeScene leaves", () => {
    // storedStatus is 'rendering' here, not 'draft': this is the one case
    // in this file where that matters. enqueueRender wrote 'rendering' to
    // the column when this batch was originally submitted, and nothing —
    // not unfreezeScene, not any other action — ever writes it backwards.
    // That stale-for-current-status, reliable-for-ever-reached value is
    // exactly what makes render/deliver derive to `true` below even though
    // the scene shape alone (one 'frame_ready' scene next to two 'done'
    // ones) is the same input deriveProjectStatus reads as 'framed', i.e.
    // "never reached render," in the test above.
    expect(
      deriveReachedSteps("rendering", [
        { status: "frame_ready", ref_frame_asset_id: "asset-1" },
        { status: "done", ref_frame_asset_id: "asset-2" },
        { status: "done", ref_frame_asset_id: "asset-3" },
      ]),
    ).toEqual({
      character: true,
      brief: true,
      frames: true,
      render: true,
      deliver: true,
    });
  });

  it("pins the routing consequence of [draft, done] — a scene added after rendering already started", () => {
    // Same storedStatus reasoning as above: 'rendering' was written once,
    // when the original scene(s) were enqueued, and addScene (which has no
    // project-wide editability gate by design) doesn't touch it when it
    // inserts the new 'draft' scene afterwards. deriveProjectStatus reads
    // this shape as 'briefed' — "never reached frames," let alone render —
    // but a 'done' sibling proves otherwise.
    expect(
      deriveReachedSteps("rendering", [
        { status: "draft", ref_frame_asset_id: null },
        { status: "done", ref_frame_asset_id: "asset-2" },
      ]),
    ).toEqual({
      character: true,
      brief: true,
      frames: true,
      render: true,
      deliver: true,
    });
  });

  it("is 'character' only for a fresh project with no scenes yet", () => {
    expect(deriveReachedSteps("draft", [])).toEqual({
      character: true,
      brief: false,
      frames: false,
      render: false,
      deliver: false,
    });
  });

  it("reaches 'brief' once scenes exist, even if every scene is still draft", () => {
    // Same evidence deriveProjectStatus uses for 'draft' vs 'briefed'.
    expect(
      deriveReachedSteps("briefed", [
        { status: "draft", ref_frame_asset_id: null },
        { status: "draft", ref_frame_asset_id: null },
      ]),
    ).toMatchObject({ brief: true, frames: false, render: false, deliver: false });
  });

  it("reaches 'frames' from storedStatus alone, before any scene actually has a reference frame yet", () => {
    // approveBrief writes 'framed' to the column without touching a single
    // scene — frame generation is a separate step, kicked off from the
    // Frames page itself. A project that just landed there off approveBrief
    // must already read frames:true, not wait for generateFrames to finish.
    expect(
      deriveReachedSteps("framed", [
        { status: "draft", ref_frame_asset_id: null },
        { status: "draft", ref_frame_asset_id: null },
      ]),
    ).toMatchObject({ frames: true, render: false });
  });

  it("reaches 'frames' from scene evidence alone, even if storedStatus hasn't caught up", () => {
    // The mirror image of the case above — belt-and-braces, matching
    // deriveProjectStatus's own reliance on ref_frame_asset_id.
    expect(
      deriveReachedSteps("briefed", [{ status: "frame_ready", ref_frame_asset_id: "asset-1" }]),
    ).toMatchObject({ frames: true });
  });

  it("does NOT reach 'render' or 'deliver' while every scene is still draft/frame_ready", () => {
    // The guard this fix must not weaken: a project with no brief approved
    // and nothing queued must still not show Render/Deliver as reachable.
    expect(
      deriveReachedSteps("framed", [
        { status: "frame_ready", ref_frame_asset_id: "asset-1" },
        { status: "frame_ready", ref_frame_asset_id: "asset-2" },
      ]),
    ).toEqual({
      character: true,
      brief: true,
      frames: true,
      render: false,
      deliver: false,
    });
  });

  it("reaches 'render' the moment any scene leaves draft/frame_ready, even mid-batch with nothing done yet", () => {
    expect(
      deriveReachedSteps("rendering", [
        { status: "queued", ref_frame_asset_id: "asset-1" },
        { status: "frame_ready", ref_frame_asset_id: "asset-2" },
      ]),
    ).toMatchObject({ render: true, deliver: false });
  });

  it("does NOT reach 'deliver' until at least one scene is actually 'done'", () => {
    // A project that's rendering but hasn't finished a single clip yet has
    // nothing for deliver/page.tsx to show — matches its own "incomplete"
    // banner, which already tolerates a partial batch once something HAS
    // finished.
    expect(
      deriveReachedSteps("rendering", [
        { status: "queued", ref_frame_asset_id: "asset-1" },
        { status: "rendering", ref_frame_asset_id: "asset-2" },
      ]),
    ).toMatchObject({ deliver: false });
  });

  it("reaches 'deliver' once any single scene is 'done', without waiting for the rest of the batch", () => {
    expect(
      deriveReachedSteps("rendering", [
        { status: "done", ref_frame_asset_id: "asset-1" },
        { status: "queued", ref_frame_asset_id: "asset-2" },
      ]),
    ).toMatchObject({ deliver: true });
  });

  it("keeps 'deliver' reachable once storedStatus is 'delivered', even if every scene were unfrozen back to frame_ready", () => {
    // Mirrors deriveProjectStatus's own 'delivered' stickiness: delivery is
    // a human act, and unfreezeScene's own doc comment (actions/brief.ts)
    // is explicit that nothing can un-deliver a project.
    expect(
      deriveReachedSteps("delivered", [
        { status: "frame_ready", ref_frame_asset_id: "asset-1" },
        { status: "frame_ready", ref_frame_asset_id: "asset-2" },
      ]),
    ).toMatchObject({ deliver: true });
  });
});
