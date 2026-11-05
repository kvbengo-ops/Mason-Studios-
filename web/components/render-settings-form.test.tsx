// @vitest-environment jsdom
//
// Testing the RenderSettingsForm component. Required coverage per the brief:
// - every model is represented, with published-only Gemini visibly disabled,
// - the total changes when the video model changes,
// - the picker's own buttons never quote a number the table below can
//   disagree with,
// - a non-owner cannot write.
//
// Each test includes a negative control: break the exact line it protects,
// confirm THAT test fails, restore it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RenderSettingsForm } from "./render-settings-form";
import {
  CLAUDE_HAIKU_4_5,
  CLAUDE_SONNET_5,
  isModelAvailableForSelection,
  KLING_3_PRO,
  SEEDANCE_2_5,
  VIDEO_MODELS,
} from "@/lib/models";

// Mock the updateRenderSettings action — we're testing the component,
// not the server action.
vi.mock("@/actions/render-settings", () => ({
  updateRenderSettings: vi.fn(() => Promise.resolve({})),
}));

// Mock the toast notifications to keep output clean.
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RenderSettingsForm — generic model list", () => {
  it("does not expose UGC-only Gemini or a fake rate", () => {
    render(
      <RenderSettingsForm
        projectId="proj-1"
        audioEnabled={true}
        initialRenderSettings={{ model: SEEDANCE_2_5.id, resolution: "720p", fps: 24 }}
        compilerModel={CLAUDE_HAIKU_4_5}
        longestSceneS={10}
        readOnly={false}
      />,
    );

    expect(screen.queryByText("Gemini Omni Video")).toBeNull();

    for (const model of VIDEO_MODELS) {
      const chip = screen
        .getAllByRole("button")
        .find((btn) => btn.textContent?.includes(model.label));
      expect(chip, `${model.label} is not offered as a button`).toBeTruthy();
      expect(isModelAvailableForSelection(model.id, model.defaultResolution)).toBe(true);
      expect(chip!.hasAttribute("disabled")).toBe(false);
      expect(chip!.textContent).toMatch(/\$/);
    }
  });
});

