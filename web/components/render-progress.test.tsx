// @vitest-environment jsdom
//
// Covers the scene-tile status icon + elapsed-timer addition, not the whole
// component (Realtime reconnect/poll-fallback behaviour already has no
// coverage and stays out of scope here). "@/lib/supabase/client" and
// "@/actions/enqueue" are mocked for the same reason account-menu.test.tsx
// mocks actions/auth: importing the real modules pulls in a Supabase client
// construction / next/headers cookies() call that throws outside an actual
// request, and none of that machinery is what's under test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RenderProgress, type RenderProgressScene } from "./render-progress";
import { KLING_3_PRO, SEEDANCE_2_5, type VideoModelDescriptor } from "@/lib/models";
import type { RenderBudgetFigures } from "@/lib/render-budget";
import { classifyRenderError, sanitizeRenderError } from "@/lib/render-error";
import { retryScene } from "@/actions/enqueue";

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    channel: () => ({
      on: () => ({
        subscribe: (cb: (status: string) => void) => {
          // Never reports SUBSCRIBED — irrelevant to this file's
          // assertions and avoids the polling-fallback effect firing a
          // real fetch mid-test.
          cb("CLOSED");
          return {};
        },
      }),
    }),
    removeChannel: () => undefined,
  }),
}));

vi.mock("@/actions/enqueue", () => ({
  getSceneStatuses: vi.fn(async () => []),
  retryAllFailed: vi.fn(async () => undefined),
  retryScene: vi.fn(async () => undefined),
}));

const BUDGET: RenderBudgetFigures = {
  dailyRemainingUsd: 100,
  dailyCapUsd: 100,
  weeklyRemainingUsd: 100,
  weeklyCapUsd: 100,
  globalRemainingUsd: 100,
  globalCapUsd: 100,
};

function scene(overrides: Partial<RenderProgressScene>): RenderProgressScene {
  return {
    id: "scene-1",
    idx: 0,
    is_talking_head: false,
    status: "rendering",
    duration_s: 5,
    submitted_at: null,
    // 0045_scene_render_settings_override.sql — null is the ordinary case:
    // this scene inherits the project's model.
    render_settings_override: null,
    error: null,
    ...overrides,
  };
}

function renderProgress(
  scenes: RenderProgressScene[],
  overrides: {
    readOnly?: boolean;
    pendingCount?: number;
    model?: VideoModelDescriptor;
    resolution?: string;
    audioEnabled?: boolean;
  } = {},
): ReturnType<typeof render> {
  return render(
    <RenderProgress
      projectId="proj-1"
      initialScenes={scenes}
      model={overrides.model ?? SEEDANCE_2_5}
      resolution={overrides.resolution ?? "720p"}
      fps={24}
      budget={BUDGET}
      pendingCount={overrides.pendingCount ?? 0}
      pendingCostUsd={0}
      audioEnabled={overrides.audioEnabled}
      readOnly={overrides.readOnly}
    />,
  );
}

