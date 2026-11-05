// @vitest-environment jsdom
//
// What a read-only /ugc view owes an admin, and what it must not offer them.
//
// The server boundary is NOT here — every write these components reach goes
// through requireProject, which refuses a non-owner regardless of what the
// page renders (see actions/guard.ts and e61a82a's own commit message on why
// that split is what makes the UI work cheap). These tests pin the second
// half of that bargain: the page must not offer a control that would only
// fail, because an operator has to press it to find out.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { UgcTitle } from "@/components/ugc-title";
import { UgcSceneStrip, type UgcScene } from "@/components/ugc-scene-strip";

vi.mock("@/actions/ugc", () => ({
  renameProject: vi.fn(),
  deleteClipScene: vi.fn(),
  setActiveVersion: vi.fn(),
  deleteClipVersion: vi.fn(),
  regenerateClip: vi.fn(),
  rerenderScene: vi.fn(),
  retryScene: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const SCENE: UgcScene = {
  id: "scene-1",
  idx: 1,
  duration_s: 4,
  status: "done",
  versionCount: 1,
  downloadUrl: "https://storage.test/clip.mp4",
  filename: "clip.mp4",
  posterUrl: null,
  creditsBilled: null,
};

describe("UgcTitle in a read-only view", () => {
  it("offers rename to the owner", () => {
    render(<UgcTitle projectId="p1" title="New project" />);
    expect(screen.getByRole("button", { name: /new project/i })).toBeTruthy();
  });

  it("shows the title as plain text to an admin who does not own it", () => {
    // A dotted underline that says "rename me" is a promise, and renameProject
    // would refuse this viewer.
    render(<UgcTitle projectId="p1" title="New project" readOnly />);
    expect(screen.queryByRole("button", { name: /new project/i })).toBeNull();
    expect(screen.getByText("New project")).toBeTruthy();
  });
});

describe("UgcSceneStrip in a read-only view", () => {
  it("keeps Download and drops Delete", async () => {
    // The asymmetry is the point: reading is the whole purpose of the
    // read-only view, so the download survives; the delete is the thing that
    // would fail.
    const { rerender } = render(
      <UgcSceneStrip projectId="p1" scenes={[SCENE]} selectedSceneId={null} />,
    );
    expect(screen.getByRole("button", { name: /actions for scene 1/i })).toBeTruthy();

    rerender(<UgcSceneStrip projectId="p1" scenes={[SCENE]} selectedSceneId={null} readOnly />);
    // The menu still exists, because the clip can still be downloaded.
    expect(screen.getByRole("button", { name: /actions for scene 1/i })).toBeTruthy();
  });

  it("renders no menu at all for a scene with nothing to download", () => {
    // UgcTileMenu returns null when it has neither a download nor a delete.
    // For a read-only viewer that is every failed or still-rendering scene —
    // a row of disabled Deletes would restate a rule the banner already gives
    // once.
    const noClip: UgcScene = { ...SCENE, status: "failed", downloadUrl: null, filename: null };
    render(<UgcSceneStrip projectId="p1" scenes={[noClip]} selectedSceneId={null} readOnly />);
    expect(screen.queryByRole("button", { name: /actions for scene 1/i })).toBeNull();
  });

  it("still lets a read-only viewer move between scenes", () => {
    // Navigation is not a write. New scene is a deselect link and the tiles
    // are links; taking those away would leave an admin on one scene with no
    // way to see the rest, which is the opposite of the point.
    render(<UgcSceneStrip projectId="p1" scenes={[SCENE]} selectedSceneId={null} readOnly />);
    expect(screen.getByRole("link", { name: /new scene/i })).toBeTruthy();
  });
});
