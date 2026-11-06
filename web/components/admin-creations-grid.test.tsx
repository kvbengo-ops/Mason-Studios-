// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AdminCreationsGrid } from "./admin-creations-grid";

afterEach(cleanup);

const FORBIDDEN_BUTTON_PATTERN =
  /delete|restore|iterate|reuse|generate|download|remove|save to elements/i;

describe("AdminCreationsGrid", () => {
  it("renders personal images and attempts with no mutating or download controls", () => {
    render(
      <AdminCreationsGrid
        tab="images"
        images={[
          {
            assetId: "img-1",
            createdAt: "2026-10-30T10:00:00Z",
            url: "https://signed.example/img-1.png",
            prompt: "A minimalist skincare bottle on marble",
            modelLabel: "Nano Banana",
            costUsd: 0.04,
          },
        ]}
        imageRuns={[
          {
            runId: "run-1",
            idempotencyKey: "key-1",
            createdAt: "2026-10-30T10:00:00Z",
            status: "completed",
            model: "google/nano-banana",
            modelLabel: "Nano Banana",
            kieTaskId: "task-1",
            reason: null,
            assetId: "img-1",
            costUsd: 0.04,
          },
        ]}
      />,
    );

    expect(screen.getByText("A minimalist skincare bottle on marble")).toBeTruthy();
    expect(screen.getAllByText("Nano Banana").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("$0.04").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: FORBIDDEN_BUTTON_PATTERN })).toBeNull();
    expect(screen.queryByRole("link", { name: FORBIDDEN_BUTTON_PATTERN })).toBeNull();
  });

  it("renders video clips with <video controls> and no mutating or download controls", () => {
    const { container } = render(
      <AdminCreationsGrid
        tab="videos"
        clips={[
          {
            key: "ver-1",
            sceneId: "scene-1",
            versionId: "ver-1",
            n: 2,
            projectId: "proj-1",
            projectTitle: "Summer Launch",
            personal: false,
            prompt: "Creator holding bottle to camera",
            modelLabel: "Seedance 2.5",
            durationS: 4,
            createdAt: "2026-10-30T11:00:00Z",
            url: "https://signed.example/clip-1.mp4",
            costUsd: 0.56,
          },
        ]}
        videoRuns={[
          {
            id: "vrun-1",
            createdAt: "2026-10-30T11:00:00Z",
            status: "done",
            modelLabel: "Seedance 2.5",
            prompt: "Creator holding bottle to camera",
            costUsd: 0.56,
            reason: null,
            returnedUsd: null,
          },
        ]}
      />,
    );

    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.hasAttribute("controls")).toBe(true);
    expect(screen.getAllByText("Creator holding bottle to camera").length).toBeGreaterThanOrEqual(
      1,
    );
    expect(screen.getAllByText("$0.56").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: FORBIDDEN_BUTTON_PATTERN })).toBeNull();
    expect(screen.queryByRole("link", { name: FORBIDDEN_BUTTON_PATTERN })).toBeNull();
  });

  it("renders deleted scenes, deleted takes, and binned images with Purged badges and no restore/delete buttons", () => {
    render(
      <AdminCreationsGrid
        tab="deleted"
        deleted={{
          scenes: [
            {
              sceneId: "del-scene-1",
              projectId: "proj-1",
              idx: 1,
              prompt: "Archived scene prompt",
              modelLabel: "Kling 3.0",
              deletedAt: "2026-10-30T12:00:00Z",
              purged: true,
              versionCount: 2,
              thumbnail: { kind: "image", url: "https://signed.example/poster.jpg" },
            },
          ],
          versions: [
            {
              versionId: "del-ver-1",
              sceneId: "scene-1",
              projectId: "proj-1",
              n: 3,
              prompt: "Archived take prompt",
              modelLabel: "Seedance 2.5",
              deletedAt: "2026-10-30T12:30:00Z",
              purged: false,
              thumbnail: { kind: "video", url: "https://signed.example/take.mp4" },
            },
          ],
          images: [
            {
              assetId: "del-img-1",
              createdAt: "2026-10-30T09:00:00Z",
              deletedAt: "2026-10-30T13:00:00Z",
              prompt: "Binned generated image prompt",
              modelLabel: "Nano Banana",
              costUsd: 0.04,
              thumbnail: { kind: "image", url: "https://signed.example/binned.png" },
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Archived scene prompt")).toBeTruthy();
    expect(screen.getByText("Archived take prompt")).toBeTruthy();
    expect(screen.getByText("Binned generated image prompt")).toBeTruthy();
    expect(screen.getByText("Purged")).toBeTruthy();
    // Includes two section headings and one deleted-at badge per item.
    expect(screen.getAllByText(/^Deleted /).length).toBe(5);
    expect(screen.queryByRole("button", { name: FORBIDDEN_BUTTON_PATTERN })).toBeNull();
    expect(screen.queryByRole("link", { name: FORBIDDEN_BUTTON_PATTERN })).toBeNull();
  });
});
