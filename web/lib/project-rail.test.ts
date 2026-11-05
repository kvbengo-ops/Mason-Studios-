import { describe, expect, it } from "vitest";
import {
  buildRailModel,
  type BuildRailModelArgs,
  type RailProjectInput,
  type RailSceneInput,
} from "./project-rail";
import type { RailEntry, RailModel } from "./project-rail-types";
import type { ReachedSteps } from "./project-status";

// Every scenario builds its own `reached` explicitly rather than deriving
// it — buildRailModel must not re-derive reachability from project.status
// (see its own doc comment on that), so tests exercise it as the caller
// (layout.tsx) actually supplies it: precomputed by
// lib/project-status.ts's deriveReachedSteps, upstream of this file.

const ALL_REACHED: ReachedSteps = {
  character: true,
  brief: true,
  frames: true,
  render: true,
  deliver: true,
};

const NONE_REACHED: ReachedSteps = {
  character: true,
  brief: false,
  frames: false,
  render: false,
  deliver: false,
};

function project(overrides: Partial<RailProjectInput> = {}): RailProjectInput {
  return {
    id: "proj-1",
    title: "Test project",
    character_desc: null,
    product_name: null,
    script_raw: null,
    render_settings: null,
    ...overrides,
  };
}

function scene(overrides: Partial<RailSceneInput> = {}): RailSceneInput {
  return {
    id: "scene-1",
    idx: 0,
    is_talking_head: true,
    status: "draft",
    duration_s: 6,
    submitted_at: null,
    ...overrides,
  };
}

/**
 * buildRailModel with the arguments a test isn't making a point about filled
 * in. Every scenario below still passes `project`/`scenes`/`reached`
 * explicitly — those are what the tests are about — but a balance read, the
 * spend, whether a final exists and whether the viewer owns the project are
 * background for most of them, and spelling all seven out per case is how the
 * suite ends up needing a sweep every time the signature grows.
 */
function build(overrides: Partial<BuildRailModelArgs> = {}): RailModel {
  return buildRailModel({
    project: project(),
    scenes: [],
    reached: NONE_REACHED,
    spentUsd: 0,
    hasFinalAsset: false,
    canAddScene: true,
    ...overrides,
  });
}

