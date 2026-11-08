import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import type * as ApiClipModule from "@/lib/api-clip";
import type * as StorageModule from "@/lib/storage";

vi.mock("@/lib/api-auth", () => ({ requireApiToken: vi.fn() }));
vi.mock("@/lib/api-references", () => ({
  attachApiSceneReferences: vi.fn(),
  ensurePersonalClipProjectForUser: vi.fn(async () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
}));
vi.mock("@/lib/api-clip", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClipModule>();
  return {
    ...actual,
    prepareApiClip: vi.fn(),
    apiClipQuote: vi.fn(() => ({ estimated_cost_usd: 0.56 })),
  };
});
vi.mock("@/lib/spend", () => ({ queueScenesIfWithinCaps: vi.fn() }));
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof StorageModule>();
  return { ...actual, removeStorageObjects: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/mode", () => ({ isDev: () => true }));

import { requireApiToken } from "@/lib/api-auth";
import { attachApiSceneReferences } from "@/lib/api-references";
import {
  apiGenerateRequestHash,
  discardOwnedPreparation,
  sweepAbandonedApiScenes,
} from "@/lib/api-generation";
import { prepareApiClip } from "@/lib/api-clip";
import { queueScenesIfWithinCaps } from "@/lib/spend";
import { removeStorageObjects } from "@/lib/storage";
import { createAdminClient } from "@/lib/supabase/server";
import type { ApiClipInput } from "@/lib/api-clip";
import { POST } from "../generate/route";

const userId = "11111111-1111-4111-8111-111111111111";
const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sceneId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tokenId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const idempotencyKey = "same-render-request";
const auth = {
  ok: true,
  userId,
  tokenId,
  tokenPrefix: "ms_live_test",
  scopes: ["read", "upload", "generate"],
  monthlyCapUsd: null,
  profile: { id: userId } as never,
} as const;
const input: ApiClipInput = {
  prompt: "A quiet sunrise over the sea",
  modelId: "seedance-2.5",
  resolution: "480p",
  durationS: 4,
  isTalkingHead: false,
  imageRefs: [],
  videoRefs: [],
  audioRefs: [],
};
const requestHash = apiGenerateRequestHash(input);
const prepared = {
  ok: true as const,
  input,
  references: {
    rewrittenPrompt: input.prompt,
    submittedPrompt: input.prompt,
    providerReferencePrompt: input.prompt,
    explicitOrderedTags: [],
    orderedReferences: { images: [], videos: [], audios: [] },
    videoReferenceDurationsS: [],
    primaryRef: null,
  },
  settings: { model: input.modelId, resolution: input.resolution } as never,
  estimatedCostUsd: 0.56,
  quote: {} as never,
};

const mockedRequireApiToken = vi.mocked(requireApiToken);
const mockedAttach = vi.mocked(attachApiSceneReferences);
const mockedPrepare = vi.mocked(prepareApiClip);
const mockedQueue = vi.mocked(queueScenesIfWithinCaps);
const mockedRemove = vi.mocked(removeStorageObjects);
const mockedCreateAdmin = vi.mocked(createAdminClient);

interface SceneState {
  id: string;
  project_id: string;
  status: string;
  idempotency_key: string;
  idempotency_hash: string;
  prepare_token: string;
  prepare_started_at: string;
  estimated_cost_usd: number | null;
}

function request(): Request {
  return new Request("https://example.test/api/v1/generate", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: input.prompt,
      model_id: input.modelId,
      resolution: input.resolution,
      duration_s: input.durationS,
    }),
  });
}

