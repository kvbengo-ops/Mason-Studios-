import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadEditorDeleted,
  loadEditorImageRuns,
  loadEditorImages,
  loadEditorVideos,
} from "./admin-creations";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({
  signedUrl: vi.fn(async (key: string) => `https://signed.example/${key}`),
}));

type Row = Record<string, unknown>;

function createFilteringSupabase(tables: Record<string, Row[]>): {
  from: ReturnType<typeof vi.fn>;
} {
  return {
    from: vi.fn((table: string) => {
      let rows = [...(tables[table] ?? [])];
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn((col: string, val: unknown) => {
          rows = rows.filter((r) => r[col] === val);
          return builder;
        }),
        is: vi.fn((col: string, val: unknown) => {
          rows = rows.filter((r) => (r[col] ?? null) === val);
          return builder;
        }),
        not: vi.fn((col: string, op: string, val: unknown) => {
          if (op === "is") {
            rows = rows.filter((r) => (r[col] ?? null) !== val);
          }
          return builder;
        }),
        in: vi.fn((col: string, vals: readonly unknown[]) => {
          const set = new Set(vals);
          rows = rows.filter((r) => set.has(r[col]));
          return builder;
        }),
        or: vi.fn(() => builder),
        order: vi.fn((col: string, opts?: { ascending?: boolean }) => {
          const asc = opts?.ascending ?? true;
          rows.sort((a, b) => {
            const av = String(a[col] ?? "");
            const bv = String(b[col] ?? "");
            return asc ? av.localeCompare(bv) : bv.localeCompare(av);
          });
          return builder;
        }),
        limit: vi.fn((n: number) => {
          rows = rows.slice(0, n);
          return builder;
        }),
        then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve),
      };
      return builder;
    }),
  };
}

afterEach(() => {
  vi.mocked(createClient).mockReset();
});

const EDITOR_A = "11111111-1111-4111-8111-111111111111";
const EDITOR_B = "22222222-2222-4222-8222-222222222222";

