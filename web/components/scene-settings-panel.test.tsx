// @vitest-environment jsdom
//
// The panel had no tests, which is how the version-switch bug reached the
// operator ("bakit di nag-uupdate pag nag change ako ng version?"): a
// useState seeded from a prop it then ignored forever. Everything pinned
// here is a defect this component actually shipped, not a hypothetical.
//
// The server actions are mocked for the same reason render-gate.test.tsx
// mocks them: the real modules pull in next/headers-backed Supabase
// construction that throws outside a request, and none of it is under test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SceneSettingsPanel, type SceneSettingsPanelProps } from "./scene-settings-panel";
import { RailBusyProvider, useRailBusySetter } from "@/components/project-rail";
import { useEffect } from "react";
import { KLING_3_PRO, SEEDANCE_2_5, SEEDANCE_2_5_BYTEPLUS, pickModel } from "@/lib/models";

const updateSceneRenderOverride = vi.fn();
const clearSceneRenderOverride = vi.fn();
const updateSceneDuration = vi.fn();
const toggleTalkingHead = vi.fn();

vi.mock("@/actions/render-settings", () => ({
  updateSceneRenderOverride: (...args: unknown[]) => updateSceneRenderOverride(...args),
  clearSceneRenderOverride: (...args: unknown[]) => clearSceneRenderOverride(...args),
}));

