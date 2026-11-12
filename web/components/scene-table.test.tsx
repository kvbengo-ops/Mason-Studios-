// @vitest-environment jsdom
//
// Covers the A-roll/B-roll segmented control added to the "Roll" cell
// (QA regression: a single button labelled with the scene's current value
// can't distinguish "is" from "sets" — see the RollToggle doc comment in
// scene-table.tsx). Not a full SceneTable suite: other cells (prompt/line
// autosave, split/apply/delete) have no coverage here and stay out of
// scope. "@/actions/brief" is mocked for the same reason
// render-progress.test.tsx mocks "@/actions/enqueue" — the real module
// pulls in Supabase/next/headers machinery that throws outside a request.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "@testing-library/react";
import { SceneTable } from "./scene-table";
import { ProjectRail, RailBusyProvider } from "@/components/project-rail";
import { applyScenePrompt, deleteScene, splitScene } from "@/actions/brief";
import type { RailModel } from "@/lib/project-rail-types";
import { toggleTalkingHead } from "@/actions/brief";
import { DEFAULT_RENDER_SETTINGS } from "@/lib/models";
import type { Database } from "@/types/db";

type SceneRow = Database["public"]["Tables"]["scenes"]["Row"];

vi.mock("@/actions/brief", () => ({
  updateScenePrompt: vi.fn(),
  updateSceneLine: vi.fn(),
  toggleTalkingHead: vi.fn(async () => undefined),
  updateSceneDuration: vi.fn(),
  deleteScene: vi.fn(),
  addScene: vi.fn(),
  applyScenePrompt: vi.fn(),
  splitScene: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// ProjectRail (rendered beside the table in the rail tests below) reads the
// pathname to mark the current row and the router to poll itself. Neither
// hook works outside an app-router context.
vi.mock("next/navigation", () => ({
  usePathname: (): string => "/projects/project-1/brief",
  useRouter: (): { refresh: () => void; push: () => void } => ({
    refresh: vi.fn(),
    push: vi.fn(),
  }),
}));

// Radix's Select drives its trigger through the Pointer Events capture API
// and scrolls the active option into view; jsdom implements neither, so
// opening the menu throws before any assertion runs. Stubs, not behaviour —
// nothing below asserts on capture or scrolling.
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
  vi.mocked(toggleTalkingHead).mockReset();
  vi.mocked(toggleTalkingHead).mockResolvedValue(undefined);
});

function scene(overrides: Partial<SceneRow> = {}): SceneRow {
  return {
    // 0142 — studio name and drag position; irrelevant here.
    title: null,
    position: null,
    active_version_id: null,
    // 0127 — API-token columns; irrelevant to SceneTable.
    api_token_id: null,
    estimated_cost_usd: null,
    idempotency_hash: null,
    idempotency_key: null,
    prepare_started_at: null,
    prepare_token: null,
    created_at: new Date().toISOString(),
    // 0063_scenes_dev_flag.sql — irrelevant to SceneTable, which never reads
    // it; false (production) is the ordinary case for a fixture.
    dev: false,
    duration_s: 5,
    edited_by_human: false,
    kie_task_id: null,
    id: "scene-1",
    idx: 0,
    is_talking_head: true,
    project_id: "project-1",
    ref_frame_asset_id: null,
    // 0071. Null is the scripted pipeline's normal state: these are
    // snapshotted only by /ugc's generateClip, from a saved element.
    // 0045_scene_render_settings_override.sql — null is the ordinary case
    // (no per-scene model override); SceneTable never reads it.
    render_settings_override: null,
    script_line: "Hello world",
    status: "draft",
    submitted_at: null,
    template_id: null,
    video_prompt: "A prompt",
    // 0072. Null is the normal state: only a scene whose prompt went
    // through Refine carries one.
    ai_generated_prompt: null,
    visual_idea: null,
    ...overrides,
  };
}

function renderTable(scenes: SceneRow[], readOnly = false): ReturnType<typeof render> {
  return render(
    <SceneTable
      projectId="project-1"
      initialScenes={scenes}
      audioEnabled={false}
      renderSettings={DEFAULT_RENDER_SETTINGS}
      // Haiku's rate — what a project that has never picked a compiler
      // model is charged, which is the case every scene here represents.
      applySceneCostUsd={0.01}
      readOnly={readOnly}
    />,
  );
}

describe("SceneTable — A-roll/B-roll segmented control", () => {
  it("shows both options with the current value marked selected via aria-checked, not colour alone", () => {
    renderTable([scene({ is_talking_head: true })]);

    const group = screen.getByRole("radiogroup", { name: /a-roll or b-roll/i });
    const aRoll = within(group).getByRole("radio", { name: "A-roll" });
    const bRoll = within(group).getByRole("radio", { name: "B-roll" });

    expect(aRoll).toBeTruthy();
    expect(bRoll).toBeTruthy();
    expect(aRoll.getAttribute("aria-checked")).toBe("true");
    expect(bRoll.getAttribute("aria-checked")).toBe("false");
  });

  it("keeps each label on one line — 'A-roll' has the one character a browser will break on", () => {
    // Reported from a real run: the Roll column is narrow and the control
    // broke to "A-" over "roll", turning a one-line segmented control into a
    // cramped two-line one. These are raw <button>s, not the ui Button
    // (which carries whitespace-nowrap already), so the class has to be on
    // them — and a hyphen is exactly where the line breaks.
    renderTable([scene({ is_talking_head: true })]);

    const group = screen.getByRole("radiogroup", { name: /a-roll or b-roll/i });
    for (const label of ["A-roll", "B-roll"]) {
      const option = within(group).getByRole("radio", { name: label });
      expect(option.className).toContain("whitespace-nowrap");
    }
    // And the group itself must not be squeezed instead — otherwise the
    // labels are nowrap inside a box that is too small to show them.
    expect(group.className).toContain("shrink-0");
  });

  it("reflects B-roll as selected when the scene isn't talking-head", () => {
    renderTable([scene({ is_talking_head: false })]);

    const group = screen.getByRole("radiogroup", { name: /a-roll or b-roll/i });
    expect(within(group).getByRole("radio", { name: "A-roll" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(within(group).getByRole("radio", { name: "B-roll" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("clicking the inactive option flips the row optimistically and calls the server action", async () => {
    const user = userEvent.setup();
    // Keep toggleTalkingHead pending so the optimistic value (the whole
    // point of useOptimistic) is observed before the transition settles —
    // useOptimistic's patch only holds for the duration of the pending
    // transition and reverts to the (unchanged, in this test) base
    // `initialScenes` once the action resolves and startTransition
    // completes, exactly as it does in production while waiting on
    // revalidation to hand back the server-confirmed row.
    let resolveToggle: () => void = () => {};
    vi.mocked(toggleTalkingHead).mockReturnValue(
      new Promise((resolve) => {
        resolveToggle = () => resolve(undefined);
      }),
    );
    renderTable([scene({ id: "scene-1", is_talking_head: true })]);

    const group = screen.getByRole("radiogroup", { name: /a-roll or b-roll/i });
    await user.click(within(group).getByRole("radio", { name: "B-roll" }));

    await waitFor(() =>
      expect(
        within(group).getByRole("radio", { name: "B-roll" }).getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(within(group).getByRole("radio", { name: "A-roll" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(toggleTalkingHead).toHaveBeenCalledWith("scene-1");

    resolveToggle();
  });

  it("clicking the already-active option is a no-op", async () => {
    const user = userEvent.setup();
    renderTable([scene({ id: "scene-1", is_talking_head: true })]);

    const group = screen.getByRole("radiogroup", { name: /a-roll or b-roll/i });
    await user.click(within(group).getByRole("radio", { name: "A-roll" }));

    expect(toggleTalkingHead).not.toHaveBeenCalled();
  });

  it("read-only branch renders the correct active option and offers no way to change it", () => {
    renderTable([scene({ is_talking_head: true })], true);

    // No radiogroup at all in the read-only branch — it stays a Badge.
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByText("A-roll")).toBeTruthy();
    expect(screen.queryByText("B-roll")).toBeNull();
  });
});

// The duration cell had no coverage at all while it was a number input —
// which is how it shipped silently snapping whatever was typed to the
// nearest legal value. An editor read that as the app accepting a 20s scene
// on Seedance Mini (which stops at 15s) and only learned otherwise when fal
// refused the render. These pin the picker that replaced it.
describe("SceneTable — clip length picker", () => {
  it("offers only the lengths the project's model accepts", async () => {
    const user = userEvent.setup();
    renderTable([scene({ duration_s: 8 })]);

    await user.click(screen.getByRole("combobox", { name: /clip length/i }));

    // DEFAULT_RENDER_SETTINGS is Seedance25 (the default now — see its own
    // `enabled` doc comment): every integer 4..30, so 3 and 31 are not
    // offered.
    for (let seconds = 4; seconds <= 30; seconds++) {
      expect(screen.getByRole("option", { name: `${seconds}s` })).toBeTruthy();
    }
    expect(screen.queryByRole("option", { name: "3s" })).toBeNull();
    expect(screen.queryByRole("option", { name: "31s" })).toBeNull();
  });

  it("keeps an out-of-set length visible and marked rather than blanking it", () => {
    // 31s is not a Seedance25 length (its ceiling is 30s). A brief compiled
    // against a wider model, or any older row, can hold one — and blanking
    // a value the operator never touched would read as data loss.
    renderTable([scene({ duration_s: 31 })]);

    const trigger = screen.getByRole("combobox", { name: /clip length/i });
    expect(trigger.textContent).toContain("31s");
    // Flagged on the control itself, not by colour alone: the accessible
    // name carries the reason for anyone who can't see the amber border.
    expect(trigger.getAttribute("aria-label")).toMatch(/will not accept 31s/i);
  });

  it("saves the exact length chosen, with no clamping in between", async () => {
    const user = userEvent.setup();
    const { updateSceneDuration } = await import("@/actions/brief");
    renderTable([scene({ duration_s: 8 })]);

    await user.click(screen.getByRole("combobox", { name: /clip length/i }));
    await user.click(screen.getByRole("option", { name: "12s" }));

    await waitFor(() => {
      expect(vi.mocked(updateSceneDuration)).toHaveBeenCalledWith("scene-1", 12);
    });
  });
});

// The control was called "Apply", which says nothing about what it does to
// what is already there. applyScenePrompt (actions/brief.ts) overwrites
// video_prompt wholesale and sets edited_by_human back to false — no merge,
// no guard — and an operator lost a hand-edited prompt to exactly that gap
// between the name and the behaviour.
describe("SceneTable — the rewrite control says what it does", () => {
  it("is named for rewriting, not for applying", () => {
    renderTable([scene({ script_line: "Two cups and my hands would shake." })]);

    expect(screen.getByRole("button", { name: /rewrite with ai/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^apply/i })).toBeNull();
  });

  it("still quotes the price on the button, before the click", () => {
    renderTable([scene({ script_line: "Two cups and my hands would shake." })]);

    expect(screen.getByRole("button", { name: /rewrite with ai \(\$/i })).toBeTruthy();
  });

  it("warns on hover that a hand-edited prompt will be discarded", () => {
    renderTable([scene({ script_line: "A line.", edited_by_human: true })]);

    const button = screen.getByRole("button", { name: /rewrite with ai/i });
    expect(button.getAttribute("title")).toMatch(/discards your edit/i);
  });

  it("says nothing extra when there is no edit to lose", () => {
    renderTable([scene({ script_line: "A line.", edited_by_human: false })]);

    expect(
      screen.getByRole("button", { name: /rewrite with ai/i }).getAttribute("title"),
    ).toBeNull();
  });
});

// Rewrite with AI and Split are the two paid Claude calls this table makes,
// and both are per-scene. The rail is the only thing still on screen once
// the operator scrolls away from the row or opens another step, so the
// row's own spinner is not enough on its own.
describe("SceneTable — the paid per-scene calls report to the rail", () => {
  const railModel: RailModel = {
    projectId: "proj-1",
    readOnly: false,
    projectTitle: "Kinoko Coffee",
    projectSubtitle: "1 scene",
    backHref: "/projects",
    groups: [
      {
        id: "scenes",
        label: "Scenes",
        entries: [
          { id: "scene-1", label: "1 · A-roll", status: "idle", href: "/projects/1/scenes/1" },
        ],
      },
    ],
  };

  function renderWithRail(): void {
    render(
      <RailBusyProvider>
        <SceneTable
          projectId="project-1"
          initialScenes={[scene({ id: "scene-1", script_line: "She lifts the cup" })]}
          audioEnabled={false}
          renderSettings={DEFAULT_RENDER_SETTINGS}
          applySceneCostUsd={0.01}
        />
        <ProjectRail model={railModel} />
      </RailBusyProvider>,
    );
  }

  function railSpinning(): boolean {
    return screen.getByLabelText("Project navigation").querySelector("svg.animate-spin") !== null;
  }

  it("spins the scene's row while Rewrite with AI runs", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => {};
    vi.mocked(applyScenePrompt).mockReturnValue(
      new Promise((resolve) => {
        settle = () => resolve(undefined);
      }),
    );

    renderWithRail();
    expect(railSpinning()).toBe(false);

    await user.click(screen.getByRole("button", { name: /rewrite with ai/i }));
    await waitFor(() => expect(railSpinning()).toBe(true));

    await act(async () => {
      settle();
    });
    await waitFor(() => expect(railSpinning()).toBe(false));
  });

  it("spins it for Split too — two compiles, one press", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => {};
    vi.mocked(splitScene).mockReturnValue(
      new Promise((resolve) => {
        settle = () => resolve(undefined);
      }),
    );

    renderWithRail();

    await user.click(screen.getByRole("button", { name: /^split$/i }));
    await waitFor(() => expect(railSpinning()).toBe(true));

    await act(async () => {
      settle();
    });
    await waitFor(() => expect(railSpinning()).toBe(false));
  });
});

// Same rule as the frames grid: a column header is not a label, and thirty
// rows of identically-named fields are as good as unnamed.
describe("SceneTable — the row fields are named", () => {
  it("names both text fields by the scene they belong to", () => {
    renderTable([scene({ id: "scene-1" }), scene({ id: "scene-2", idx: 1 })]);

    expect(screen.getByRole("textbox", { name: "Script line for scene 1" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Video prompt for scene 1" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Script line for scene 2" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Video prompt for scene 2" })).toBeTruthy();
  });
});

// Editors reported deleting a scene had no confirmation. deleteScene only
// ever takes a draft/frame_ready scene (nothing rendered yet), which is why
// this guard's wording is the milder one — see scene-workbench.tsx:479 for
// the sibling confirm on a scene that may already have rendered.
describe("SceneTable — delete asks first", () => {
  it("cancelling leaves the row present and calls no action", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderTable([scene({ id: "scene-1", idx: 0, status: "draft" })]);

    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(confirmSpy).toHaveBeenCalledWith("Delete scene 1? Everything typed on it goes with it.");
    // The guard runs BEFORE the optimistic removal — a cancel that ran after
    // it would still have blanked the row on screen regardless of the answer.
    expect(screen.getByRole("textbox", { name: "Script line for scene 1" })).toBeTruthy();
    expect(deleteScene).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("confirming proceeds with the delete", async () => {
    // Not asserting the row is gone here: useOptimistic's removal reverts to
    // `initialScenes` — an actual prop, unchanged in this test — once the
    // mocked action's promise settles, since nothing here plays the part of
    // the revalidatePath that would land the removal for real. What this
    // guard promises is that confirming lets the call through at all.
    const user = userEvent.setup();
    vi.mocked(deleteScene).mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderTable([scene({ id: "scene-1", idx: 0, status: "draft" })]);

    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(deleteScene).toHaveBeenCalledWith("scene-1"));
    confirmSpy.mockRestore();
  });
});