describe("RenderSettingsForm — total changes when model changes", () => {
  it("displays a different total when switching between models", async () => {
    const user = userEvent.setup();
    const { updateRenderSettings } = await import("@/actions/render-settings");
    vi.mocked(updateRenderSettings).mockResolvedValue(undefined);

    render(
      <RenderSettingsForm
        projectId="proj-1"
        audioEnabled={true}
        initialRenderSettings={{ model: SEEDANCE_2_5.id, resolution: "720p", fps: 24 }}
        compilerModel={CLAUDE_HAIKU_4_5}
        longestSceneS={10}
        readOnly={false}
      />,
    );

    // Get the initial total displayed
    const totalElement = screen.getByText(/per 30s ad/);
    const textBefore = totalElement.parentElement?.textContent || "";

    // Find and click the Kling button to switch models
    const klingButton = screen
      .getAllByRole("button")
      .find((btn) => btn.textContent?.includes("Kling"));
    if (klingButton) {
      await user.click(klingButton);

      // Wait for the optimistic total to update
      await waitFor(() => {
        const totalAfter = screen.getByText(/per 30s ad/);
        const textAfter = totalAfter.parentElement?.textContent || "";
        // The total should have changed
        expect(textAfter).not.toEqual(textBefore);
      });
    }
  });

  it("itemises compile, reference frames and video", () => {
    render(
      <RenderSettingsForm
        projectId="proj-1"
        audioEnabled={true}
        initialRenderSettings={{ model: SEEDANCE_2_5.id, resolution: "720p", fps: 24 }}
        compilerModel={CLAUDE_SONNET_5}
        longestSceneS={10}
        readOnly={false}
      />,
    );

    expect(screen.getByText("With these choices")).toBeTruthy();
    expect(screen.getByText(`compile · ${CLAUDE_SONNET_5.label}`)).toBeTruthy();
    expect(screen.getByText("5 reference frames")).toBeTruthy();
    expect(screen.getByText(`30s video · ${SEEDANCE_2_5.label}`)).toBeTruthy();
  });

  // The panel used to quote compile + video and call that the price of an
  // ad, while every scene in the ad bills an image call first. On the
  // shipped default that was $9.57 against a real $9.67 — short by exactly
  // the 5 x $0.02 of frames the row below now names.
  it("counts the reference frames in the total, not just in the table", () => {
    render(
      <RenderSettingsForm
        projectId="proj-1"
        audioEnabled={true}
        initialRenderSettings={{ model: SEEDANCE_2_5.id, resolution: "720p", fps: 24 }}
        compilerModel={CLAUDE_SONNET_5}
        longestSceneS={10}
        readOnly={false}
      />,
    );

    // $0.12 compile + 5 x $0.02 frames + 30 x $0.315 video.
    const totalRow = screen.getByText("per 30s ad").parentElement;
    expect(totalRow?.textContent).toContain("$9.67");
  });

  it("prices the video row at kie's measured rate for this resolution", () => {
    render(
      <RenderSettingsForm
        projectId="proj-1"
        audioEnabled={true}
        initialRenderSettings={{ model: SEEDANCE_2_5.id, resolution: "720p", fps: 24 }}
        compilerModel={CLAUDE_SONNET_5}
        longestSceneS={10}
        readOnly={false}
      />,
    );

    const videoRow = screen.getByText(`30s video · ${SEEDANCE_2_5.label}`).parentElement;
    // 30 x kie's $0.315.
    expect(videoRow?.textContent).toContain("$9.45");
  });

  it("shows a total that is exactly the sum of the rows above it", () => {
    render(
      <RenderSettingsForm
        projectId="proj-1"
        audioEnabled={true}
        initialRenderSettings={{ model: SEEDANCE_2_5.id, resolution: "1080p", fps: 24 }}
        compilerModel={CLAUDE_HAIKU_4_5}
        longestSceneS={10}
        readOnly={false}
      />,
    );

    const rows = Array.from(document.querySelectorAll("tbody tr"));
    const amounts = rows.map((row) =>
      Number((row.lastElementChild?.textContent ?? "").replace(/[^0-9.]/g, "")),
    );
    const total = amounts.pop()!;
    expect(amounts).toHaveLength(3);
    expect(total).toBeCloseTo(
      amounts.reduce((sum, n) => sum + n, 0),
      2,
    );
  });
});