vi.mock("@/actions/brief", () => ({
  toggleTalkingHead: (...args: unknown[]) => toggleTalkingHead(...args),
  updateSceneDuration: (...args: unknown[]) => updateSceneDuration(...args),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

beforeEach(() => {
  updateSceneRenderOverride.mockReset().mockResolvedValue(undefined);
  clearSceneRenderOverride.mockReset().mockResolvedValue(undefined);
  updateSceneDuration.mockReset().mockResolvedValue(undefined);
  toggleTalkingHead.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

function props(overrides: Partial<SceneSettingsPanelProps> = {}): SceneSettingsPanelProps {
  return {
    projectId: "p-1",
    sceneId: "s-1",
    durationS: 8,
    // A FRESH object each call, exactly as mergeRenderSettings builds one on
    // every server render — the shape the by-value resync check exists for.
    initialSettings: {
      model: SEEDANCE_2_5.id,
      resolution: SEEDANCE_2_5.defaultResolution,
      fps: SEEDANCE_2_5.defaultFps,
    },
    initialIsOverridden: false,
    editable: true,
    isTalkingHead: true,
    audioEnabled: true,
    lengthEditable: true,
    status: "draft",
    ...overrides,
  };
}

function button(name: string | RegExp): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

describe("SceneSettingsPanel — published price source", () => {
  it("labels the BytePlus estimate with BytePlus ModelArk pricing", () => {
    render(
      <SceneSettingsPanel
        {...props({
          initialSettings: {
            model: SEEDANCE_2_5_BYTEPLUS.id,
            resolution: "480p",
            fps: SEEDANCE_2_5_BYTEPLUS.defaultFps,
          },
        })}
      />,
    );

    expect(screen.getByText(/BytePlus ModelArk’s published token price/i)).toBeTruthy();
    expect(screen.queryByText(/kie’s published rate/i)).toBeNull();
  });
});

describe("SceneSettingsPanel — re-syncing to the server", () => {
  it("shows the new settings when the page re-renders with different ones", () => {
    // Switching scene versions writes the version's recorded settings back
    // onto the scene (0059) and re-renders this panel with them. Before the
    // serverKey check, the panel kept showing the version it mounted with.
    const { rerender } = render(<SceneSettingsPanel {...props()} />);
    expect(button(SEEDANCE_2_5.label).getAttribute("data-slot")).toBe("button");

    rerender(
      <SceneSettingsPanel
        {...props({
          initialSettings: {
            model: KLING_3_PRO.id,
            resolution: "1080p",
            fps: KLING_3_PRO.defaultFps,
          },
          initialIsOverridden: true,
        })}
      />,
    );

    // Kling is now the PICKED model, and picked is what carries the
    // selected state.
    expect(button(KLING_3_PRO.label).className).toContain("bg-primary");
    expect(button(SEEDANCE_2_5.label).className).not.toContain("bg-primary");
  });

  it("surfaces the reset control once the server says the scene is overridden", () => {
    const { rerender } = render(<SceneSettingsPanel {...props()} />);
    expect(screen.queryByRole("button", { name: /Return to project default/ })).toBeNull();

    rerender(<SceneSettingsPanel {...props({ initialIsOverridden: true })} />);
    expect(screen.getByRole("button", { name: /Return to project default/ })).toBeTruthy();
  });

  it("does not loop when re-rendered with an equal-but-fresh settings object", () => {
    // The first version of the resync compared by reference. Since
    // mergeRenderSettings builds a new object every render, that reset state
    // on every render and re-rendered forever. A render that returns at all
    // is the assertion.
    const { rerender } = render(<SceneSettingsPanel {...props()} />);
    rerender(<SceneSettingsPanel {...props()} />);
    rerender(<SceneSettingsPanel {...props()} />);
    expect(button(SEEDANCE_2_5.label)).toBeTruthy();
  });
});

describe("SceneSettingsPanel — substitution", () => {
  // These two used to assert the substitution NOTICE — one for a B-roll
  // scene ("only pays off on a talking-head scene"), one for an audio-off
  // account ("needs audio, which is off for this account"). Neither
  // substitution happens now, so neither sentence should appear: a Kling
  // project renders every scene on Kling, silently where the scene is not
  // talking-head, because 18 credits a second at 1080p beats the 63 at 720p
  // it used to fall back to.
  //
  // Asserting the ABSENCE is the point. A notice explaining a fallback that
  // no longer occurs is worse than no notice — it tells an operator their
  // clip is rendering on a model it isn't, at a price it won't be charged.
  it.each([
    ["a B-roll scene", { isTalkingHead: false, audioEnabled: true }],
    [
      "a talking-head scene with audio off account-wide",
      { isTalkingHead: true, audioEnabled: false },
    ],
    ["a B-roll scene with audio off account-wide", { isTalkingHead: false, audioEnabled: false }],
  ])("says nothing about a fallback on %s of a Kling project", (_name, overrides) => {
    render(
      <SceneSettingsPanel
        {...props({
          ...overrides,
          initialSettings: {
            model: KLING_3_PRO.id,
            resolution: KLING_3_PRO.defaultResolution,
            fps: KLING_3_PRO.defaultFps,
          },
        })}
      />,
    );
    expect(screen.queryByText(/will render on/)).toBeNull();
    expect(screen.queryByText(/only pays off on a talking-head scene/)).toBeNull();
    expect(screen.queryByText(/needs audio, which is off/)).toBeNull();
  });

  it("says nothing when the picked model is the one that will render", () => {
    render(<SceneSettingsPanel {...props()} />);
    expect(screen.queryByText(/will render on|It will render on/)).toBeNull();
  });

  it("keeps the substitute itself clickable", async () => {
    // Comparing against the EFFECTIVE model made the substitute unclickable:
    // pick Kling on a silent scene and Seedance renders, so Seedance — the
    // one model you would want to return to — was the only button with no
    // handler.
    render(
      <SceneSettingsPanel
        {...props({
          isTalkingHead: false,
          initialSettings: {
            model: KLING_3_PRO.id,
            resolution: "1080p",
            fps: KLING_3_PRO.defaultFps,
          },
        })}
      />,
    );
    // Clicking it, not merely reading `disabled`: the bug was a missing
    // onClick, and the disabled attribute is computed from the descriptor
    // and the gate — it stayed false throughout. Asserting enabledness here
    // would pass against the broken version.
    fireEvent.click(button(SEEDANCE_2_5.label));
    await waitFor(() => expect(updateSceneRenderOverride).toHaveBeenCalled());
    expect(updateSceneRenderOverride.mock.calls[0]![1]).toMatchObject({
      model: SEEDANCE_2_5.id,
      // The EFFECTIVE model's defaults, which is the $9.20 regression: Kling
      // offers 1080p only, so picking it wrote resolution=1080p, and
      // Seedance — which actually rendered — bills 1080p at $1.1497/s
      // against its own 720p default of $0.315.
      resolution: SEEDANCE_2_5.defaultResolution,
      fps: SEEDANCE_2_5.defaultFps,
    });
  });

  it("writes the EFFECTIVE model's resolution, whichever model that turns out to be", async () => {
    // THE $9.20 regression, in one click. Kling offers 1080p only, so
    // picking it on a silent scene wrote resolution=1080p — and pickModel
    // then substituted Seedance 2.5, which bills 1080p at $1.1497/s against
    // its own 720p default of $0.315. Eight times the advertised rate, from
    // a setting the operator never chose, forced by a model that was never
    // going to run.
    //
    // The substitution that caused it is gone: a silent Kling scene stays on
    // Kling now. So this asserts the INVARIANT rather than the old literal —
    // the resolution written must be the default of whatever pickModel says
    // will render. Pinning SEEDANCE_2_5.defaultResolution here would have
    // been pinning the fallback, not the rule, and would have had to be
    // rewritten again the next time routing moved.
    render(<SceneSettingsPanel {...props({ isTalkingHead: false })} />);

    fireEvent.click(button(KLING_3_PRO.label));
    await waitFor(() => expect(updateSceneRenderOverride).toHaveBeenCalled());

    const written = updateSceneRenderOverride.mock.calls[0]![1] as {
      model: string;
      resolution: string;
    };
    // The picked model is still what gets stored — any substitution is
    // decided at render time, not baked into the write.
    expect(written.model).toBe(KLING_3_PRO.id);

    const effective = pickModel(false, true, { model: KLING_3_PRO.id });
    expect(written.resolution).toBe(effective.defaultResolution);
    // And the resolution written must be one the effective model can
    // actually render — the specific thing whose absence cost $9.20.
    expect(effective.allowedResolutions).toContain(written.resolution);
  });
});

describe("SceneSettingsPanel — read-only while the worker owns the scene", () => {
  for (const status of ["queued", "rendering"] as const) {
    it(`explains why the panel is inert while ${status}`, () => {
      render(<SceneSettingsPanel {...props({ status, editable: false, lengthEditable: false })} />);
      expect(screen.getByText(new RegExp(`This scene is ${status}`))).toBeTruthy();
    });

    it(`disables the model row while ${status}`, () => {
      render(<SceneSettingsPanel {...props({ status, editable: false, lengthEditable: false })} />);
      expect(button(SEEDANCE_2_5.label).disabled).toBe(true);
      expect(button(KLING_3_PRO.label).disabled).toBe(true);
    });
  }

  it("shows no banner on a draft scene", () => {
    render(<SceneSettingsPanel {...props()} />);
    expect(screen.queryByText(/read-only until the render finishes/)).toBeNull();
  });

  it("locks Audio on a rendered scene while leaving the model row open", () => {
    // Two predicates that must never merge: updateSceneRenderOverride accepts
    // a scene that has already rendered, toggleTalkingHead does not.
    render(<SceneSettingsPanel {...props({ status: "done", lengthEditable: false })} />);
    expect(button(/A-roll/).disabled).toBe(true);
    expect(button(/B-roll/).disabled).toBe(true);
    expect(button(KLING_3_PRO.label).disabled).toBe(false);
  });
});

describe("SceneSettingsPanel — work running in the workbench beside it", () => {
  /** Marks the scene busy in the rail store, as a workbench action would. */
  function MarkBusy({ sceneId }: { sceneId: string }): null {
    const setRailBusy = useRailBusySetter();
    useEffect(() => {
      setRailBusy(sceneId, true);
    }, [sceneId, setRailBusy]);
    return null;
  }

  it("locks the settings while something else is writing to the scene", () => {
    // The frame regeneration is what a render is priced against, so a model
    // or length changed underneath it settles onto a row mid-write.
    render(
      <RailBusyProvider>
        <MarkBusy sceneId="s-1" />
        <SceneSettingsPanel {...props()} />
      </RailBusyProvider>,
    );

    expect(button(KLING_3_PRO.label).disabled).toBe(true);
    expect(button(/A-roll/).disabled).toBe(true);
  });

  it("says why, and not with the worker's sentence", () => {
    // Two different answers to "when does this come back": the worker owning
    // a queued scene, and a call the operator just started. Same greyed rows.
    render(
      <RailBusyProvider>
        <MarkBusy sceneId="s-1" />
        <SceneSettingsPanel {...props()} />
      </RailBusyProvider>,
    );

    expect(screen.getByText(/Something is still running on this scene/)).toBeTruthy();
    expect(screen.queryByText(/read-only until the render finishes/)).toBeNull();
  });

  it("leaves the panel alone when nothing is running", () => {
    render(
      <RailBusyProvider>
        <SceneSettingsPanel {...props()} />
      </RailBusyProvider>,
    );

    expect(button(KLING_3_PRO.label).disabled).toBe(false);
    expect(screen.queryByText(/Something is still running/)).toBeNull();
  });
});
