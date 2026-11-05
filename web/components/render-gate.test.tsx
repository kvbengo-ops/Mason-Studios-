// @vitest-environment jsdom
//
// Finding 3 (code review): RenderGate used to price the whole batch with
// one estimateCost(toBrief(scenes), audioEnabled, settings) call, applying
// the operator's picked model/resolution/fps uniformly to every scene. But
// enqueueRender (actions/enqueue.ts) prices per EFFECTIVE-settings group
// (groupByEffectiveSettings/estimateUsdForScenes, lib/estimate.ts) — a scene
// carrying a render_settings_override from an earlier retry (0045: sticky,
// and unfreezeScene can put it back to 'draft' where scenesAwaitingRender
// picks it up again) keeps its own model regardless of what this card says.
// This file pins that the gate's headline total accounts for a mix of
// overridden and non-overridden scenes, agreeing with what the server would
// actually check the spend caps against. "@/actions/enqueue" and
// "@/actions/render-settings" are mocked for the same reason
// render-progress.test.tsx mocks actions/enqueue: importing the real modules
// pulls in next/headers-backed Supabase client construction that throws
// outside an actual request, none of which is what's under test.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RenderGate, type RenderGateScene } from "./render-gate";
import { HAILUO_2_3_PRO, KLING_3_PRO, SEEDANCE_2_5 } from "@/lib/models";
import type { RenderBudgetFigures } from "@/lib/render-budget";

vi.mock("@/actions/enqueue", () => ({
  enqueueRender: vi.fn(),
  enqueueTestScene: vi.fn(),
}));

vi.mock("@/actions/render-settings", () => ({
  updateRenderSettings: vi.fn(),
}));

afterEach(() => {
  cleanup();
});

const BUDGET: RenderBudgetFigures = {
  dailyRemainingUsd: 100,
  dailyCapUsd: 100,
  weeklyRemainingUsd: 100,
  weeklyCapUsd: 100,
  globalRemainingUsd: 100,
  globalCapUsd: 100,
};

function scene(overrides: Partial<RenderGateScene>): RenderGateScene {
  return {
    script_line: "line",
    video_prompt: "prompt",
    is_talking_head: false,
    duration_s: 5,
    render_settings_override: null,
    ...overrides,
  };
}

describe("RenderGate — batch estimate accounts for per-scene overrides (Finding 3)", () => {
  it("sums a mixed batch per effective-settings group, not uniformly at the project's own settings", () => {
    // Project is Seedance 2.5 @ 720p ($0.315/s, a receipt — see
    // lib/kie/rates.ts). Scene b was moved onto Kling earlier through the
    // scene settings picker (actions/render-settings.ts's
    // updateSceneRenderOverride) — NOT a retry: RenderSettingsOverrideSchema,
    // the retry path's own shape (actions/enqueue.ts), is model-only and
    // could never write the explicit resolution this fixture carries. Scene
    // b is talking-head + audio on, so it bills at Kling's measured SOUND
    // rate ($0.135/s) instead — kie bills exactly the seconds requested, no
    // multiplier. A flat estimateCost() over both scenes at the project's
    // settings alone would have quoted (5 + 5) * $0.315 = $3.15 — the bug
    // this test pins. The correct total groups scene b at its own effective
    // settings: 5*$0.315 + 5*$0.135 = $1.575 + $0.675 = $2.25.
    //
    // The override names Kling's OWN resolution explicitly (pro/1080p),
    // not just its model, since 2026-09-10: Kling now has a second tier
    // (std/720p, 20 cr/s), and an override naming `model` alone (the shape a
    // retry's RenderSettingsOverrideSchema is limited to) would inherit the
    // PROJECT's raw resolution (720p) — which is now also a legal KLING
    // tier, so it would price this scene at std's cheaper rate instead of
    // the $0.135/s this test is about. That inheritance is real and correct
    // (mergeRenderSettings/billingResolution — see lib/estimate.test.ts's
    // own Kling-resolution cases); this test pins a different thing
    // (per-scene grouping) and names the tier outright so the two do not
    // get entangled.
    render(
      <RenderGate
        projectId="proj-1"
        scenes={[
          scene({ duration_s: 5, is_talking_head: false, render_settings_override: null }),
          scene({
            duration_s: 5,
            is_talking_head: true,
            render_settings_override: {
              model: KLING_3_PRO.id,
              resolution: KLING_3_PRO.defaultResolution,
            },
          }),
        ]}
        audioEnabled={true}
        initialSettings={{ model: SEEDANCE_2_5.id, resolution: "720p", fps: 24 }}
        budget={BUDGET}
        allFramed={true}
        readOnly={false}
      />,
    );
    expect(screen.getByText("$2.25")).toBeTruthy();
    expect(screen.queryByText("$3.15")).toBeNull();
  });

  it("prices a batch with no overrides the same as before — one group, the project's own settings", () => {
    render(
      <RenderGate
        projectId="proj-1"
        scenes={[
          scene({ duration_s: 5, render_settings_override: null }),
          scene({ duration_s: 5, render_settings_override: null }),
        ]}
        audioEnabled={false}
        initialSettings={{ model: SEEDANCE_2_5.id, resolution: "720p", fps: 24 }}
        budget={BUDGET}
        allFramed={true}
        readOnly={false}
      />,
    );
    // 10s * $0.315/s = $3.15.
    expect(screen.getByText("$3.15")).toBeTruthy();
  });

  it("tells the operator when a scene already carries its own model and won't move with the picker", () => {
    render(
      <RenderGate
        projectId="proj-1"
        scenes={[
          scene({ render_settings_override: null }),
          scene({ render_settings_override: { model: KLING_3_PRO.id }, is_talking_head: true }),
        ]}
        audioEnabled={true}
        initialSettings={{
          model: SEEDANCE_2_5.id,
          resolution: SEEDANCE_2_5.defaultResolution,
          fps: SEEDANCE_2_5.defaultFps,
        }}
        budget={BUDGET}
        allFramed={true}
        readOnly={false}
      />,
    );
    expect(screen.getByText(/1 scene already carrying its own model/)).toBeTruthy();
  });

  it("says nothing about overrides when no scene carries one", () => {
    render(
      <RenderGate
        projectId="proj-1"
        scenes={[scene({}), scene({})]}
        audioEnabled={false}
        initialSettings={{
          model: SEEDANCE_2_5.id,
          resolution: SEEDANCE_2_5.defaultResolution,
          fps: SEEDANCE_2_5.defaultFps,
        }}
        budget={BUDGET}
        allFramed={true}
        readOnly={false}
      />,
    );
    expect(screen.queryByText(/already carrying its own model/)).toBeNull();
  });
});