describe("admin-creations loaders", () => {
  it("loadEditorImages scopes personal undeleted generated images and runs to target userId", async () => {
    vi.mocked(createClient).mockResolvedValue(
      createFilteringSupabase({
        assets: [
          {
            id: "asset-a-live",
            user_id: EDITOR_A,
            project_id: null,
            kind: "generated_image",
            deleted_at: null,
            created_at: "2026-10-30T10:00:00Z",
            storage_key: "users/a/live.png",
          },
          {
            id: "asset-a-binned",
            user_id: EDITOR_A,
            project_id: null,
            kind: "generated_image",
            deleted_at: "2026-10-30T11:00:00Z",
            created_at: "2026-10-30T09:00:00Z",
            storage_key: "users/a/binned.png",
          },
          {
            id: "asset-a-project",
            user_id: EDITOR_A,
            project_id: "proj-1",
            kind: "generated_image",
            deleted_at: null,
            created_at: "2026-10-30T10:30:00Z",
            storage_key: "projects/1/img.png",
          },
          {
            id: "asset-b-live",
            user_id: EDITOR_B,
            project_id: null,
            kind: "generated_image",
            deleted_at: null,
            created_at: "2026-10-30T12:00:00Z",
            storage_key: "users/b/live.png",
          },
        ],
        runs: [
          {
            id: "run-a",
            user_id: EDITOR_A,
            project_id: null,
            asset_id: "asset-a-live",
            prompt: "Studio bottle shot",
            model: "google/nano-banana",
            cost_usd: 0.04,
          },
          {
            id: "run-b",
            user_id: EDITOR_B,
            project_id: null,
            asset_id: "asset-b-live",
            prompt: "Other editor image",
            model: "google/nano-banana",
            cost_usd: 0.04,
          },
        ],
      }) as never,
    );

    const page = await loadEditorImages(EDITOR_A, null);

    expect(page.images).toEqual([
      {
        assetId: "asset-a-live",
        createdAt: "2026-10-30T10:00:00Z",
        url: "https://signed.example/users/a/live.png",
        prompt: "Studio bottle shot",
        modelLabel: "Nano Banana",
        costUsd: 0.04,
      },
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it("loadEditorImageRuns returns only the target editor's personal image attempts", async () => {
    vi.mocked(createClient).mockResolvedValue(
      createFilteringSupabase({
        runs: [
          {
            id: "run-a-1",
            user_id: EDITOR_A,
            project_id: null,
            idempotency_key: "key-a-1",
            created_at: "2026-10-30T10:00:00Z",
            model: "google/nano-banana",
            error: null,
            settled_at: "2026-10-30T10:00:05Z",
            kie_task_id: "task-a-1",
            asset_id: "asset-a-1",
            cost_usd: 0.04,
          },
          {
            id: "run-a-compile",
            user_id: EDITOR_A,
            project_id: null,
            idempotency_key: null,
            created_at: "2026-10-30T10:05:00Z",
            model: "claude-sonnet-4-6",
            error: null,
            settled_at: "2026-10-30T10:05:01Z",
            kie_task_id: null,
            asset_id: null,
            cost_usd: 0.01,
          },
          {
            id: "run-b-1",
            user_id: EDITOR_B,
            project_id: null,
            idempotency_key: "key-b-1",
            created_at: "2026-10-30T11:00:00Z",
            model: "google/nano-banana",
            error: null,
            settled_at: "2026-10-30T11:00:05Z",
            kie_task_id: "task-b-1",
            asset_id: "asset-b-1",
            cost_usd: 0.04,
          },
        ],
      }) as never,
    );

    const runs = await loadEditorImageRuns(EDITOR_A);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe("run-a-1");
    expect(runs[0]?.status).toBe("completed");
  });

  it("loadEditorVideos scopes to target editor's clip projects and resolves scene overrides via mergeRenderSettings", async () => {
    vi.mocked(createClient).mockResolvedValue(
      createFilteringSupabase({
        projects: [
          {
            id: "proj-a",
            user_id: EDITOR_A,
            kind: "clip",
            title: "Personal clips",
            is_personal: true,
            render_settings: { model: "seedance-2.5", resolution: "480p" },
          },
          {
            id: "proj-b",
            user_id: EDITOR_B,
            kind: "clip",
            title: "Other editor clips",
            is_personal: true,
            render_settings: { model: "seedance-2.5", resolution: "480p" },
          },
        ],
        scenes: [
          {
            id: "scene-a-done",
            project_id: "proj-a",
            status: "done",
            video_prompt: "Creator unboxing",
            duration_s: 5,
            active_version_id: "ver-a-1",
            created_at: "2026-10-30T10:00:00Z",
            is_talking_head: true,
            render_settings_override: { model: "kling-3.0-pro" },
          },
          {
            id: "scene-a-queued",
            project_id: "proj-a",
            status: "queued",
            video_prompt: "Queued clip on override",
            duration_s: 5,
            active_version_id: null,
            created_at: "2026-10-30T10:05:00Z",
            is_talking_head: true,
            render_settings_override: { model: "kling-3.0-pro" },
          },
          {
            id: "scene-b-done",
            project_id: "proj-b",
            status: "done",
            video_prompt: "Stranger scene",
            duration_s: 4,
            active_version_id: "ver-b-1",
            created_at: "2026-10-30T11:00:00Z",
            is_talking_head: false,
            render_settings_override: null,
          },
        ],
        scene_versions: [
          {
            id: "ver-a-1",
            n: 1,
            scene_id: "scene-a-done",
            clip_asset_id: "clip-asset-a",
            video_prompt: "Creator unboxing",
            duration_s: 5,
            render_settings: null,
            created_at: "2026-10-30T10:01:00Z",
          },
          {
            id: "ver-b-1",
            n: 1,
            scene_id: "scene-b-done",
            clip_asset_id: "clip-asset-b",
            video_prompt: "Stranger scene",
            duration_s: 4,
            render_settings: { model: "seedance-2.5" },
            created_at: "2026-10-30T11:01:00Z",
          },
        ],
        assets: [
          { id: "clip-asset-a", storage_key: "projects/proj-a/clip-1.mp4" },
          { id: "clip-asset-b", storage_key: "projects/proj-b/clip-1.mp4" },
        ],
        runs: [
          {
            id: "vrun-a",
            project_id: "proj-a",
            scene_id: "scene-a-done",
            model: "kling-3.0/video",
            prompt: null,
            cost_usd: 0.5,
            error: null,
            created_at: "2026-10-30T10:01:00Z",
          },
          {
            id: "vrun-a-deleted-failed",
            project_id: "proj-a",
            scene_id: null,
            model: "bytedance/seedance-2-5",
            prompt: "Removed failed scene prompt",
            cost_usd: null,
            error: "kie task failed",
            created_at: "2026-10-30T10:00:30Z",
          },
          {
            id: "vrun-b",
            project_id: "proj-b",
            scene_id: "scene-b-done",
            model: "bytedance/seedance-2-fast",
            prompt: null,
            cost_usd: 0.56,
            error: null,
            created_at: "2026-10-30T11:01:00Z",
          },
        ],
      }) as never,
    );

    const { clips, runs } = await loadEditorVideos(EDITOR_A);

    expect(clips).toHaveLength(1);
    expect(clips[0]?.sceneId).toBe("scene-a-done");
    expect(clips[0]?.modelLabel).toBe("Kling 3.0");
    expect(clips[0]?.costUsd).toBe(0.5);
    expect(clips[0]?.url).toBe("https://signed.example/projects/proj-a/clip-1.mp4");

    expect(runs).toHaveLength(3);
    expect(runs[0]?.id).toBe("scene-scene-a-queued");
    expect(runs[0]?.modelLabel).toBe("Kling 3.0");
    expect(runs[1]?.id).toBe("vrun-a");
    expect(runs[1]?.prompt).toBe("Creator unboxing");
    expect(runs[2]).toMatchObject({
      id: "vrun-a-deleted-failed",
      status: "failed",
      modelLabel: "Seedance 2.5",
      prompt: "Removed failed scene prompt",
      costUsd: null,
      reason: "kie task failed",
    });
  });

  it("loadEditorVideos includes scripted-pipeline projects and clips that only hang off assets.scene_id", async () => {
    // What an account made from the Projects page long ago: a scripted
    // project, a finished scene, no scene_versions row, one clip asset. The
    // loader used to filter to kind "clip" and list its runs with nothing to play.
    vi.mocked(createClient).mockResolvedValue(
      createFilteringSupabase({
        projects: [
          {
            id: "proj-old",
            user_id: EDITOR_A,
            kind: "scripted",
            title: "Old campaign",
            is_personal: false,
            render_settings: { model: "seedance-2.5", resolution: "480p" },
          },
          {
            id: "proj-img",
            user_id: EDITOR_A,
            kind: "image",
            title: "Image project",
            is_personal: false,
            render_settings: {},
          },
        ],
        scenes: [
          {
            id: "scene-old",
            project_id: "proj-old",
            status: "done",
            video_prompt: "Old scene",
            duration_s: 6,
            active_version_id: null,
            created_at: "2026-09-01T00:00:00Z",
            is_talking_head: false,
            render_settings_override: null,
          },
        ],
        scene_versions: [],
        assets: [
          {
            id: "asset-old",
            kind: "clip",
            scene_id: "scene-old",
            storage_key: "projects/proj-old/clips/old.mp4",
            created_at: "2026-09-02T00:00:00Z",
          },
        ],
        runs: [],
      }) as never,
    );

    const { clips } = await loadEditorVideos(EDITOR_A);

    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({
      key: "legacy-asset-old",
      sceneId: "scene-old",
      projectTitle: "Old campaign",
      personal: false,
      prompt: "Old scene",
      url: "https://signed.example/projects/proj-old/clips/old.mp4",
    });
  });

  it("loadEditorDeleted scopes to target userId and includes binned images, deleted scenes, and purged archives", async () => {
    vi.mocked(createClient).mockResolvedValue(
      createFilteringSupabase({
        deleted_scenes: [
          {
            scene_id: "del-scene-a",
            project_id: "proj-a",
            user_id: EDITOR_A,
            scene_idx: 2,
            deleted_at: "2026-10-30T12:00:00Z",
            hard_deleted_at: "2026-10-30T13:00:00Z",
            scene: {
              video_prompt: "Deleted scene prompt",
              render_settings_override: { model: "kling-3.0-pro" },
            },
            assets: [{ kind: "poster", storage_key: "projects/proj-a/poster.jpg" }],
            versions: [{ id: "v1" }, { id: "v2" }],
          },
          {
            scene_id: "del-scene-b",
            project_id: "proj-b",
            user_id: EDITOR_B,
            scene_idx: 1,
            deleted_at: "2026-10-30T12:00:00Z",
            hard_deleted_at: null,
            scene: { video_prompt: "Other editor deleted scene" },
            assets: [],
            versions: [],
          },
        ],
        deleted_scene_versions: [
          {
            version_id: "del-ver-a",
            scene_id: "scene-a",
            project_id: "proj-a",
            user_id: EDITOR_A,
            n: 3,
            deleted_at: "2026-10-30T12:30:00Z",
            hard_deleted_at: null,
            version: {
              video_prompt: "Deleted take prompt",
              render_settings: { model: "seedance-2.5" },
            },
            clip_asset: { kind: "clip", storage_key: "projects/proj-a/take-3.mp4" },
          },
          {
            version_id: "del-ver-b",
            scene_id: "scene-b",
            project_id: "proj-b",
            user_id: EDITOR_B,
            n: 1,
            deleted_at: "2026-10-30T12:30:00Z",
            hard_deleted_at: null,
            version: { video_prompt: "Other editor take" },
            clip_asset: null,
          },
        ],
        assets: [
          {
            id: "img-a-binned",
            user_id: EDITOR_A,
            project_id: null,
            kind: "generated_image",
            storage_key: "users/a/binned.png",
            created_at: "2026-10-30T08:00:00Z",
            deleted_at: "2026-10-30T14:00:00Z",
          },
          {
            id: "img-a-live",
            user_id: EDITOR_A,
            project_id: null,
            kind: "generated_image",
            storage_key: "users/a/live.png",
            created_at: "2026-10-30T08:00:00Z",
            deleted_at: null,
          },
          {
            id: "img-b-binned",
            user_id: EDITOR_B,
            project_id: null,
            kind: "generated_image",
            storage_key: "users/b/binned.png",
            created_at: "2026-10-30T08:00:00Z",
            deleted_at: "2026-10-30T14:00:00Z",
          },
        ],
        projects: [
          {
            id: "proj-a",
            user_id: EDITOR_A,
            render_settings: { model: "seedance-2.5", resolution: "480p" },
          },
        ],
        runs: [
          {
            id: "run-binned",
            user_id: EDITOR_A,
            project_id: null,
            asset_id: "img-a-binned",
            prompt: "Binned bottle prompt",
            model: "google/nano-banana",
            cost_usd: 0.04,
          },
        ],
      }) as never,
    );

    const deleted = await loadEditorDeleted(EDITOR_A);

    expect(deleted.scenes).toEqual([
      {
        sceneId: "del-scene-a",
        projectId: "proj-a",
        idx: 2,
        prompt: "Deleted scene prompt",
        modelLabel: "Kling 3.0",
        deletedAt: "2026-10-30T12:00:00Z",
        purged: true,
        versionCount: 2,
        thumbnail: { kind: "image", url: "https://signed.example/projects/proj-a/poster.jpg" },
      },
    ]);
    expect(deleted.versions).toEqual([
      {
        versionId: "del-ver-a",
        sceneId: "scene-a",
        projectId: "proj-a",
        n: 3,
        prompt: "Deleted take prompt",
        modelLabel: "Seedance 2.5",
        deletedAt: "2026-10-30T12:30:00Z",
        purged: false,
        thumbnail: { kind: "video", url: "https://signed.example/projects/proj-a/take-3.mp4" },
      },
    ]);
    expect(deleted.images).toEqual([
      {
        assetId: "img-a-binned",
        createdAt: "2026-10-30T08:00:00Z",
        deletedAt: "2026-10-30T14:00:00Z",
        prompt: "Binned bottle prompt",
        modelLabel: "Nano Banana",
        costUsd: 0.04,
        thumbnail: { kind: "image", url: "https://signed.example/users/a/binned.png" },
      },
    ]);
  });
});