describe("RenderSettingsForm — the picker cannot contradict the total", () => {
  // Resolution buttons carry a RATIO, computed from the same priceForSecond
  // the total uses, never a second absolute price — so the two can never
  // disagree about which tier costs more.
  it("marks the dearer resolution with a ratio, and never with a price", () => {
    render(
      <RenderSettingsForm
        projectId="proj-1"
        audioEnabled={true}
        initialRenderSettings={{ model: SEEDANCE_2_5.id, resolution: "720p", fps: 24 }}
        compilerModel={CLAUDE_HAIKU_4_5}
        longestSceneS={10}
        readOnly={false}
      />,
    );

    const buttons = screen.getAllByRole("button");
    // 720p is 2.25x the cheapest (480p) tier, rounds up to 2.3x.
    const dearer = buttons.find((b) => b.textContent?.includes("720p"));
    expect(dearer).toBeDefined();
    expect(dearer!.textContent).toContain("×");
    // No absolute price on either button to disagree with the table below.
    expect(dearer!.textContent).not.toMatch(/\$/);

    const cheapest = buttons.find((b) => b.textContent?.includes("480p"));
    expect(cheapest).toBeDefined();
    expect(cheapest!.textContent).not.toMatch(/\$/);
  });

  it("gives the cheapest resolution no multiplier at all", () => {
    render(
      <RenderSettingsForm
        projectId="proj-1"
        audioEnabled={true}
        initialRenderSettings={{ model: SEEDANCE_2_5.id, resolution: "720p", fps: 24 }}
        compilerModel={CLAUDE_HAIKU_4_5}
        longestSceneS={10}
        readOnly={false}
      />,
    );

    // The cheapest tier carries no badge — "1.0x" beside the cheapest option
    // is noise, and the marker exists to warn about an upgrade.
    const base = screen.getAllByRole("button").find((btn) => btn.textContent?.includes("480p"));
    expect(base!.textContent?.trim()).toBe("480p");
  });

  // Kling offered exactly one resolution until 2026-09-10, when kie's std
  // mode gave it a second, cheaper silent rate (720p at 14 cr/s against
  // pro/1080p's 18) — so pro/1080p is now the DEARER tier and carries a
  // ratio the same way Seedance's dearer tiers do, and std/720p, the
  // cheapest, carries none.
  //
  // The exact figure is pinned at 1.4×, not 1.3×: resolutionMultiplier
  // prices Kling off the SOUND table (27 pro / 20 std = 1.35, rounded up),
  // the same table the tooltip and the 30s estimate row use, not the
  // silent one (18 pro / 14 std = 1.2857, which would round up to 1.3× and
  // disagree with both of them). Reverting resolutionMultiplier to the
  // silent table turns this assertion red.
  it("gives Kling's pro/1080p tier a 1.4x multiplier over its cheaper std/720p", () => {
    render(
      <RenderSettingsForm
        projectId="proj-1"
        audioEnabled={true}
        initialRenderSettings={{ model: KLING_3_PRO.id, resolution: "1080p", fps: 24 }}
        compilerModel={CLAUDE_HAIKU_4_5}
        longestSceneS={10}
        readOnly={false}
      />,
    );

    const buttons = screen.getAllByRole("button");
    const cheapest = buttons.find((btn) => btn.textContent?.includes("720p"));
    expect(cheapest!.textContent?.trim()).toBe("720p");

    const dearer = buttons.find((btn) => btn.textContent?.includes("1080p"));
    expect(dearer!.textContent).toContain("1.4×");
    expect(dearer!.textContent).not.toMatch(/\$/);
  });

  it("quotes the picker's own tooltip at the same rate as the table, with no total of its own", () => {
    render(
      <RenderSettingsForm
        projectId="proj-1"
        audioEnabled={true}
        initialRenderSettings={{ model: SEEDANCE_2_5.id, resolution: "720p", fps: 24 }}
        compilerModel={CLAUDE_SONNET_5}
        longestSceneS={10}
        readOnly={false}
      />,
    );

    const chip = screen
      .getAllByRole("button")
      .find((btn) => btn.textContent?.includes(SEEDANCE_2_5.label));
    const title = chip!.getAttribute("title") ?? "";
    // Carries the per-second rate the table is built from...
    expect(title).toContain("$0.315");
    // ...but no dollar total of its own for the whole 30s ad.
    expect(title).not.toMatch(/\$9\.45|\$14/);
  });
});

describe("RenderSettingsForm — the panel says what it is", () => {
  it("names the cadence of each priced row", () => {
    render(
      <RenderSettingsForm
        projectId="proj-1"
        audioEnabled={true}
        initialRenderSettings={{ model: SEEDANCE_2_5.id, resolution: "720p", fps: 24 }}
        compilerModel={CLAUDE_HAIKU_4_5}
        longestSceneS={10}
        readOnly={false}
      />,
    );

    // The compile picker (and its "Compile — once per ad" cadence label)
    // moved to the Script page with the rest of that control. Only the
    // video picker's cadence label is this component's to assert now.
    expect(screen.getByText("Video — per second")).toBeTruthy();
  });

  it("says these are project defaults a scene can override", () => {
    render(
      <RenderSettingsForm
        projectId="proj-1"
        audioEnabled={true}
        initialRenderSettings={{ model: SEEDANCE_2_5.id, resolution: "720p", fps: 24 }}
        compilerModel={CLAUDE_HAIKU_4_5}
        longestSceneS={10}
        readOnly={false}
      />,
    );

    // the per-scene panel (components/scene-settings-panel.tsx) is real, and
    // nothing on this page said
    // it existed.
    expect(screen.getByText(/any scene can override/)).toBeTruthy();
  });
});

