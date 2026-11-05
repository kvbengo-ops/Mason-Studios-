// @vitest-environment jsdom
import { act, render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneWorkbench, type SceneWorkbenchProps } from "./scene-workbench";
import { ProjectRail, RailBusyProvider } from "@/components/project-rail";
import type { RailModel } from "@/lib/project-rail-types";
import * as framesActions from "@/actions/frames";
import * as briefActions from "@/actions/brief";
import * as enqueueActions from "@/actions/enqueue";
import * as renderSettingsActions from "@/actions/render-settings";
import type * as NextNavigation from "next/navigation";
import type { Database } from "@/types/db";

type SceneRow = Database["public"]["Tables"]["scenes"]["Row"];
type AssetRow = Database["public"]["Tables"]["assets"]["Row"];

// Mock the server actions
vi.mock("@/actions/frames");
vi.mock("@/actions/brief");
vi.mock("@/actions/enqueue");
vi.mock("@/actions/render-settings");

// The workbench refreshes itself while a render is in flight (see
// IN_FLIGHT_REFRESH_MS) and after every action that revalidates a route
// other than this one, so useRouter has to resolve in jsdom.
const refreshMock = vi.fn();
vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof NextNavigation>("next/navigation");
  return {
    ...actual,
    useRouter: (): { refresh: () => void } => ({ refresh: refreshMock }),
    // ProjectRail (rendered beside the workbench in the rail tests below)
    // stamps the current row from the pathname, and the real hook throws
    // outside an app-router context.
    usePathname: (): string => "/projects/project-1/scenes/1",
  };
});

const mockUpdateScenePromptAndRegenerate = vi.mocked(framesActions.updateScenePromptAndRegenerate);
const mockApplyScenePrompt = vi.mocked(briefActions.applyScenePrompt);
const mockRetryScene = vi.mocked(enqueueActions.retryScene);
const _mockUpdateScenePrompt = vi.mocked(briefActions.updateScenePrompt);
const _mockUpdateSceneRenderOverride = vi.mocked(renderSettingsActions.updateSceneRenderOverride);
const _mockClearSceneRenderOverride = vi.mocked(renderSettingsActions.clearSceneRenderOverride);

// Helper to check if element is disabled
function isDisabled(element: Element): boolean {
  return element.hasAttribute("disabled");
}

function createMockScene(overrides?: Partial<SceneRow>): SceneRow {
  return {
    id: "scene-1",
    project_id: "project-1",
    idx: 0,
    status: "frame_ready",
    script_line: "Test script line",
    video_prompt: "A person talking to camera",
    // 0072. Null is the normal state: only a scene whose prompt went
    // through Refine carries one.
    ai_generated_prompt: null,
    is_talking_head: true,
    duration_s: 10,
    ref_frame_asset_id: "frame-asset-1",
    // 0071. Null is the scripted pipeline's normal state: these are
    // snapshotted only by /ugc's generateClip, from a saved element.
    active_version_id: null,
    created_at: new Date().toISOString(),
    // 0063_scenes_dev_flag.sql — irrelevant to this component, which never
    // reads it; false (production) is the ordinary case for a fixture.
    dev: false,
    edited_by_human: false,
    kie_task_id: null,
    submitted_at: null,
    template_id: null,
    render_settings_override: null,
    visual_idea: null,
    ...overrides,
  };
}

function createMockClipAsset(overrides?: Partial<AssetRow>): AssetRow {
  return {
    id: "clip-asset-1",
    project_id: "project-1",
    scene_id: "scene-1",
    kind: "clip",
    storage_key: "clips/clip-1.mp4",
    created_at: new Date().toISOString(),
    duration_s: 10,
    bytes: null,
    position: 0,
    built_from_cut_order_at: null,
    // Project-backed, so no direct owner — assets.user_id (0085) is set only
    // on an asset that has no project.
    user_id: null,
    // Soft-delete marker from 0114_image_bin_and_notifications.sql. Null is
    // the ordinary case: a live asset, which is what this fixture stands for.
    deleted_at: null,
    ...overrides,
  };
}

