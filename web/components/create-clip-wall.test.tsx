// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { CreateClipWall, type WallItem } from "./create-clip-wall";

vi.mock("@/actions/clip-actions", () => ({ shareClipLink: vi.fn() }));
vi.mock("@/actions/ugc", () => ({
  deleteClipScene: vi.fn(),
  deleteClipVersion: vi.fn(),
  regenerateClip: vi.fn(),
}));
vi.mock("@/components/clip-tile-dialogs", () => ({
  MoveClipDialog: (): null => null,
  SaveClipDialog: (): null => null,
}));
vi.mock("@/lib/video-iterate", () => ({ requestVideoIterate: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  unstable_rethrow: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const clip: WallItem = {
  kind: "clip",
  key: "version-1",
  sceneId: "scene-1",
  versionId: "version-1",
  projectId: "project-1",
  projectTitle: "Product demo",
  personal: true,
  prompt: "A product on a table",
  modelLabel: "Seedance 2.5",
  modelId: "bytedance/seedance-2-5",
  resolution: "480p",
  durationS: 5,
  createdAt: "2026-11-01T00:00:00.000Z",
  url: "https://example.test/clip.mp4",
  filename: "clip-1.mp4",
  referenceTags: [],
  deleteMode: null,
};

describe("CreateClipWall", () => {
  it("shows a wave card without a spinner while a video is rendering", () => {
    const rendering: WallItem = {
      kind: "rendering",
      key: "queued-1",
      prompt: "A product turning slowly on a table",
      queued: false,
    };
    render(<CreateClipWall items={[rendering]} projects={[]} />);

    const card = screen.getByRole("status", { name: "Rendering video" });
    expect(screen.getByText("Rendering video")).toBeTruthy();
    expect(card.querySelector(".animate-spin")).toBeNull();
    expect(card.querySelector(".animate-shimmer")).not.toBeNull();
    expect(screen.queryByText(rendering.prompt)).toBeNull();
  });

  it("opens the selected generated clip directly from a notification link", () => {
    render(<CreateClipWall items={[clip]} projects={[]} initialVersionId="version-1" />);

    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("video")?.getAttribute("src")).toBe(clip.url);
    expect(screen.getByText("Details")).toBeTruthy();
  });

  it("shows average bitrate in video details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, headers: { get: () => "2500000" } })),
    );
    render(<CreateClipWall items={[clip]} projects={[]} initialVersionId="version-1" />);

    const video = screen.getByRole("dialog").querySelector("video")!;
    Object.defineProperties(video, {
      duration: { configurable: true, value: 10 },
      videoWidth: { configurable: true, value: 1280 },
      videoHeight: { configurable: true, value: 720 },
    });
    fireEvent.loadedMetadata(video);

    expect(await screen.findByText("2.0 Mbps")).toBeTruthy();
  });
});