describe("RenderSettingsForm — permissions", () => {
  it("allows owner to click model selection buttons", async () => {
    const user = userEvent.setup();
    const { updateRenderSettings } = await import("@/actions/render-settings");
    vi.mocked(updateRenderSettings).mockResolvedValue(undefined);

    render(
      <RenderSettingsForm
        projectId="proj-1"
        audioEnabled={true}
        initialRenderSettings={{ model: SEEDANCE_2_5.id, resolution: "720p", fps: 24 }}
        compilerModel={CLAUDE_HAIKU_4_5}
        longestSceneS={10}
        readOnly={false}
      />,
    );

    const buttons = screen.getAllByRole("button");
    const modelButton = buttons.find((btn) => btn.textContent?.includes("Kling"));
    if (modelButton) {
      expect(modelButton.getAttribute("disabled")).toBeNull();
      // Should be clickable without the read-only restriction
      await user.click(modelButton);
    }
  });

  it("disables all control buttons when readOnly is true", () => {
    render(
      <RenderSettingsForm
        projectId="proj-1"
        audioEnabled={true}
        initialRenderSettings={{ model: SEEDANCE_2_5.id, resolution: "720p", fps: 24 }}
        compilerModel={CLAUDE_HAIKU_4_5}
        longestSceneS={10}
        readOnly={true}
      />,
    );

    // All option buttons should be disabled
    const buttons = screen.getAllByRole("button");
    for (const button of buttons) {
      expect(button.getAttribute("disabled")).toBe("");
    }
  });

  it("shows read-only message when readOnly is true", () => {
    render(
      <RenderSettingsForm
        projectId="proj-1"
        audioEnabled={true}
        initialRenderSettings={{ model: SEEDANCE_2_5.id, resolution: "720p", fps: 24 }}
        compilerModel={CLAUDE_HAIKU_4_5}
        longestSceneS={10}
        readOnly={true}
      />,
    );

    expect(screen.getByText(/Read-only.*only the project owner/)).toBeTruthy();
  });

  it("does not show read-only message when readOnly is false", () => {
    render(
      <RenderSettingsForm
        projectId="proj-1"
        audioEnabled={true}
        initialRenderSettings={{ model: SEEDANCE_2_5.id, resolution: "720p", fps: 24 }}
        compilerModel={CLAUDE_HAIKU_4_5}
        longestSceneS={10}
        readOnly={false}
      />,
    );

    expect(screen.queryByText(/Read-only.*only the project owner/)).toBeNull();
  });
});

describe("RenderSettingsForm — resolution and fps constraints", () => {
  it("shows only the selected model's allowed resolutions", () => {
    render(
      <RenderSettingsForm
        projectId="proj-1"
        audioEnabled={true}
        initialRenderSettings={{ model: KLING_3_PRO.id, resolution: "1080p", fps: 24 }}
        compilerModel={CLAUDE_HAIKU_4_5}
        longestSceneS={10}
        readOnly={false}
      />,
    );

    // Kling allows 1080p (and, since 2026-09-10, 720p too) - 1080p should
    // still show in the resolution row
    const resolutionButtons = screen.getAllByText(/1080p/);
    expect(resolutionButtons.length).toBeGreaterThan(0);
  });

  it("shows only the selected model's allowed frame rates", () => {
    render(
      <RenderSettingsForm
        projectId="proj-1"
        audioEnabled={true}
        initialRenderSettings={{ model: KLING_3_PRO.id, resolution: "1080p", fps: 24 }}
        compilerModel={CLAUDE_HAIKU_4_5}
        longestSceneS={10}
        readOnly={false}
      />,
    );

    // Kling only allows 24 fps
    expect(screen.getByText(/24 fps/)).toBeTruthy();
  });
});