/**
 * Every prop the workbench needs, at sane defaults. The suite used to
 * repeat all fifteen of these inline in every single test, which is how a
 * new prop turns into a twenty-file diff and how a test ends up asserting
 * against a fixture nobody re-read.
 */
function props(overrides?: Partial<SceneWorkbenchProps>): SceneWorkbenchProps {
  return {
    scene: createMockScene(),
    refFrameUrl: "https://example.com/frame.jpg",
    clipAsset: null,
    clipUrl: null,
    isOwner: true,
    frameCostUsd: 0.04,
    rewriteCostUsd: 0.01,
    clipCostUsd: 1.89,
    clipSettingsLabel: "Seedance 2.5 · 720p · 10s",
    clipSpentUsd: 0,
    clipVendor: "kie",
    clipHasAudio: true,
    vendorBalanceLabel: "442 cr",
    failure: null,
    versions: [],
    activeVersionId: null,
    budget: {
      dailyRemainingUsd: 100,
      dailyCapUsd: 100,
      weeklyRemainingUsd: 500,
      weeklyCapUsd: 500,
      globalRemainingUsd: 1000,
      globalCapUsd: 1000,
    },
    ...overrides,
  };
}

beforeEach(() => {
  refreshMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SceneWorkbench", () => {
  describe("Clip rendering", () => {
    it("renders clip player when clip exists", () => {
      render(
        <SceneWorkbench
          {...props({
            scene: createMockScene({ status: "done" }),
            clipAsset: createMockClipAsset(),
            clipUrl: "https://example.com/clip.mp4",
          })}
        />,
      );

      const video = document.querySelector("video");
      expect(video).toBeTruthy();
      if (video) {
        expect(video.hasAttribute("controls")).toBe(true);
      }
    });

    it("renders placeholder when no clip exists", () => {
      render(<SceneWorkbench {...props({ scene: createMockScene({ status: "frame_ready" }) })} />);

      expect(screen.getByText(/No clip yet/)).toBeTruthy();
    });
  });

  describe("In-flight scenes", () => {
    it("disables edit and re-render when scene is queued", () => {
      render(<SceneWorkbench {...props({ scene: createMockScene({ status: "queued" }) })} />);

      const textarea = screen.getByPlaceholderText("Video prompt");
      expect(isDisabled(textarea)).toBe(true);

      expect(screen.queryByRole("button", { name: /re-render/i })).toBeNull();
      // The header chip and the empty clip slot both name the state, so
      // scope this to the chip rather than asserting a unique match.
      expect(screen.getByRole("status").textContent).toContain("Queued for rendering");
    });

    it("disables edit and re-render when scene is rendering", () => {
      render(<SceneWorkbench {...props({ scene: createMockScene({ status: "rendering" }) })} />);

      const textarea = screen.getByPlaceholderText("Video prompt");
      expect(isDisabled(textarea)).toBe(true);
      expect(screen.queryByRole("button", { name: /re-render/i })).toBeNull();
      expect(screen.getByRole("status").textContent).toContain("Rendering");
    });

    it("enables edit when scene is frame_ready", () => {
      render(<SceneWorkbench {...props({ scene: createMockScene({ status: "frame_ready" }) })} />);

      const textarea = screen.getByPlaceholderText("Video prompt");
      expect(isDisabled(textarea)).toBe(false);
    });
  });

  describe("Action buttons styling and pricing", () => {
    it("shows prices on regenerate frame button", () => {
      render(<SceneWorkbench {...props({ scene: createMockScene({ status: "frame_ready" }) })} />);

      expect(screen.getByText(/Regenerate frame — \$0\.04/)).toBeTruthy();
    });

    it("shows price on re-render button for a done scene", () => {
      render(
        <SceneWorkbench
          {...props({
            scene: createMockScene({ status: "done" }),
            clipAsset: createMockClipAsset(),
            clipUrl: "https://example.com/clip.mp4",
          })}
        />,
      );

      expect(screen.getByRole("button", { name: /Re-render — \$1\.89/ })).toBeTruthy();
    });
  });

  describe("Owner vs non-owner access", () => {
    it("hides re-render button for non-owner", () => {
      render(
        <SceneWorkbench
          {...props({
            scene: createMockScene({ status: "done" }),
            clipAsset: createMockClipAsset(),
            clipUrl: "https://example.com/clip.mp4",
            isOwner: false,
          })}
        />,
      );

      expect(screen.queryByRole("button", { name: /re-render/i })).toBeNull();
    });

    it("disables prompt editing for non-owner", () => {
      render(<SceneWorkbench {...props({ isOwner: false })} />);

      const textarea = screen.getByPlaceholderText("Video prompt");
      expect(isDisabled(textarea)).toBe(true);
    });

    it("enables prompt editing for owner", () => {
      render(<SceneWorkbench {...props({ isOwner: true })} />);

      const textarea = screen.getByPlaceholderText("Video prompt");
      expect(isDisabled(textarea)).toBe(false);
    });
  });

  describe("Reference frame display", () => {
    it("displays reference frame image when available", () => {
      render(<SceneWorkbench {...props()} />);

      const frameImage = screen.getByAltText(/Reference frame/);
      expect(frameImage).toBeTruthy();
      expect(frameImage.getAttribute("src")).toBe("https://example.com/frame.jpg");
    });

    it("displays placeholder when no reference frame", () => {
      render(<SceneWorkbench {...props({ refFrameUrl: null })} />);

      expect(screen.getByText("No frame yet")).toBeTruthy();
    });
  });
});