function setupGeneration(initialScene: SceneState | null, initialReads = 0) {
  const initialSnapshot = initialScene ? { ...initialScene } : null;
  const state: { scene: SceneState | null; initialReads: number } = {
    scene: initialScene,
    initialReads,
  };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "delete_abandoned_api_scene") return { data: [], error: null };
    if (name === "insert_frame_ready_scene") {
      if (!state.scene) {
        state.scene = {
          id: sceneId,
          project_id: projectId,
          status: "frame_ready",
          idempotency_key: idempotencyKey,
          idempotency_hash: requestHash,
          prepare_token: String(args.p_prepare_token),
          prepare_started_at: new Date().toISOString(),
          estimated_cost_usd: null,
        };
        return {
          data: [
            {
              outcome: "inserted",
              scene_id: sceneId,
              scene_status: "frame_ready",
              idempotency_hash: requestHash,
              prepare_token: state.scene.prepare_token,
              prepare_started_at: state.scene.prepare_started_at,
            },
          ],
          error: null,
        };
      }
      return {
        data: [
          {
            outcome: "existing",
            scene_id: state.scene.id,
            scene_status: state.scene.status,
            idempotency_hash: state.scene.idempotency_hash,
            prepare_token: state.scene.prepare_token,
            prepare_started_at: state.scene.prepare_started_at,
          },
        ],
        error: null,
      };
    }
    if (name === "reclaim_stale_frame_ready_scene") {
      const current = state.scene;
      if (
        current &&
        current.status === "frame_ready" &&
        current.prepare_token === args.p_expected_prepare_token &&
        Date.parse(current.prepare_started_at) < Date.now() - 15_000
      ) {
        current.prepare_token = String(args.p_new_prepare_token);
        current.prepare_started_at = new Date().toISOString();
        return { data: [{ claimed: true, superseded_keys: [] }], error: null };
      }
      return { data: [{ claimed: false, superseded_keys: [] }], error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });

  const admin = {
    from: (table: string) => {
      let selection = "";
      const filters: Record<string, string> = {};
      const builder = {
        select: (columns: string) => {
          selection = columns;
          return builder;
        },
        eq: (column: string, value: string) => {
          filters[column] = value;
          return builder;
        },
        not: () => builder,
        lt: () => builder,
        order: () => builder,
        limit: async () => ({ data: [], error: null }),
        maybeSingle: async () => {
          if (table === "projects") return { data: { id: projectId }, error: null };
          if (table !== "scenes") throw new Error(`Unexpected table ${table}`);
          const scene = state.scene;
          if (
            !scene ||
            filters.project_id !== projectId ||
            (filters.id !== undefined && filters.id !== scene.id)
          ) {
            return { data: null, error: null };
          }
          if (selection.includes("idempotency_hash")) {
            if (state.initialReads > 0) {
              state.initialReads -= 1;
              return { data: { ...scene, ...initialSnapshot! }, error: null };
            }
            if (filters.idempotency_key !== idempotencyKey) return { data: null, error: null };
          }
          return { data: { ...scene }, error: null };
        },
      };
      return builder;
    },
    rpc,
  } as unknown as SupabaseClient<Database>;

  mockedCreateAdmin.mockReturnValue(admin as never);
  return { state, rpc };
}

function staleScene(): SceneState {
  return {
    id: sceneId,
    project_id: projectId,
    status: "frame_ready",
    idempotency_key: idempotencyKey,
    idempotency_hash: requestHash,
    prepare_token: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    prepare_started_at: new Date(Date.now() - 20_000).toISOString(),
    estimated_cost_usd: 0.56,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/generate idempotency", () => {
  it("returns 409 when an idempotency key is reused with another payload", async () => {
    const prior = staleScene();
    prior.idempotency_hash = "different-payload-hash";
    setupGeneration(prior);
    mockedRequireApiToken.mockResolvedValue(auth as never);

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "idempotency_conflict" });
    expect(mockedPrepare).not.toHaveBeenCalled();
    expect(mockedQueue).not.toHaveBeenCalled();
  });

  it("lets only one of two simultaneous stale retries reclaim and queue", async () => {
    const { rpc, state } = setupGeneration(staleScene(), 2);
    mockedRequireApiToken.mockResolvedValue(auth as never);
    mockedPrepare.mockResolvedValue(prepared as never);
    mockedAttach.mockResolvedValue({ attachedStorageKeys: [], fenced: false });
    mockedQueue.mockImplementation(async ({ prepareToken }) => {
      if (state.scene?.status !== "frame_ready" || state.scene.prepare_token !== prepareToken) {
        return { outcome: "fenced" } as never;
      }
      state.scene.status = "queued";
      return { outcome: "queued" } as never;
    });

    const [first, second] = await Promise.all([POST(request()), POST(request())]);
    const firstBody = await first.json();
    const secondBody = await second.json();

    expect(
      rpc.mock.calls.filter(([name]) => name === "reclaim_stale_frame_ready_scene"),
    ).toHaveLength(2);
    expect(mockedAttach).toHaveBeenCalledTimes(1);
    expect(mockedQueue).toHaveBeenCalledTimes(1);
    expect([firstBody.deduplicated, secondBody.deduplicated].sort()).toEqual([false, true]);
    expect([200, 202]).toContain(first.status);
    expect([200, 202]).toContain(second.status);
  });

  it("fences a slow original attempt after recovery and removes only its own copies", async () => {
    const { state } = setupGeneration(null);
    mockedRequireApiToken.mockResolvedValue(auth as never);
    mockedPrepare.mockResolvedValue(prepared as never);

    let releaseFirstAttach!: (value: { attachedStorageKeys: string[]; fenced: boolean }) => void;
    let markFirstAttachStarted!: () => void;
    const firstAttachStarted = new Promise<void>((resolve) => {
      markFirstAttachStarted = resolve;
    });
    const firstAttach = new Promise<{ attachedStorageKeys: string[]; fenced: boolean }>(
      (resolve) => {
        releaseFirstAttach = resolve;
      },
    );
    mockedAttach
      .mockImplementationOnce(async () => {
        markFirstAttachStarted();
        return firstAttach;
      })
      .mockResolvedValueOnce({
        attachedStorageKeys: ["projects/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/recovered.png"],
        fenced: false,
      });
    mockedQueue.mockImplementation(async ({ prepareToken }) => {
      if (state.scene?.prepare_token !== prepareToken || state.scene.status !== "frame_ready") {
        return { outcome: "fenced" } as never;
      }
      state.scene.status = "queued";
      return { outcome: "queued" } as never;
    });

    const originalRequest = POST(request());
    await firstAttachStarted;
    state.scene!.prepare_started_at = new Date(Date.now() - 20_000).toISOString();

    const recoveryResponse = await POST(request());
    expect(recoveryResponse.status).toBe(202);
    expect(state.scene?.status).toBe("queued");
    const recoveredToken = state.scene?.prepare_token;

    releaseFirstAttach({
      attachedStorageKeys: ["projects/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/original.png"],
      fenced: true,
    });
    const originalResponse = await originalRequest;
    const originalBody = await originalResponse.json();

    expect(originalResponse.status).toBe(200);
    expect(originalBody).toMatchObject({ job_id: sceneId, deduplicated: true, status: "queued" });
    expect(mockedQueue).toHaveBeenCalledTimes(1);
    expect(mockedQueue.mock.calls[0]![0].prepareToken).toBe(recoveredToken);
    expect(mockedRemove).toHaveBeenCalledWith([
      "projects/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/original.png",
    ]);
    expect(mockedRemove).not.toHaveBeenCalledWith([
      "projects/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/recovered.png",
    ]);
    expect(state.scene?.status).toBe("queued");
  });
});

