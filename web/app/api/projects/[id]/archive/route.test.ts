import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { AuthorizationError, requireProject } from "@/actions/guard";
import { createClient } from "@/lib/supabase/server";
import { signedUrl } from "@/lib/storage";

// Boundary mocks, same convention as actions/project.test.ts: the ownership
// guard, the Supabase client factory, and the storage signing call are all
// faked so this file can drive every branch of the route's own logic
// (authorization outcome, storage-missing outcome, header shape) without a
// real database or a real Supabase Storage bucket. lib/archive.ts and
// lib/manifest.ts are deliberately left real — the whole point of the
// Content-Disposition assertions below is that the ROUTE's use of those
// helpers is safe, not that the helpers are (they have their own test
// files).
vi.mock("@/actions/guard", () => ({
  requireProject: vi.fn(),
  AuthorizationError: class AuthorizationError extends Error {},
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({
  signedUrl: vi.fn(),
}));

const mockedRequireProject = vi.mocked(requireProject);
const mockedCreateClient = vi.mocked(createClient);
const mockedSignedUrl = vi.mocked(signedUrl);

interface SceneRow {
  id: string;
  idx: number;
  script_line: string | null;
  video_prompt: string | null;
  is_talking_head: boolean;
  duration_s: number;
}

interface AssetRow {
  id: string;
  scene_id: string | null;
  kind: "clip" | "final" | "ref_frame" | "character_ref";
  storage_key: string;
}

function makeProject(
  overrides: Partial<{ id: string; title: string; character_desc: string }> = {},
) {
  return {
    id: "proj-1",
    title: "My Project",
    character_desc: "A friendly narrator",
    ...overrides,
  } as never;
}

/** Fakes just the two `.from(...).select(...)...` chains the route awaits:
 * one for scenes, one for assets, each independently erroring or not. */
function stubSupabase({
  scenes,
  scenesError,
  assets,
  assetsError,
  referencedAssets,
  sceneReferences,
  sceneVersions,
}: {
  scenes?: SceneRow[];
  scenesError?: { message: string };
  assets?: AssetRow[];
  assetsError?: { message: string };
  referencedAssets?: AssetRow[];
  sceneReferences?: { asset_id: string }[];
  /** Defaults to none — every scene here falls back to activeClipIdByScene's
   * pre-0058 behaviour (newest clip wins), same as before scene_versions
   * existed, so existing assertions still mean what they say. */
  sceneVersions?: unknown[];
}) {
  return {
    from: (table: string) => {
      if (table === "scenes") {
        return {
          select: () => ({
            eq: () => ({
              order: async () => ({
                data: scenesError ? null : (scenes ?? []),
                error: scenesError ?? null,
              }),
            }),
          }),
        };
      }
      if (table === "assets") {
        return {
          select: () => ({
            eq: async () => ({
              data: assetsError ? null : (assets ?? []),
              error: assetsError ?? null,
            }),
            in: async () => ({
              data: assetsError ? null : (referencedAssets ?? []),
              error: assetsError ?? null,
            }),
          }),
        };
      }
      if (table === "scene_references") {
        return {
          select: () => ({
            in: async () => ({ data: sceneReferences ?? [], error: null }),
          }),
        };
      }
      if (table === "scene_versions") {
        return {
          select: () => ({
            in: async () => ({
              data: sceneVersions ?? [],
              error: null,
            }),
          }),
        };
      }
      throw new Error(`stubSupabase: unexpected table ${table}`);
    },
  } as unknown as ReturnType<typeof createClient> extends Promise<infer T> ? T : never;
}

function makeRequest(scope?: "project"): Request {
  const query = scope ? `?scope=${scope}` : "";
  return new Request(`https://example.test/api/projects/proj-1/archive${query}`);
}

function makeParams(id = "proj-1") {
  return { params: Promise.resolve({ id }) };
}

/** A one-clip, no-final project: the minimal shape that reaches the
 * success path (scenesWithClips.length > 0). */
function oneClipSetup() {
  const scenes: SceneRow[] = [
    {
      id: "scene-1",
      idx: 0,
      script_line: "Hello",
      video_prompt: "prompt",
      is_talking_head: false,
      duration_s: 4,
    },
  ];
  const assets: AssetRow[] = [
    { id: "asset-1", scene_id: "scene-1", kind: "clip", storage_key: "projects/proj-1/clip/a.mp4" },
  ];
  return { scenes, assets };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/projects/[id]/archive — authorization", () => {
  it("refuses a non-owner without minting any signed URL", async () => {
    mockedRequireProject.mockRejectedValue(new AuthorizationError("not your project"));

    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "not your project" });
    // The load-bearing assertion this suite exists for: a route that signs
    // first and refuses after would leak credentials into logs/latency
    // while still returning 403. Status alone can't see that.
    expect(mockedSignedUrl).not.toHaveBeenCalled();
    expect(mockedCreateClient).not.toHaveBeenCalled();
  });

  it("re-throws a non-AuthorizationError rejection (e.g. Next's notFound()) without minting a signed URL", async () => {
    class FakeNotFound extends Error {}
    mockedRequireProject.mockRejectedValue(new FakeNotFound("NEXT_NOT_FOUND"));

    await expect(GET(makeRequest(), makeParams())).rejects.toBeInstanceOf(FakeNotFound);
    expect(mockedSignedUrl).not.toHaveBeenCalled();
  });
});