describe("buildRailModel — Setup group hrefs", () => {
  it("the three Setup rows each point at their own route", () => {
    const model = build({
      project: project(),
      scenes: [],
      reached: NONE_REACHED,
    });

    const setupGroup = model.groups.find((g) => g.id === "setup")!;
    const hrefs = setupGroup.entries.map((entry) => entry.href);

    expect(hrefs).toEqual([
      "/projects/proj-1/character",
      "/projects/proj-1/product",
      "/projects/proj-1/script",
    ]);
    // Render settings is deliberately absent — its controls live in the
    // scene page's own column now, and /settings is reached from a link
    // there rather than from a Setup step (see buildRailModel's comment
    // where that row used to be). Removed once, reverted when it orphaned
    // the screen, removed again once the screen had another way in.
    // Three rows, three distinct destinations — see components/project-rail.tsx's
    // currentEntryId for why this matters: with a shared href, marking the
    // current row degrades to "first match wins" and silently highlights the
    // wrong row.
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("no Setup row carries its own glyph now that Render settings is gone", () => {
    // RailEntry.icon exists for a row that swaps its tick for its screen's
    // own symbol. Render settings — the gear — was the only row that ever
    // used it, and it is no longer a Setup step. The field stays on the
    // type; nothing claims it. Pinned so a row cannot quietly grow a glyph
    // without someone deciding to give it one.
    const setupGroup = build().groups.find((g) => g.id === "setup")!;

    expect(setupGroup.entries.filter((entry) => entry.icon !== undefined)).toEqual([]);
    expect(setupGroup.entries.map((entry) => entry.label)).toEqual([
      "Character",
      "Product",
      "Script",
    ]);
  });
});

describe("buildRailModel", () => {
  it("locks scenes and cut, naming the script once, for a project with no scenes", () => {
    const model = build({
      project: project(),
      scenes: [],
      reached: NONE_REACHED,
    });

    const scenesGroup = model.groups.find((g) => g.id === "scenes")!;
    const cutGroup = model.groups.find((g) => g.id === "cut")!;

    expect(scenesGroup.dimmed).toBe(true);
    expect(cutGroup.dimmed).toBe(true);
    expect(scenesGroup.entries).toHaveLength(1);
    expect(scenesGroup.entries[0]!.status).toBe("locked");
    expect(scenesGroup.entries[0]!.href).toBeNull();
    // The gate belongs to Scenes, so Scenes is where the sentence lives.
    expect(scenesGroup.entries[0]!.lockedReason).toMatch(/script/i);
    expect(cutGroup.entries[0]!.status).toBe("locked");
    expect(cutGroup.entries[0]!.href).toBeNull();
    // And Cut, locked by the SAME gate two rows below it, does not repeat it
    // — it keeps its own name. Saying it twice is what made a locked rail
    // four lines carrying one fact.
    expect(cutGroup.entries[0]!.lockedReason).toBeUndefined();
    expect(cutGroup.entries[0]!.label).toBe("Final video");
  });

  it("keeps the locked reason short enough to be one line at the rail's width", () => {
    // The constraint that beat the two previous wordings: at 13rem, minus the
    // rail's padding and the status glyph, a row has room for roughly twenty
    // characters before it clips or wraps. This is a real limit on the
    // SENTENCE — the component renders it on one line by design — so it is
    // pinned here rather than left to be rediscovered by clipping in
    // production a third time.
    const model = build({ scenes: [] });
    const reason = model.groups.find((g) => g.id === "scenes")!.entries[0]!.lockedReason!;

    expect(reason.length).toBeLessThanOrEqual(20);
  });

  it("unlocks scenes once they exist, and maps each scene's status to the right entry status", () => {
    const model = build({
      project: project(),
      scenes: [
        scene({ id: "s-done", idx: 0, status: "done" }),
        scene({ id: "s-rendering", idx: 1, status: "rendering" }),
      ],
      reached: ALL_REACHED,
    });

    const scenesGroup = model.groups.find((g) => g.id === "scenes")!;
    expect(scenesGroup.dimmed).toBeFalsy();

    const doneEntry = scenesGroup.entries.find((e) => e.id === "s-done")!;
    const renderingEntry = scenesGroup.entries.find((e) => e.id === "s-rendering")!;

    // Assert both directions: a done scene reads done AND is NOT read as
    // running; a rendering scene reads running AND is NOT read as done.
    expect(doneEntry.status).toBe("done");
    expect(doneEntry.status).not.toBe("running");
    expect(renderingEntry.status).toBe("running");
    expect(renderingEntry.status).not.toBe("done");
  });

  it("keeps Final video reachable (not locked) at 1/2 scenes done", () => {
    const model = build({
      project: project(),
      scenes: [
        scene({ id: "s-1", idx: 0, status: "done" }),
        scene({ id: "s-2", idx: 1, status: "queued" }),
      ],
      reached: { ...NONE_REACHED, deliver: true },
    });

    const cutGroup = model.groups.find((g) => g.id === "cut")!;
    expect(cutGroup.dimmed).toBeFalsy();
    expect(cutGroup.entries[0]!.status).not.toBe("locked");
    expect(cutGroup.entries[0]!.status).toBe("idle");
    expect(cutGroup.entries[0]!.href).not.toBeNull();
    expect(cutGroup.entries[0]!.count).toBe("1/2");
  });

  it("follows `reached`, not project.status, for a status-moved-backwards project (deriveReachedSteps' own scenario)", () => {
    // lib/project-status.ts's deriveReachedSteps doc comment: unfreezeScene
    // moves one previously-'done' scene back to 'frame_ready' without
    // touching its 'done' siblings — [frame_ready, done, done] — which
    // derives the project's status BACK to 'framed', even though Render
    // (and everything a 'done' sibling already paid for) must stay
    // reachable. `reached` is what carries that "ever reached" evidence
    // here; a stale/backwards status must not remove it.
    const reachedDespiteBackwardsStatus: ReachedSteps = {
      character: true,
      brief: true,
      frames: true,
      render: true, // still true — a 'done' sibling already rendered
      deliver: true, // still true — that sibling is waiting on Deliver
    };

    const model = build({
      project: project(),
      scenes: [
        scene({ id: "s-reopened", idx: 0, status: "frame_ready" }),
        scene({ id: "s-done-1", idx: 1, status: "done" }),
        scene({ id: "s-done-2", idx: 2, status: "done" }),
      ],
      reached: reachedDespiteBackwardsStatus,
    });

    const scenesGroup = model.groups.find((g) => g.id === "scenes")!;
    const doneEntry = scenesGroup.entries.find((e) => e.id === "s-done-1")!;
    const cutGroup = model.groups.find((g) => g.id === "cut")!;

    // The scene links to its own workbench, and Final video still links to
    // /deliver (reached.deliver true) — neither is locked out by the reopened
    // sibling. The scene href no longer consults `reached` at all: the
    // workbench exists for a scene in any state and says so itself. Final
    // video is where the `reached` rule still lives, so that is what this
    // asserts.
    expect(doneEntry.href).toBe("/projects/proj-1/scenes/s-done-1");
    expect(cutGroup.entries[0]!.href).toBe("/projects/proj-1/deliver");
  });

  it("the cut's href comes from `reached`, not from the scenes' own statuses", () => {
    // Companion to the test above, which pins the TRUE branch. This pins the
    // FALSE branch, and it now lives on Final video rather than on a scene:
    // scene hrefs stopped consulting `reached` when each scene got its own
    // workbench, but Final video still must not link out to a Deliver page
    // the project has never reached, however finished its scenes look.
    //
    // Without this, `reached` could be ignored entirely and every other test
    // here would still pass.
    const model = build({
      project: project(),
      scenes: [scene({ id: "s-done", idx: 0, status: "done" })],
      reached: { ...ALL_REACHED, deliver: false },
    });

    const cutGroup = model.groups.find((g) => g.id === "cut")!;
    expect(cutGroup.entries[0]!.href).toBeNull();

    // And the scene itself is still reachable — the point is that these two
    // are now decided by different rules, not that everything is locked.
    const scenesGroup = model.groups.find((g) => g.id === "scenes")!;
    expect(scenesGroup.entries[0]!.href).toBe("/projects/proj-1/scenes/s-done");
  });
});

// The design puts the running cost in the rail — "2 scenes · 12s · $4.17" —
// because the rail is the one thing on screen from every route, so this is
// the only spend figure an operator sees without going to look for it.
describe("buildRailModel — the subtitle carries what the project has cost", () => {
  it("appends actual spend beside the scene count and runtime", () => {
    const model = build({
      project: project(),
      scenes: [
        scene({ id: "s1", idx: 0, duration_s: 6 }),
        scene({ id: "s2", idx: 1, duration_s: 6 }),
      ],
      reached: ALL_REACHED,
      spentUsd: 4.17,
    });

    expect(model.projectSubtitle).toBe("2 scenes · 12s · $4.17");
  });

  it("says nothing about money before anything has been billed", () => {
    // A "$0.00" sitting in the chrome reads like a broken number, not like
    // a project that has spent nothing.
    const model = build({
      project: project(),
      scenes: [scene({ id: "s1", idx: 0, duration_s: 6 })],
      reached: ALL_REACHED,
    });

    expect(model.projectSubtitle).toBe("1 scene · 6s");
  });
});

// The Setup count is a warning about unfinished work, not a permanent
// counter — see RailGroup.count.
describe("buildRailModel — the Setup count only exists while Setup is unfinished", () => {
  const filledIn = {
    character_desc: "a barista",
    product_name: "Kinoko",
    script_raw: "line one",
    render_settings: {},
  };

  it("counts how far through Setup the project is while any field is empty", () => {
    const model = build({ project: project({ character_desc: "a barista" }) });

    expect(model.groups.find((g) => g.id === "setup")!.count).toBe("1/3");
  });

  it("drops the count entirely once all three are done", () => {
    // Not "3/3". A tally that can never change again is furniture in the one
    // place on screen reserved for what still needs doing.
    //
    // A scene is required, not just a saved script: Script is ticked by
    // COMPILING now, since scenes are what that step produces. Without one
    // the rail would say "Script ✓" while the group beneath it still read
    // "Compile the script".
    const model = build({ project: project(filledIn), scenes: [scene()] });

    expect(model.groups.find((g) => g.id === "setup")!.count).toBeUndefined();
  });
});

// The design's rule is that every API call owns a rail entry that spins while
// it runs. The final stitch is the one of those calls that leaves a trace a
// server render can see — see buildRailModel's `assembling`.
describe("buildRailModel — Final video spins while the assemble loop owes a final", () => {
  const terminalScenes = [
    scene({ id: "s-1", idx: 0, status: "done" }),
    scene({ id: "s-2", idx: 1, status: "failed" }),
  ];

  function cutEntry(overrides: Partial<BuildRailModelArgs> = {}): RailEntry {
    return build({ reached: ALL_REACHED, ...overrides }).groups.find((g) => g.id === "cut")!
      .entries[0]!;
  }

  it("marks Final video busy when every scene is terminal, one is done, and no final exists", () => {
    expect(cutEntry({ scenes: terminalScenes, hasFinalAsset: false }).busy).toBe(true);
  });

  it("stops once the final asset lands", () => {
    expect(cutEntry({ scenes: terminalScenes, hasFinalAsset: true }).busy).toBe(false);
  });

  it("does not spin while a scene is still rendering — the loop cannot have claimed it yet", () => {
    const stillRendering = [
      scene({ id: "s-1", idx: 0, status: "done" }),
      scene({ id: "s-2", idx: 1, status: "rendering" }),
    ];

    expect(cutEntry({ scenes: stillRendering, hasFinalAsset: false }).busy).toBe(false);
  });

  it("does not spin for an all-failed project, which has no clip to assemble", () => {
    const allFailed = [scene({ id: "s-1", idx: 0, status: "failed" })];

    expect(cutEntry({ scenes: allFailed, hasFinalAsset: false }).busy).toBe(false);
  });
});

// A running row's trailing text is a clock, not a word: "rendering" reads the
// same at four seconds and at eight minutes, which is how a render that had
// already finished and already billed sat there unremarked.
describe("buildRailModel — the elapsed clock on a running scene", () => {
  const submittedAt = "2026-08-29T10:00:00.000Z";

  function sceneEntry(overrides: Partial<RailSceneInput>): RailEntry {
    return build({
      scenes: [scene({ id: "s-1", idx: 0, ...overrides })],
      reached: ALL_REACHED,
    }).groups.find((g) => g.id === "scenes")!.entries[0]!;
  }

  it("hands the row its claim time to measure from while the worker owns it", () => {
    expect(sceneEntry({ status: "rendering", submitted_at: submittedAt }).elapsedSince).toBe(
      submittedAt,
    );
  });

  it("keeps the state word underneath as what a clockless render still shows", () => {
    // A queued scene the worker has not claimed yet has no submitted_at, and
    // a row with neither a clock nor a word would say nothing at all.
    const entry = sceneEntry({ status: "queued", submitted_at: null });
    expect(entry.elapsedSince).toBeNull();
    expect(entry.count).toBe("queued");
  });

  it("gives a finished scene no clock, whatever it was submitted at", () => {
    // A done scene's submitted_at describes when it started, not anything
    // anyone is still waiting on — the same scoping lib/render-elapsed.ts
    // applies to its own origin.
    expect(sceneEntry({ status: "done", submitted_at: submittedAt }).elapsedSince).toBeNull();
  });
});

// The add-scene affordance belongs in the rail, not only on the brief page —
// the rail is the one thing visible from every route, which is the whole
// argument for it existing.
describe("buildRailModel — the Scenes group's add row", () => {
  it("appends after the last scene for an owner", () => {
    const model = build({
      scenes: [scene({ id: "s-1", idx: 0 }), scene({ id: "s-2", idx: 1 })],
      reached: ALL_REACHED,
      canAddScene: true,
    });

    expect(model.groups.find((g) => g.id === "scenes")!.addScene).toEqual({
      projectId: "proj-1",
      afterIdx: 1,
    });
  });

  it("is absent for a viewer who may not add one", () => {
    // An admin reading someone else's project. addScene goes through
    // requireProject and would refuse the click, so the rail does not offer
    // it.
    const model = build({
      scenes: [scene({ id: "s-1", idx: 0 })],
      reached: ALL_REACHED,
      canAddScene: false,
    });

    expect(model.groups.find((g) => g.id === "scenes")!.addScene).toBeUndefined();
  });

  it("is absent while the group is still locked, where there is nothing to append to", () => {
    const model = build({ scenes: [], canAddScene: true });

    expect(model.groups.find((g) => g.id === "scenes")!.addScene).toBeUndefined();
  });
});

// The rail used to contradict itself in two adjacent rows: "Script ✓" the
// moment text was saved, and "Scenes — compile the script" directly beneath.
describe("buildRailModel — Script is ticked by compiling, not by saving", () => {
  const withScript = {
    character_desc: "a barista",
    product_name: "Kinoko",
    script_raw: "line one",
    render_settings: {},
  };

  it("leaves Script unticked while a saved script has produced no scenes", () => {
    const model = build({ project: project(withScript), scenes: [] });
    const script = model.groups
      .find((g) => g.id === "setup")!
      .entries.find((e) => e.label === "Script")!;

    expect(script.status).toBe("idle");
  });

  it("ticks it once scenes exist", () => {
    const model = build({ project: project(withScript), scenes: [scene()] });
    const script = model.groups
      .find((g) => g.id === "setup")!
      .entries.find((e) => e.label === "Script")!;

    expect(script.status).toBe("done");
  });

  it("never claims Script is done while the Scenes group still says to compile", () => {
    // The two rows are read together, one above the other. This is the
    // invariant, not the individual states.
    const model = build({ project: project(withScript), scenes: [] });
    const setup = model.groups.find((g) => g.id === "setup")!;
    const scenes = model.groups.find((g) => g.id === "scenes")!;
    const script = setup.entries.find((e) => e.label === "Script")!;
    const locked = scenes.entries.some((e) => e.status === "locked");

    expect(script.status === "done" && locked).toBe(false);
  });
});

// queued and rendering are different facts, and the rail used to collapse
// them: a scene the worker had not claimed yet drew the spinning glyph and
// announced itself as "Rendering" to a screen reader, beside its own
// trailing word "queued". It also has no submitted_at, so no clock — which
// is the difference the two words exist to carry.
describe("buildRailModel — queued is not a shade of running", () => {
  function statusFor(sceneStatus: "queued" | "rendering"): string {
    const model = build({ scenes: [scene({ id: "s1", status: sceneStatus })] });
    return model.groups.find((g) => g.id === "scenes")!.entries[0]!.status;
  }

  it("keeps a queued scene queued", () => {
    expect(statusFor("queued")).toBe("queued");
  });

  it("keeps a rendering scene running", () => {
    expect(statusFor("rendering")).toBe("running");
  });
});