describe("API preparation cleanup fencing", () => {
  it("does not delete assets or storage after another attempt rotates the lease", async () => {
    const assetDelete = vi.fn();
    const assetsBuilder: Record<string, unknown> = {
      select: () => assetsBuilder,
      eq: () => assetsBuilder,
      then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve({ data: [{ id: "scene-copy-asset" }], error: null }).then(resolve, reject),
      delete: assetDelete,
    };
    const sceneFilters: Record<string, string> = {};
    const sceneBuilder = {
      delete: () => sceneBuilder,
      eq: (column: string, value: string) => {
        sceneFilters[column] = value;
        return sceneBuilder;
      },
      select: () => sceneBuilder,
      maybeSingle: async () => ({ data: null, error: null }),
    };
    const admin = {
      from: (table: string) => (table === "assets" ? assetsBuilder : sceneBuilder),
    } as unknown as SupabaseClient<Database>;

    await expect(
      discardOwnedPreparation({
        admin,
        projectId,
        sceneId,
        prepareToken: "superseded-token",
        storageKeys: ["projects/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/original.png"],
      }),
    ).resolves.toBe(false);

    expect(assetDelete).not.toHaveBeenCalled();
    expect(mockedRemove).not.toHaveBeenCalled();
    expect(sceneFilters.prepare_token).toBe("superseded-token");
  });

  it("does not clean a sweeper candidate when the same attempt refreshed its lease", async () => {
    const staleTimestamp = new Date(Date.now() - 6 * 60_000).toISOString();
    const refreshedScene = { prepare_token: "attempt-token", prepare_started_at: staleTimestamp };
    const candidate = {
      id: sceneId,
      prepare_token: refreshedScene.prepare_token,
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      not: () => builder,
      lt: () => builder,
      order: () => builder,
      limit: async () => ({ data: [candidate], error: null }),
    };
    const rpc = vi.fn(async () => {
      refreshedScene.prepare_started_at = new Date().toISOString();
      return { data: [], error: null };
    });
    const admin = {
      from: () => builder,
      rpc,
    } as unknown as SupabaseClient<Database>;

    await sweepAbandonedApiScenes(admin);

    expect(Date.parse(refreshedScene.prepare_started_at)).toBeGreaterThan(
      Date.parse(staleTimestamp),
    );
    expect(rpc).toHaveBeenCalledWith("delete_abandoned_api_scene", {
      p_scene_id: sceneId,
      p_prepare_token: "attempt-token",
    });
    expect(mockedRemove).not.toHaveBeenCalled();
  });

  it("removes only the scene-scoped keys returned by a successful sweep", async () => {
    const sceneKey = `projects/${projectId}/ref_frame/copied.png`;
    const sharedElementKey = `users/${userId}/ref_frame/shared.png`;
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      not: () => builder,
      lt: () => builder,
      order: () => builder,
      limit: async () => ({
        data: [{ id: sceneId, prepare_token: "abandoned-token" }],
        error: null,
      }),
    };
    const rpc = vi.fn(async () => ({
      data: [{ scene_id: sceneId, storage_keys: [sceneKey] }],
      error: null,
    }));
    const admin = {
      from: () => builder,
      rpc,
    } as unknown as SupabaseClient<Database>;

    await sweepAbandonedApiScenes(admin);

    expect(mockedRemove).toHaveBeenCalledWith([sceneKey]);
    expect(mockedRemove).not.toHaveBeenCalledWith([sharedElementKey]);
  });
});