describe("GET /api/projects/[id]/archive — Content-Disposition filename", () => {
  it("bounds an operator-authored title and neutralises CR/LF/quote header-injection characters", async () => {
    const injected = 'Evil\r\nX-Injected: yes\r\n"' + "A".repeat(2000);
    mockedRequireProject.mockResolvedValue({
      user: { id: "u1", email: "u@test.com" },
      profile: {} as never,
      project: makeProject({ title: injected }),
      reached: {} as never,
    } as never);
    const { scenes, assets } = oneClipSetup();
    mockedCreateClient.mockResolvedValue(stubSupabase({ scenes, assets }));
    mockedSignedUrl.mockResolvedValue("https://signed.example/x");

    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    try {
      const response = await GET(makeRequest(), makeParams());
      const disposition = response.headers.get("Content-Disposition") ?? "";

      // No raw CR/LF reaches the header value — a second header line could
      // not be smuggled in. (The literal text "X-Injected: yes" surviving
      // as inert filename characters is fine; it's the CR/LF that would
      // have turned it into an actual second header.)
      expect(disposition).not.toMatch(/[\r\n]/);
      // No raw double-quote outside the two well-formed filename="..."
      // quote pairs this function itself emits.
      expect(disposition.match(/"/g)?.length).toBe(2);
      // Bounded: lib/archive.ts caps the sanitized title at 100 chars, well
      // under the 1444-char production title this test is modeled on.
      expect(disposition.length).toBeLessThan(300);
      expect(disposition).toMatch(/^attachment; filename="[^"]*\.zip"; filename\*=UTF-8''/);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("GET /api/projects/[id]/archive — success shape", () => {
  it("returns signed URLs built with the archive TTL and a bounded zip stream", async () => {
    mockedRequireProject.mockResolvedValue({
      user: { id: "u1", email: "u@test.com" },
      profile: {} as never,
      project: makeProject(),
      reached: {} as never,
    } as never);
    const { scenes, assets } = oneClipSetup();
    mockedCreateClient.mockResolvedValue(stubSupabase({ scenes, assets }));
    mockedSignedUrl.mockResolvedValue("https://signed.example/clip.mp4");

    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => new Response(new Uint8Array([9, 9, 9]), { status: 200 }));
    try {
      const response = await GET(makeRequest(), makeParams());

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/zip");
      expect(response.headers.get("Content-Disposition")).toContain('filename="My Project.zip"');

      // Every signedUrl() call for this route passes the archive TTL
      // (3600s) — asserted on the actual call args, not just that the mock
      // was called.
      expect(mockedSignedUrl).toHaveBeenCalledWith("projects/proj-1/clip/a.mp4", 3600);
      for (const call of mockedSignedUrl.mock.calls) {
        expect(call[1]).toBe(3600);
      }

      // Drain the stream so the archive actually finishes writing — this
      // also proves the route doesn't hang or error when there's no final
      // asset (finalAsset === null): buildArchiveStream's finalEntry branch
      // is simply skipped.
      const body = response.body;
      expect(body).not.toBeNull();
      const reader = (body as ReadableStream<Uint8Array>).getReader();
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
      }
      expect(total).toBeGreaterThan(0);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("409s with no signed URL minted when there are no finished clips", async () => {
    mockedRequireProject.mockResolvedValue({
      user: { id: "u1", email: "u@test.com" },
      profile: {} as never,
      project: makeProject(),
      reached: {} as never,
    } as never);
    mockedCreateClient.mockResolvedValue(stubSupabase({ scenes: [], assets: [] }));

    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "No finished clips to archive yet." });
    expect(mockedSignedUrl).not.toHaveBeenCalled();
  });

  it("includes project assets in the full project ZIP", async () => {
    mockedRequireProject.mockResolvedValue({
      user: { id: "u1", email: "u@test.com" },
      profile: {} as never,
      project: makeProject(),
      reached: {} as never,
    } as never);
    const { scenes, assets } = oneClipSetup();
    assets.push({
      id: "ref-1",
      scene_id: "scene-1",
      kind: "ref_frame",
      storage_key: "projects/proj-1/frames/start.png",
    });
    mockedCreateClient.mockResolvedValue(
      stubSupabase({
        scenes,
        assets,
        sceneReferences: [{ asset_id: "library-1" }],
        referencedAssets: [
          {
            id: "library-1",
            scene_id: null,
            kind: "character_ref",
            storage_key: "users/u1/character.png",
          },
        ],
      }),
    );
    mockedSignedUrl.mockResolvedValue("https://signed.example/file");

    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => new Response(new Uint8Array([9]), { status: 200 }));
    try {
      const response = await GET(makeRequest("project"), makeParams());
      expect(response.status).toBe(200);
      expect(mockedSignedUrl).toHaveBeenCalledWith("projects/proj-1/frames/start.png", 3600);
      expect(mockedSignedUrl).toHaveBeenCalledWith("users/u1/character.png", 3600);
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      while (!(await reader!.read()).done) {
        // Drain the streamed ZIP so the route completes.
      }
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("GET /api/projects/[id]/archive — missing storage object (line 52's warning)", () => {
  it("502s via the preflight HEAD check instead of starting the 200/zip stream, when a clip has gone missing from storage", async () => {
    mockedRequireProject.mockResolvedValue({
      user: { id: "u1", email: "u@test.com" },
      profile: {} as never,
      project: makeProject(),
      reached: {} as never,
    } as never);
    const { scenes, assets } = oneClipSetup();
    mockedCreateClient.mockResolvedValue(stubSupabase({ scenes, assets }));
    mockedSignedUrl.mockResolvedValue("https://signed.example/gone.mp4");

    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response(null, { status: 404 });
      }
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    try {
      const response = await GET(makeRequest(), makeParams());

      // The preflight catches it before any success framing is built: a
      // clean 502 JSON error, not a 200 with a Content-Disposition header
      // whose body then dies mid-stream.
      expect(response.status).toBe(502);
      expect(response.headers.get("Content-Disposition")).toBeNull();
      const body = await response.json();
      expect(body.error).toMatch(/Missing from storage/);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