describe("RenderProgress scene tiles — status icons", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-08-14T10:00:00.000Z") });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows the status word as visible text beside the glyph, for every status the grid renders", () => {
    renderProgress([
      scene({ id: "a", idx: 0, status: "rendering", submitted_at: "2026-08-14T09:59:00.000Z" }),
      scene({ id: "b", idx: 1, status: "queued", submitted_at: null }),
      scene({ id: "c", idx: 2, status: "done", submitted_at: "2026-08-14T09:00:00.000Z" }),
      scene({ id: "d", idx: 3, status: "failed", submitted_at: "2026-08-14T09:00:00.000Z" }),
    ]);
    // Brought back beside the spinner/glyph per the GitHub-Actions shape —
    // label and indicator together, not the icon alone. Each word is real
    // page text now, not an sr-only duplicate hidden from sighted users.
    for (const word of ["Rendering", "Queued", "Done", "Failed"]) {
      expect(screen.getByText(word)).toBeTruthy();
    }
  });

  it("the visible label is aria-hidden — aria-label alone carries the accessible name, so it isn't announced twice", () => {
    renderProgress([scene({ id: "a", idx: 0, status: "rendering" })]);
    const visibleLabel = screen.getByText("Rendering");
    // role="status"/"img" compute their accessible name from aria-label
    // only, never from visible or sr-only child content (status-icon.tsx's
    // doc comment) — so once the word is rendered visibly, a screen reader
    // would hear it twice (once as the region's name, once as ordinary
    // page content) unless the visible copy is taken out of the
    // accessibility tree. aria-hidden is what does that.
    expect(visibleLabel.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByText("Rendering", { selector: ".sr-only" })).toBeNull();
  });

  it("each status exposes its word as an accessible name via role status/img, from aria-label", () => {
    renderProgress([
      scene({ id: "a", idx: 0, status: "rendering", submitted_at: "2026-08-14T09:59:00.000Z" }),
      scene({ id: "b", idx: 1, status: "queued", submitted_at: null }),
      scene({ id: "c", idx: 2, status: "done", submitted_at: "2026-08-14T09:00:00.000Z" }),
      scene({ id: "d", idx: 3, status: "failed", submitted_at: "2026-08-14T09:00:00.000Z" }),
    ]);
    expect(screen.getByRole("status", { name: "Rendering" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Queued" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Done" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Failed" })).toBeTruthy();
  });

  it("rendering renders the spinning arc; queued does not", () => {
    renderProgress([
      scene({ id: "a", idx: 0, status: "rendering", submitted_at: "2026-08-14T09:59:00.000Z" }),
      scene({ id: "b", idx: 1, status: "queued", submitted_at: null }),
    ]);
    const renderingIcon = screen.getByRole("status", { name: "Rendering" }).querySelector("svg");
    const queuedIcon = screen.getByRole("status", { name: "Queued" }).querySelector("svg");
    // Unprefixed `animate-spin`, deliberately — the spinner is not gated on
    // motion-safe. See status-icon.tsx's doc comment for why that is an
    // explicit product decision: the arc's resting frame reads as a shape
    // rather than as activity, and telling "running" from "queued" is the
    // one thing this glyph exists to do. Asserting the *absence* of the
    // prefix is what keeps a well-meaning "accessibility fix" from silently
    // reintroducing the guard.
    expect(renderingIcon?.getAttribute("class")).toContain("animate-spin");
    expect(renderingIcon?.getAttribute("class")).not.toContain("motion-safe:");
    expect(queuedIcon?.getAttribute("class")).not.toContain("animate-spin");
  });

  it("no tile shows a per-scene elapsed readout, rendering included — the timer was removed from the grid", () => {
    renderProgress([
      scene({ id: "a", idx: 0, status: "rendering", submitted_at: "2026-08-14T09:59:00.000Z" }),
      scene({ id: "b", idx: 1, status: "queued", submitted_at: null }),
      scene({ id: "c", idx: 2, status: "done", submitted_at: "2026-08-14T09:00:00.000Z" }),
      scene({ id: "d", idx: 3, status: "failed", submitted_at: "2026-08-14T09:00:00.000Z" }),
    ]);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    // The batch-level "N elapsed" summary above the grid still renders
    // this format (lib/render-elapsed.ts's elapsedLabel is still wired
    // there), so this can't assert a blanket absence of /^\d+:\d\d$/ in
    // the document — it has to look inside each tile specifically for the
    // per-scene readout ac3309e added and this change takes back out.
    for (const scenario of ["#1", "#2", "#3", "#4"]) {
      const tile = screen.getByText(scenario).closest("div.rounded-lg");
      expect(tile?.textContent).not.toMatch(/\d+:\d\d/);
    }
  });
});

describe("RenderProgress — header finished state", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-08-14T10:00:00.000Z") });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("still in flight: no finished state, and the elapsed readout is present", () => {
    renderProgress([
      scene({ id: "a", idx: 0, status: "rendering", submitted_at: "2026-08-14T09:59:00.000Z" }),
      scene({ id: "b", idx: 1, status: "done", submitted_at: "2026-08-14T09:00:00.000Z" }),
    ]);
    expect(screen.queryByText(/rendered/i)).toBeNull();
    expect(screen.getByText(/elapsed/)).toBeTruthy();
  });

  it("all scenes done: announces a finished state and links to Deliver", () => {
    renderProgress([
      scene({ id: "a", idx: 0, status: "done", submitted_at: "2026-08-14T09:00:00.000Z" }),
      scene({ id: "b", idx: 1, status: "done", submitted_at: "2026-08-14T09:00:00.000Z" }),
    ]);
    const finished = screen.getByRole("status");
    expect(finished.textContent).toMatch(/All 2 scenes rendered/);
    const link = screen.getByRole("link", { name: /All 2 scenes rendered/ });
    expect(link.getAttribute("href")).toBe("/projects/proj-1/deliver");
    // No elapsed readout once finished — no completion timestamp exists to
    // report a real duration from (lib/render-elapsed.ts).
    expect(screen.queryByText(/elapsed/)).toBeNull();
  });

  it("finished with a failure: says so and does not read as a clean success", () => {
    renderProgress([
      scene({ id: "a", idx: 0, status: "done", submitted_at: "2026-08-14T09:00:00.000Z" }),
      scene({ id: "b", idx: 1, status: "failed", submitted_at: "2026-08-14T09:00:00.000Z" }),
    ]);
    const finished = screen.getByRole("status");
    expect(finished.textContent).toMatch(/Rendered — 1 of 2, 1 failed/);
    expect(finished.className).not.toMatch(/text-success/);
    expect(screen.queryByText(/All \d+ scenes? rendered/)).toBeNull();
  });

  it("finished with every scene failed: states failure, and has no Deliver link since nothing finished", () => {
    renderProgress([
      scene({ id: "a", idx: 0, status: "failed", submitted_at: "2026-08-14T09:00:00.000Z" }),
    ]);
    const finished = screen.getByRole("status");
    expect(finished.textContent).toMatch(/Rendered — 0 of 1, 1 failed/);
    expect(screen.queryByRole("link", { name: /Rendered/ })).toBeNull();
  });

  it("pending scenes never submitted: not treated as finished even though nothing is in flight", () => {
    renderProgress(
      [
        scene({ id: "a", idx: 0, status: "done", submitted_at: "2026-08-14T09:00:00.000Z" }),
        scene({ id: "b", idx: 1, status: "frame_ready", submitted_at: null }),
      ],
      { pendingCount: 1 },
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("1 / 2 done")).toBeTruthy();
  });

  it("progressbar ARIA reflects completion, including a failure mix", () => {
    renderProgress([
      scene({ id: "a", idx: 0, status: "done", submitted_at: "2026-08-14T09:00:00.000Z" }),
      scene({ id: "b", idx: 1, status: "failed", submitted_at: "2026-08-14T09:00:00.000Z" }),
    ]);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(bar.getAttribute("aria-valuetext")).toBe("1 of 2 done, 1 failed");
  });

  it("progressbar ARIA mid-flight is not yet at 100", () => {
    renderProgress([
      scene({ id: "a", idx: 0, status: "rendering", submitted_at: "2026-08-14T09:59:00.000Z" }),
      scene({ id: "b", idx: 1, status: "done", submitted_at: "2026-08-14T09:00:00.000Z" }),
    ]);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
  });
});