// useTransition's pending flag was discarded here, so nothing stopped a
// second click while the first regeneration was still running — two calls
// billed for one frame. Every other spending control on this screen already
// guarded itself.
describe("SceneWorkbench — the frame regeneration cannot be double-clicked", () => {
  it("disables the button and skeletons the frame while the call is in flight", async () => {
    let release: (value: undefined) => void = () => {};
    mockUpdateScenePromptAndRegenerate.mockReturnValue(
      new Promise((resolve) => {
        release = resolve as (value: undefined) => void;
      }),
    );
    const user = userEvent.setup();

    render(<SceneWorkbench {...props({ frameCostUsd: 0.02 })} />);

    const button = screen.getByRole("button", { name: /regenerate frame/i });
    await user.click(button);

    await waitFor(() => {
      const running = screen.getByRole("button", { name: /regenerate frame/i });
      expect((running as HTMLButtonElement).disabled).toBe(true);
      // No spinner ON the button, deliberately. The skeleton below stands
      // where the new frame will appear, and two indicators for one wait is
      // how a screen starts looking busy rather than reading as busy.
      expect(running.querySelector("svg.animate-spin")).toBeNull();
      expect(document.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    });
    // The point: one call, not two.
    expect(mockUpdateScenePromptAndRegenerate).toHaveBeenCalledTimes(1);

    release(undefined);
  });
});

// The prompt column had no action of any kind — the only way to regenerate a
// prompt was to leave the workbench for the Brief table, which is exactly
// the round trip this screen exists to remove. The label is load-bearing
// too: applyScenePrompt overwrites video_prompt wholesale and clears
// edited_by_human, and an operator lost a hand-edited prompt to a control
// labelled "Apply".
describe("SceneWorkbench — the prompt can be rewritten without leaving the screen", () => {
  it("offers a priced rewrite that names the edit it destroys, and calls applyScenePrompt", async () => {
    mockApplyScenePrompt.mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <SceneWorkbench
        {...props({ scene: createMockScene({ edited_by_human: true }), rewriteCostUsd: 0.01 })}
      />,
    );

    const button = screen.getByRole("button", { name: /rewrite with ai/i });
    expect(button.textContent).toContain("$0.01");
    expect(button.textContent).toContain("discards your edit");

    await user.click(button);
    await waitFor(() => expect(mockApplyScenePrompt).toHaveBeenCalledWith("scene-1"));
  });

  it("cannot be double-clicked into a second paid compile", async () => {
    let release: (value: undefined) => void = () => {};
    mockApplyScenePrompt.mockReturnValue(
      new Promise((resolve) => {
        release = resolve as (value: undefined) => void;
      }),
    );
    const user = userEvent.setup();

    render(<SceneWorkbench {...props()} />);

    const button = screen.getByRole("button", { name: /rewrite with ai/i });
    await user.click(button);

    await waitFor(() => {
      const running = screen.getByRole("button", { name: /rewrite with ai/i });
      expect((running as HTMLButtonElement).disabled).toBe(true);
      expect(running.querySelector("svg.animate-spin")).toBeTruthy();
    });
    await user.click(screen.getByRole("button", { name: /rewrite with ai/i }));
    expect(mockApplyScenePrompt).toHaveBeenCalledTimes(1);

    release(undefined);
  });
});