// findUnrenderableDurations's own warning line: the compiler is told to
// prefer longer scenes and can emit up to 15s, while Hailuo accepts only 6
// or 10 seconds — so a brief that looked fine on the default can silently
// stop being renderable the moment the operator switches to it. The gate
// has to say so BEFORE the click, with the same facts assertRenderableDurations
// would refuse the click with (lib/enqueue-guard.ts's findUnrenderableDurations
// doc comment).
describe("RenderGate — unrenderable-duration warning", () => {
  it("warns naming the count and the offending duration when the selected model can't render a scene's length", () => {
    render(
      <RenderGate
        projectId="proj-1"
        // 20s is legal on Seedance/Kling (the compiler's own range) but
        // outside Hailuo's {6, 10} set entirely — exactly the "looked
        // fine, then doesn't" case this warning exists to catch at
        // model-selection time.
        scenes={[scene({ duration_s: 20 })]}
        audioEnabled={false}
        initialSettings={{
          model: HAILUO_2_3_PRO.id,
          resolution: HAILUO_2_3_PRO.defaultResolution,
          fps: HAILUO_2_3_PRO.defaultFps,
        }}
        budget={BUDGET}
        allFramed={true}
        readOnly={false}
      />,
    );
    expect(screen.getByText(/1 scene is 20s/)).toBeTruthy();
  });

  it("shows no warning when every scene's duration fits the selected model", () => {
    render(
      <RenderGate
        projectId="proj-1"
        scenes={[scene({ duration_s: 6 })]}
        audioEnabled={false}
        initialSettings={{
          model: HAILUO_2_3_PRO.id,
          resolution: HAILUO_2_3_PRO.defaultResolution,
          fps: HAILUO_2_3_PRO.defaultFps,
        }}
        budget={BUDGET}
        allFramed={true}
        readOnly={false}
      />,
    );
    expect(screen.queryByText(/will not accept/)).toBeNull();
  });

  // Pins that the "it takes N seconds" half of the warning is read off
  // HAILUO_2_3_PRO.allowedDurationsS itself, not a hand-copied literal in
  // render-gate.tsx — a change to the descriptor's allowed set must change
  // this text without anyone having to remember to also edit the component.
  it("derives the allowed-durations text from the descriptor's own allowedDurationsS, not a hardcoded literal", () => {
    render(
      <RenderGate
        projectId="proj-1"
        scenes={[scene({ duration_s: 20 })]}
        audioEnabled={false}
        initialSettings={{
          model: HAILUO_2_3_PRO.id,
          resolution: HAILUO_2_3_PRO.defaultResolution,
          fps: HAILUO_2_3_PRO.defaultFps,
        }}
        budget={BUDGET}
        allFramed={true}
        readOnly={false}
      />,
    );
    expect(
      screen.getByText(
        new RegExp(`it takes ${HAILUO_2_3_PRO.allowedDurationsS.join(", ")} seconds`),
      ),
    ).toBeTruthy();
  });
});

// Kling's std/720p tier shipped with a sound rate but no silent one — every
// B-roll (non-talking-head, silent) scene on a std/720p Kling project priced
// at +Infinity, which the Resolution row's per-second label rendered as a
// literal "$∞" (Intl.NumberFormat's own spelling of Infinity). Fixed by
// giving kling-3.0-pro.silent["720p"] a rate (lib/kie/rates.ts) — this pins
// that the 720p button shows a real, finite number again, not a dollar sign
// glued to an infinity symbol.
describe("RenderGate — Kling's 720p tier prices finitely, not +Infinity", () => {
  it("shows a real per-second price on the 720p resolution button, not $∞", () => {
    render(
      <RenderGate
        projectId="proj-1"
        scenes={[scene({ duration_s: 4, is_talking_head: false })]}
        audioEnabled={false}
        initialSettings={{ model: KLING_3_PRO.id, resolution: "720p", fps: KLING_3_PRO.defaultFps }}
        budget={BUDGET}
        allFramed={true}
        readOnly={false}
      />,
    );
    const resolutionButton = screen.getByRole("button", { name: /720p/ });
    expect(resolutionButton.textContent).not.toMatch(/∞|Infinity/);
    // 14 cr/s / 200 credits-per-$ = $0.07/s — the silent std/720p receipt.
    expect(resolutionButton.textContent).toContain("$0.07");
  });
});