describe("RenderProgress — readOnly", () => {
  afterEach(() => {
    cleanup();
  });

  it("hides the per-scene Retry button for a failed scene when readOnly", () => {
    renderProgress([scene({ id: "a", idx: 0, status: "failed" })], { readOnly: true });
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows the per-scene Retry button for a failed scene when not readOnly", () => {
    renderProgress([scene({ id: "a", idx: 0, status: "failed" })]);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("hides the render-remaining control when readOnly, even with scenes still pending", () => {
    renderProgress([scene({ id: "a", idx: 0, status: "queued" })], {
      readOnly: true,
      pendingCount: 2,
    });
    expect(screen.queryByText(/still waiting to be rendered/)).toBeNull();
  });

  it("still shows the failure reason to a readOnly viewer — diagnostic info, not a write control", () => {
    renderProgress(
      [
        scene({
          id: "a",
          idx: 0,
          status: "failed",
          error: classifyRenderError("timeout"),
        }),
      ],
      { readOnly: true },
    );
    expect(screen.getByText(/transient failure/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

// The per-scene Retry was the one paid control on this page that spent
// straight off the press, beside a "Retry all failed" that has asked since
// it was written — the safe way to retry a whole batch was guarded and the
// same spend on a single tile was not. A retry queues a fresh attempt and is
// billed like one, so it is confirmed like one.
describe("RenderProgress — the per-scene Retry asks before it spends", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(retryScene).mockReset();
    vi.mocked(retryScene).mockResolvedValue(undefined);
  });

  it("opens a confirm naming the cost and the settings, and queues nothing yet", async () => {
    const user = userEvent.setup();
    renderProgress([scene({ id: "a", idx: 0, status: "failed", duration_s: 5 })]);

    await user.click(screen.getByRole("button", { name: "Retry" }));
    const dialog = await screen.findByRole("dialog");

    expect(dialog.textContent).toContain("Retry scene 1?");
    // SEEDANCE_2_5 at 720p for 5s — the same estimateCost the Re-render
    // confirm on a done tile quotes, and the same one retryScene checks the
    // caps against server-side.
    expect(dialog.textContent).toMatch(/\$\d/);
    expect(dialog.textContent).toContain("Seedance 2.5 · 720p · 5s");
    expect(
      retryScene,
      "opening the confirm already queued the retry — the dialog is decoration",
    ).not.toHaveBeenCalled();
  });

  it("queues the retry only on Confirm, and only once", async () => {
    const user = userEvent.setup();
    renderProgress([scene({ id: "a", idx: 0, status: "failed" })]);

    await user.click(screen.getByRole("button", { name: "Retry" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: /^confirm/i });

    await user.click(confirm);
    await user.click(confirm);

    await waitFor(() => expect(retryScene).toHaveBeenCalledWith("a"));
    expect(retryScene).toHaveBeenCalledTimes(1);
  });

  it("cancelling queues nothing", async () => {
    const user = userEvent.setup();
    renderProgress([scene({ id: "a", idx: 0, status: "failed" })]);

    await user.click(screen.getByRole("button", { name: "Retry" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^cancel/i }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(retryScene).not.toHaveBeenCalled();
  });
});

// Finding 1 (code review): SceneRerenderDialog used to be quoted at the
// PROJECT's model/resolution (priceForSecond(model, resolution)), while
// rerenderScene (actions/enqueue.ts) prices this exact scene's EFFECTIVE
// settings — mergeRenderSettings(project, scene.render_settings_override).
// A scene retried onto Kling earlier (0045: overrides are sticky) then
// re-rendered from this screen displayed the project's LTX price instead of
// what the server would actually charge.
describe("RenderProgress — SceneRerenderDialog pricing (Finding 1)", () => {
  afterEach(() => {
    cleanup();
  });

  it("quotes a 'done' scene's override, not the project's model/resolution", () => {
    renderProgress(
      [
        scene({
          id: "a",
          idx: 0,
          status: "done",
          is_talking_head: true,
          duration_s: 5,
          render_settings_override: { model: KLING_3_PRO.id },
        }),
      ],
      {
        model: SEEDANCE_2_5,
        resolution: "1080p",
        // pickModel only routes a talking-head scene to Kling's SOUND rate
        // when audio is on (lib/models.ts) — needed here so the override
        // actually prices at Kling's sound rate instead of falling back to
        // Seedance silent.
        audioEnabled: true,
      },
    );
    // Project settings alone (Seedance 2.5 @ 1080p, $0.57/s) would have
    // quoted $2.85 for 5s — the bug this test pins. The scene's real
    // effective settings (merged with its Kling override) bill at Kling's
    // measured SOUND rate, $0.135/s (kie bills exactly the seconds
    // requested, no multiplier): 5s * $0.135/s = $0.675, which rounds to
    // $0.68.
    expect(screen.getByRole("button", { name: /Re-render — \$0\.68/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Re-render — \$2\.85/ })).toBeNull();
  });

  it("quotes the project's own rate for a 'done' scene with no override", () => {
    // 5s * $0.315/s (Seedance 2.5 @ 720p, a receipt — see lib/kie/rates.ts)
    // = $1.575, rounds to $1.58.
    renderProgress(
      [
        scene({
          id: "a",
          idx: 0,
          status: "done",
          is_talking_head: false,
          duration_s: 5,
          render_settings_override: null,
        }),
      ],
      { model: SEEDANCE_2_5, resolution: "720p" },
    );
    expect(screen.getByRole("button", { name: /Re-render — \$1\.58/ })).toBeTruthy();
  });
});

// Finding 2 (code review): the retry model buttons in RetryAllFailedDialog
// used to quote priceForSecond(candidate, candidate.defaultResolution), but
// the retry actually renders at mergeRenderSettings(projectSettings, {model:
// candidate.id}), which KEEPS the project's resolution whenever the
// candidate supports it. On a 2160p project the button advertised the
// 1080p rate while the total (and the real bill) used the 2160p rate.
describe("RenderProgress — RetryAllFailedDialog model button pricing (Finding 2)", () => {
  afterEach(() => {
    cleanup();
  });

  it("quotes a candidate model at the resolution it will actually merge to, not its own default", async () => {
    // Seedance's resolution strings are spelled differently from Kling's
    // ("480p"/"720p"/"1080p" against Kling's "1080p" — kie's own
    // inconsistency, not a typo; see lib/kie/models.ts's KieModel doc
    // comment) — so a Kling@1080p project's resolution never matches any
    // of Seedance's own entries and the merge falls back to Seedance's
    // default rather than truly "keeping" the project's value. Whichever
    // resolution it lands on, none of Seedance 2.5's real rates ($0.14,
    // $0.315, $0.57) is $1.1497/s — the fal-derived number this button used
    // to show before kie's own rates replaced it.
    const user = userEvent.setup();
    renderProgress(
      [scene({ id: "a", idx: 0, status: "failed" }), scene({ id: "b", idx: 1, status: "failed" })],
      { model: KLING_3_PRO, resolution: "1080p" },
    );
    // Opens the batch retry dialog to reach the model row.
    await user.click(screen.getByRole("button", { name: /Retry 2 failed/ }));
    // Quoted at the only resolution it has, never at the project's.
    // `(?! · BytePlus| Flash)` keeps this on kie's Seedance 2.5, not the BytePlus variants.
    expect(
      screen.queryByRole("button", { name: /Seedance 2\.5(?! · BytePlus| Flash).*\$1\.15\/s/ }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: /Seedance 2\.5(?! · BytePlus| Flash)/ }),
    ).toBeTruthy();
  });
});

describe("RenderProgress — failure reason", () => {
  afterEach(() => {
    cleanup();
  });

  it("a failed scene renders its classified reason, not just the bare status word", () => {
    renderProgress([
      scene({
        id: "a",
        idx: 0,
        status: "failed",
        error: classifyRenderError("timeout"),
      }),
    ]);
    expect(screen.getByText(/transient failure/i)).toBeTruthy();
  });

  it("a failed scene with no error row still renders sensibly — no blank space, no 'undefined'", () => {
    renderProgress([scene({ id: "a", idx: 0, status: "failed", error: null })]);
    expect(screen.getByText("No failure reason recorded.")).toBeTruthy();
    expect(screen.queryByText(/undefined/)).toBeNull();
    // No error row still defaults to offering a retry — "unknown, retry may help".
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("insufficient balance is retryable once funded: reason shown, Retry button offered", () => {
    renderProgress([
      scene({
        id: "a",
        idx: 0,
        status: "failed",
        error: classifyRenderError(
          "fal: insufficient account balance: client error: status 402: {}",
        ),
      }),
    ]);
    // Fixed from outside (an admin funds the account), and enqueue's
    // pre-flight re-checks the balance on the click itself — so the reason
    // is still shown, but the button is not hidden the way a genuinely
    // unfixable rejection's is.
    expect(screen.getByText(/out of credit/i)).toBeTruthy();
    expect(screen.getByText(/fal account/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("a rejected (4xx) request is not retryable without a change: no Retry button offered", () => {
    renderProgress([
      scene({
        id: "a",
        idx: 0,
        status: "failed",
        error: classifyRenderError(
          'submit to fal: fal: submit fal-ai/ltx-2.3: client error: status 422: {"detail":"bad prompt"}',
        ),
      }),
    ]);
    expect(screen.getByText(/rejected this request outright/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("a content-policy rejection is retryable and does not tell the editor to change their input", () => {
    renderProgress([
      scene({
        id: "a",
        idx: 0,
        status: "failed",
        error: classifyRenderError(
          'submit to fal: fal: submit fal-ai/ltx-2.3: client error: status 422: {"detail":"content_policy_violation: flagged by a content checker"}',
        ),
      }),
    ]);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(
      screen.queryByText(/invalid prompt|reference image|rejected this request|change your photo/i),
    ).toBeNull();
  });

  it("a 429 (rate limited) is retryable and does not tell the editor to change their input", () => {
    renderProgress([
      scene({
        id: "a",
        idx: 0,
        status: "failed",
        error: classifyRenderError(
          'submit to fal: fal: submit fal-ai/ltx-2.3: client error: status 429: {"detail":"rate limited"}',
        ),
      }),
    ]);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(/invalid prompt|reference image|rejected this request/i)).toBeNull();
  });

  it("a 400 still classifies as rejected, not retryable", () => {
    renderProgress([
      scene({
        id: "a",
        idx: 0,
        status: "failed",
        error: classifyRenderError(
          'submit to fal: fal: submit fal-ai/ltx-2.3: client error: status 400: {"detail":"bad prompt"}',
        ),
      }),
    ]);
    expect(screen.getByText(/rejected this request outright/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("a 402 still classifies as insufficient_balance, retryable once funded", () => {
    renderProgress([
      scene({
        id: "a",
        idx: 0,
        status: "failed",
        error: classifyRenderError(
          "fal: insufficient account balance: client error: status 402: {}",
        ),
      }),
    ]);
    expect(screen.getByText(/out of credit/i)).toBeTruthy();
    expect(screen.getByText(/fal account/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("a transient/retryable failure offers Retry", () => {
    renderProgress([
      scene({
        id: "a",
        idx: 0,
        status: "failed",
        error: classifyRenderError(
          "reconcile: fal status check kept failing: server error: status 503: upstream down",
        ),
      }),
    ]);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("an unrecognized failure defaults to 'unknown, retry may help' and still offers Retry", () => {
    renderProgress([
      scene({
        id: "a",
        idx: 0,
        status: "failed",
        error: classifyRenderError("something nobody has ever seen before"),
      }),
    ]);
    expect(screen.getByText("something nobody has ever seen before")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("a very long error is truncated and does not escape its tile", () => {
    // Spaced-out prose, not one giant unbroken token: this is testing
    // layout truncation, not sanitizeRenderError's token redaction (that
    // has its own dedicated tests below) — a single 2000-char token would
    // get redacted to "[redacted]" before ever reaching the DOM.
    const longError = "an unusual error occurred for reasons nobody has documented yet "
      .repeat(30)
      .trim();
    renderProgress([
      scene({
        id: "a",
        idx: 0,
        status: "failed",
        error: classifyRenderError(longError),
      }),
    ]);
    const reason = screen.getByTitle(longError);
    expect(reason.className).toMatch(/truncate/);
  });
});

describe("sanitizeRenderError", () => {
  it("redacts a bare JWT whole, not one segment of it", () => {
    // Regression. The generic token rule matches \b[A-Za-z0-9_-]{24,}\b, and
    // \b treats a dot as a word boundary — so a JWT arriving WITHOUT a
    // surrounding URL (fal echoing back only the credential, say) was seen
    // as three independent runs, and only the header, long enough on its
    // own, was redacted. The payload survived, and a Supabase storage
    // token's payload is base64 of its claims, which carry the object path.
    const raw =
      "submit to fal: token " +
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1cmwiOiJhc3NldHMvYS5wbmcifQ.7Xk2QpL" +
      " rejected";

    const sanitized = sanitizeRenderError(raw);

    expect(sanitized).not.toContain("eyJ1cmwiOiJhc3NldHMvYS5wbmcifQ");
    expect(sanitized).not.toContain("7Xk2QpL");
    expect(sanitized).toBe("submit to fal: token [redacted] rejected");
  });

  it("leaves an ordinary technical message untouched", () => {
    // The other direction: over-redaction makes the whole feature useless,
    // since an editor who cannot read the reason is back where they started.
    const raw = "the fal account is out of credit — an admin needs to add funds";
    expect(sanitizeRenderError(raw)).toBe(raw);
  });

  it("removes a signed URL and its access token from the displayed text", () => {
    const raw =
      "sign reference frame url: fal: submit fal-ai/ltx-2.3: client error: status 422: " +
      '{"detail":"Failed to download the file from ' +
      "https://xyzcorp.supabase.co/storage/v1/object/sign/frames/abc123.jpg" +
      "?token=eyJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJmcmFtZXMvYWJjMTIzLmpwZyJ9.9f8e7d6c5b4a3928170615243546576879" +
      '"}';

    const sanitized = sanitizeRenderError(raw);

    expect(sanitized).not.toMatch(/https?:\/\//);
    expect(sanitized).not.toContain("token=");
    expect(sanitized).not.toContain(
      "eyJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJmcmFtZXMvYWJjMTIzLmpwZyJ9.9f8e7d6c5b4a3928170615243546576879",
    );
    expect(sanitized).toContain("[link removed]");
  });

  it("redacts a bare long token even outside a full URL", () => {
    const raw = "auth failed: Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789";
    const sanitized = sanitizeRenderError(raw);
    expect(sanitized).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(sanitized).toContain("[redacted]");
  });

  it("leaves short, ordinary technical words alone", () => {
    expect(sanitizeRenderError("timeout")).toBe("timeout");
    expect(sanitizeRenderError("fal reported the render failed")).toBe(
      "fal reported the render failed",
    );
  });
});