// A failed scene rendered identically to one that had never been submitted:
// no marker, no reason, and a clip slot reading "render to generate" over a
// render that was attempted and billed.
describe("SceneWorkbench — a failed scene says so", () => {
  it("shows the failure and its reason, and does not claim the render was never started", () => {
    render(
      <SceneWorkbench
        {...props({
          scene: createMockScene({ status: "failed" }),
          failure: {
            category: "retryable",
            retryable: true,
            message: "This looks like a transient failure (network, timeout).",
          },
        })}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("Render failed");
    expect(
      screen.getByText("This looks like a transient failure (network, timeout)."),
    ).toBeTruthy();
    expect(screen.queryByText(/No clip yet/)).toBeNull();
  });

  // Retry used to spend on this one press. It buys a whole new attempt at
  // the same price as the one that failed, so it is confirmed like every
  // other paid control on this screen — the press opens the question, and
  // only Confirm answers it.
  it("offers a priced Retry for a retryable failure, and the press only ASKS", async () => {
    mockRetryScene.mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <SceneWorkbench
        {...props({
          scene: createMockScene({ status: "failed" }),
          failure: { category: "retryable", retryable: true, message: "Transient." },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Retry — \$1\.89/ }));
    const dialog = await screen.findByRole("dialog");
    expect(
      mockRetryScene,
      "opening the confirm already queued the retry — the dialog is decoration",
    ).not.toHaveBeenCalled();

    // The number, and the three values that decide it.
    expect(dialog.textContent).toContain("$1.89");
    expect(dialog.textContent).toContain("Seedance 2.5 · 720p · 10s");

    await user.click(within(dialog).getByRole("button", { name: /^confirm/i }));
    await waitFor(() => expect(mockRetryScene).toHaveBeenCalledWith("scene-1"));
    expect(mockRetryScene).toHaveBeenCalledTimes(1);
  });

  it("cancelling the Retry confirm queues nothing", async () => {
    const user = userEvent.setup();

    render(
      <SceneWorkbench
        {...props({
          scene: createMockScene({ status: "failed" }),
          failure: { category: "retryable", retryable: true, message: "Transient." },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Retry — \$1\.89/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^cancel/i }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockRetryScene).not.toHaveBeenCalled();
  });

  it("a second Confirm press cannot buy a second attempt", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => {};
    mockRetryScene.mockReturnValue(
      new Promise((resolve) => {
        settle = () => resolve(undefined);
      }),
    );

    render(
      <SceneWorkbench
        {...props({
          scene: createMockScene({ status: "failed" }),
          failure: { category: "retryable", retryable: true, message: "Transient." },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Retry — \$1\.89/ }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: /^confirm/i });

    await user.click(confirm);
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.click(confirm);
    expect(mockRetryScene).toHaveBeenCalledTimes(1);

    settle();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("withholds Retry when classifyRenderError says a retry cannot succeed", () => {
    render(
      <SceneWorkbench
        {...props({
          scene: createMockScene({ status: "failed" }),
          failure: {
            category: "insufficient_balance",
            retryable: false,
            message: "The kie.ai account is out of credit.",
          },
        })}
      />,
    );

    expect(screen.queryByRole("button", { name: /^retry/i })).toBeNull();
    expect(screen.getByText(/Retry unavailable/)).toBeTruthy();
  });
});

// rerenderScene (lib/enqueue-guard.ts's assertSceneRerenderable) accepts
// 'done' and nothing else, but the button rendered for every non-in-flight
// status — a frame_ready scene was shown a priced Re-render whose only
// possible outcome was a server refusal.
describe("SceneWorkbench — Re-render is offered only where the action accepts it", () => {
  it.each(["draft", "frame_ready", "failed"] as const)(
    "does not offer Re-render for a %s scene",
    (status) => {
      render(
        <SceneWorkbench
          {...props({
            scene: createMockScene({ status }),
            failure:
              status === "failed"
                ? { category: "retryable", retryable: true, message: "Transient." }
                : null,
          })}
        />,
      );

      expect(screen.queryByRole("button", { name: /re-render/i })).toBeNull();
    },
  );

  it("offers Re-render for a done scene", () => {
    render(
      <SceneWorkbench
        {...props({
          scene: createMockScene({ status: "done" }),
          clipAsset: createMockClipAsset(),
          clipUrl: "https://example.com/clip.mp4",
        })}
      />,
    );

    expect(screen.getByRole("button", { name: /re-render/i })).toBeTruthy();
  });

  // Reopen is gone (scene-reopen-dialog.tsx was deleted on purpose): a
  // 'done' scene is nobody's but the operator's now. isSceneContentEditable
  // (lib/editable-guard.ts) refuses editing only while the worker owns the
  // scene — 'queued'/'rendering' — so a done scene can regenerate its frame
  // directly, no reopen step required.
  it("offers frame regeneration on a done scene directly, with no reopen path", () => {
    render(
      <SceneWorkbench
        {...props({
          scene: createMockScene({ status: "done" }),
          clipAsset: createMockClipAsset(),
          clipUrl: "https://example.com/clip.mp4",
        })}
      />,
    );

    expect(screen.getByRole("button", { name: /regenerate frame/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^reopen/i })).toBeNull();
  });
});

// A static "Currently rendering" cannot tell thirty seconds apart from
// thirty minutes, and scenes.submitted_at had been sitting unread on the row
// the whole time. One render finished and was billed while the app said
// "rendering" for eight minutes.
describe("SceneWorkbench — an in-flight render shows how long it has been running", () => {
  it("renders elapsed time from submitted_at, plus a moving indicator", async () => {
    const submittedAt = new Date(Date.now() - 130_000).toISOString(); // 2:10 ago

    render(
      <SceneWorkbench
        {...props({ scene: createMockScene({ status: "rendering", submitted_at: submittedAt }) })}
      />,
    );

    const status = await screen.findByRole("status");
    await waitFor(() => expect(status.textContent).toContain("2:10"));
    expect(status.querySelector("svg.animate-spin")).toBeTruthy();
  });

  it("shows no timer when the scene was never submitted", () => {
    render(
      <SceneWorkbench
        {...props({ scene: createMockScene({ status: "queued", submitted_at: null }) })}
      />,
    );

    expect(screen.getByRole("status").textContent).toBe("Queued for rendering");
  });
});

// The clip card showed "Duration: 10s" and nothing else: not whether it has
// sound, not who rendered it, not what it cost — the two an operator
// actually decides on.
describe("SceneWorkbench — the clip card says what the clip is", () => {
  it("names duration, audio, vendor and price", () => {
    render(
      <SceneWorkbench
        {...props({
          scene: createMockScene({ status: "done" }),
          clipAsset: createMockClipAsset({ duration_s: 6 }),
          clipUrl: "https://example.com/clip.mp4",
          clipHasAudio: true,
          clipVendor: "kie",
          clipCostUsd: 1.89,
        })}
      />,
    );

    expect(screen.getByText("6s")).toBeTruthy();
    expect(screen.getByText("audio on")).toBeTruthy();
    expect(screen.getByText("kie")).toBeTruthy();
    // "$1.89" also appears on the Re-render button's own price, so scope
    // to the clip meta row's price span via its title.
    expect(
      screen.getByTitle(
        "Estimated at this scene's current model and resolution — nothing billed yet.",
      ).textContent,
    ).toBe("$1.89");
  });

  it("says silent rather than claiming audio the render will not produce", () => {
    render(
      <SceneWorkbench
        {...props({
          scene: createMockScene({ status: "done" }),
          clipAsset: createMockClipAsset({ duration_s: 6 }),
          clipUrl: "https://example.com/clip.mp4",
          clipHasAudio: false,
        })}
      />,
    );

    expect(screen.getByText("silent")).toBeTruthy();
    expect(screen.queryByText("audio on")).toBeNull();
  });
});

// The workbench gave no confirmation that a debounced prompt save had
// landed — the Brief table's editor has had one all along.
describe("SceneWorkbench — a debounced prompt save reports itself", () => {
  it("shows Saving… then Saved once updateScenePrompt resolves", async () => {
    _mockUpdateScenePrompt.mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(<SceneWorkbench {...props()} />);

    await user.type(screen.getByPlaceholderText("Video prompt"), "!");
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy(), { timeout: 3000 });
  });
});

// A comment in this file used to claim the cheap and expensive controls are
// gated on disjoint states and can never both appear. That is no longer
// true: isSceneContentEditable (lib/editable-guard.ts) allows editing a
// 'done' scene's frame and prompt just like a 'frame_ready' one — only
// 'queued'/'rendering' shut editing off, because the worker owns the scene
// then. So a done scene offers both Regenerate frame and Re-render side by
// side, and both controls disappear once the scene is in flight.
describe("SceneWorkbench — frame regeneration and re-render on a done scene", () => {
  function namesFor(status: "frame_ready" | "done" | "queued" | "rendering"): string {
    render(
      <SceneWorkbench
        {...props({
          scene: createMockScene({ status }),
          clipAsset: status === "done" ? createMockClipAsset() : undefined,
          clipUrl: status === "done" ? "https://example.com/clip.mp4" : undefined,
        })}
      />,
    );
    return screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "")
      .join(" | ");
  }

  it("offers the frame regeneration on an editable scene, and no re-render", () => {
    const names = namesFor("frame_ready");

    expect(names).toMatch(/regenerate frame/i);
    expect(names).not.toMatch(/re-render/i);
  });

  it("offers both re-render and frame regeneration on a done scene", () => {
    const names = namesFor("done");

    expect(names).toMatch(/re-render/i);
    expect(names).toMatch(/regenerate frame/i);
  });

  it.each(["queued", "rendering"] as const)(
    "offers neither control while %s — the worker owns the scene",
    (status) => {
      const names = namesFor(status);

      expect(names).not.toMatch(/re-render/i);
      expect(names).not.toMatch(/regenerate frame/i);
    },
  );
});

// The card printed the list price at CURRENT settings and called it what the
// clip cost, on the stated reasoning that a rendered scene's settings are
// frozen. They are not — the model chip stays live on a done scene — so
// changing the model after a render rewrote the price of something already
// paid for. Same defect the Deliver page was fixed for.
describe("SceneWorkbench — the clip card shows what was billed", () => {
  function cardText(over: Partial<SceneWorkbenchProps>): string {
    render(
      <SceneWorkbench
        {...props({
          scene: createMockScene({ status: "done" }),
          clipAsset: createMockClipAsset(),
          clipUrl: "https://example.com/clip.mp4",
          ...over,
        })}
      />,
    );
    // Scoped to the figure itself, not the page: the Re-render button also
    // shows $1.89 and is right to — that is what a NEW render costs. The
    // claim under test is only about the number describing the clip that
    // already exists.
    const el = document.querySelector("[title*='billed'], [title*='Estimated']");
    return el?.textContent ?? "";
  }

  it("prints the billed total, not the current list price", () => {
    expect(cardText({ clipSpentUsd: 0.94, clipCostUsd: 1.89 })).toBe("$0.94");
  });

  it("falls back to the estimate only when nothing has been billed", () => {
    expect(cardText({ clipSpentUsd: 0, clipCostUsd: 1.89 })).toBe("$1.89");
  });
});

// deleteScene refuses a rendered scene (actions/brief.ts's assertEditable),
// so offering the control there would be a button that only fails. It is
// also the one action on this screen that cannot be undone by spending
// again, which is why it is last and quiet.
describe("SceneWorkbench — deleting is offered only where it would be accepted", () => {
  function names(status: "frame_ready" | "done"): string {
    render(<SceneWorkbench {...props({ scene: createMockScene({ status }) })} />);
    return screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "")
      .join(" | ");
  }

  it("offers it on an editable scene", () => {
    expect(names("frame_ready")).toMatch(/delete scene/i);
  });

  it("hides it once the scene has rendered", () => {
    expect(names("done")).not.toMatch(/delete scene/i);
  });
});

// The rail's contract, applied to the one screen that makes four different
// calls: the row spins for the ones that cost money or take real time, and
// stays still for the free autosave. That distinction is the whole point —
// this screen's Regenerate button used to read the SAME transition the
// 600ms debounced text save used, so pausing mid-sentence disabled a paid
// button and span its ring for a save that costs nothing.
describe("SceneWorkbench — what lights this scene's rail row", () => {
  const railModel: RailModel = {
    projectId: "proj-1",
    readOnly: false,
    projectTitle: "Kinoko Coffee",
    projectSubtitle: "2 scenes",
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

  function renderWithRail(overrides?: Partial<SceneWorkbenchProps>): void {
    render(
      <RailBusyProvider>
        <SceneWorkbench {...props(overrides)} />
        <ProjectRail model={railModel} />
      </RailBusyProvider>,
    );
  }

  function railSpinning(): boolean {
    return screen.getByLabelText("Project navigation").querySelector("svg.animate-spin") !== null;
  }

  it("stays still for the free autosave, and leaves the paid button clickable through it", async () => {
    const user = userEvent.setup();
    const saveMock = vi.mocked(briefActions.updateScenePrompt);
    saveMock.mockResolvedValue(undefined);

    renderWithRail();

    const textarea = screen.getByRole("textbox", { name: "Video prompt" });
    await user.type(textarea, "!");

    // Wait for the debounce to actually fire, so this is not just asserting
    // that nothing has happened yet.
    await waitFor(() => expect(saveMock).toHaveBeenCalled(), { timeout: 3000 });

    expect(railSpinning()).toBe(false);
    const regenerate = screen.getByRole("button", { name: /regenerate frame/i });
    expect(isDisabled(regenerate)).toBe(false);
  });

  it("spins for the paid frame regeneration, and stops when it returns", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => {};
    mockUpdateScenePromptAndRegenerate.mockReturnValue(
      new Promise((resolve) => {
        settle = () => resolve(undefined);
      }),
    );

    renderWithRail();
    expect(railSpinning()).toBe(false);

    await user.click(screen.getByRole("button", { name: /regenerate frame/i }));
    await waitFor(() => expect(railSpinning()).toBe(true));

    await act(async () => {
      settle();
    });
    await waitFor(() => expect(railSpinning()).toBe(false));
  });

  it("keeps spinning after the workbench that started it unmounts", async () => {
    // THE point of moving the signal off the mounted lifetime. Navigating to
    // another scene mid-regeneration unmounts this workbench, and the row
    // used to go quiet the moment it did — so the operator saw the spinner
    // vanish and asked whether the call had been cancelled. It had not: the
    // server action runs to completion regardless. Only the one signal meant
    // to survive the navigation was disappearing.
    const user = userEvent.setup();
    let settle: () => void = () => {};
    mockUpdateScenePromptAndRegenerate.mockReturnValue(
      new Promise((resolve) => {
        settle = () => resolve(undefined);
      }),
    );

    const { rerender } = render(
      <RailBusyProvider>
        <SceneWorkbench {...props()} />
        <ProjectRail model={railModel} />
      </RailBusyProvider>,
    );

    await user.click(screen.getByRole("button", { name: /regenerate frame/i }));
    await waitFor(() => expect(railSpinning()).toBe(true));

    // The workbench goes; the rail stays, as it does on a real navigation.
    rerender(
      <RailBusyProvider>
        <ProjectRail model={railModel} />
      </RailBusyProvider>,
    );

    expect(railSpinning()).toBe(true);

    await act(async () => {
      settle();
    });
    // And the ACTION clears it, from a closure whose component is long gone.
    await waitFor(() => expect(railSpinning()).toBe(false));
  });

  it("refuses a second paid click after navigating away and back", async () => {
    // The remount. `regenerating` is component state and a fresh instance
    // has it false, so the button read as ready while the first call was
    // still running — and the next click billed a second $0.02 for a frame
    // already being generated. The store is the only thing that survived
    // the round trip, so the button asks it.
    const user = userEvent.setup();
    let settle: () => void = () => {};
    mockUpdateScenePromptAndRegenerate.mockReturnValue(
      new Promise((resolve) => {
        settle = () => resolve(undefined);
      }),
    );

    const { rerender } = render(
      <RailBusyProvider>
        <SceneWorkbench {...props()} />
        <ProjectRail model={railModel} />
      </RailBusyProvider>,
    );

    await user.click(screen.getByRole("button", { name: /regenerate frame/i }));
    await waitFor(() => expect(mockUpdateScenePromptAndRegenerate).toHaveBeenCalledTimes(1));

    // Away…
    rerender(
      <RailBusyProvider>
        <ProjectRail model={railModel} />
      </RailBusyProvider>,
    );
    // …and back, a brand new workbench with no memory of the call.
    rerender(
      <RailBusyProvider>
        <SceneWorkbench {...props()} />
        <ProjectRail model={railModel} />
      </RailBusyProvider>,
    );

    const regenerate = screen.getByRole("button", { name: /regenerate frame/i });
    expect(isDisabled(regenerate)).toBe(true);
    // The frame, not a sentence: the skeleton stands where the new frame
    // will appear, and it also holds the OLD frame back from a $1.89 render
    // judged against an image about to be thrown away.
    expect(document.querySelector('[data-slot="skeleton"]')).not.toBeNull();

    await user.click(regenerate);
    expect(mockUpdateScenePromptAndRegenerate).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle();
    });
    await waitFor(() =>
      expect(isDisabled(screen.getByRole("button", { name: /regenerate frame/i }))).toBe(false),
    );
  });

  it("shuts the $1.89 render while a $0.02 frame call is still running", async () => {
    // The clip is rendered FROM the reference frame. Committing $1.89 while
    // that frame is being replaced buys a render of the old one and throws
    // away the $0.02 that was about to change it — 47x apart, and the
    // cheaper call is the one that decides what the expensive one renders.
    const user = userEvent.setup();
    mockUpdateScenePromptAndRegenerate.mockReturnValue(new Promise(() => {}));

    render(
      <RailBusyProvider>
        <SceneWorkbench {...props({ scene: createMockScene({ status: "frame_ready" }) })} />
        <ProjectRail model={railModel} />
      </RailBusyProvider>,
    );

    const render$ = screen.getByRole("button", { name: /Render this scene/i });
    expect(isDisabled(render$)).toBe(false);

    await user.click(screen.getByRole("button", { name: /regenerate frame/i }));

    await waitFor(() =>
      expect(isDisabled(screen.getByRole("button", { name: /Render this scene/i }))).toBe(true),
    );
  });

  it("spins for the paid rewrite too", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => {};
    mockApplyScenePrompt.mockReturnValue(
      new Promise((resolve) => {
        settle = () => resolve(undefined);
      }),
    );

    renderWithRail();

    await user.click(screen.getByRole("button", { name: /rewrite/i }));
    await waitFor(() => expect(railSpinning()).toBe(true));

    await act(async () => {
      settle();
    });
    await waitFor(() => expect(railSpinning()).toBe(false));
  });
});
