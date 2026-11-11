// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { deleteClipScene, deleteClipVersion } from "@/actions/ugc";
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

  it("moves selected takes to Bin: a whole scene as a scene, a partial one take by take", async () => {
    vi.mocked(deleteClipScene).mockResolvedValue(undefined as never);
    vi.mocked(deleteClipVersion).mockResolvedValue(undefined as never);
    const take = (key: string, sceneId: string): WallItem => ({
      ...clip,
      key,
      versionId: key,
      sceneId,
      prompt: `Take ${key}`,
      deleteMode: "version",
    });
    render(
      <CreateClipWall
        items={[take("a1", "scene-a"), take("b1", "scene-b"), take("b2", "scene-b")]}
        projects={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("button", { name: /Select clip: Take a1/ }));
    fireEvent.click(screen.getByRole("button", { name: /Select clip: Take b1/ }));
    expect(screen.getByText("2 selected")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Move 2 to Bin" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm: move 2 to Bin" }));

    await waitFor(() => expect(deleteClipScene).toHaveBeenCalledTimes(1));
    // scene-a's only take is selected, so the scene goes; scene-b keeps b2.
    expect(vi.mocked(deleteClipScene).mock.calls[0]![0].get("sceneId")).toBe("scene-a");
    expect(deleteClipVersion).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deleteClipVersion).mock.calls[0]![0].get("versionId")).toBe("b1");
  });

  it("shows the poster and loads no video until hovered when a poster exists", () => {
    const { container } = render(
      <CreateClipWall
        items={[{ ...clip, posterUrl: "https://example.test/poster.jpg" }]}
        projects={[]}
      />,
    );
    const video = container.querySelector("video")!;
    expect(video.getAttribute("poster")).toBe("https://example.test/poster.jpg");
    expect(video.getAttribute("preload")).toBe("none");
  });

  it("still fetches the first frame when a clip has no poster", () => {
    const { container } = render(<CreateClipWall items={[clip]} projects={[]} />);
    expect(container.querySelector("video")!.getAttribute("preload")).toBe("metadata");
  });
});
