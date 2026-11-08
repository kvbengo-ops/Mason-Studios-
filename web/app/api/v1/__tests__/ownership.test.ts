import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import type * as StorageModule from "@/lib/storage";

vi.mock("@/lib/api-auth", () => ({ requireApiToken: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof StorageModule>();
  return { ...actual, removeStorageObjects: vi.fn(), uploadFile: vi.fn() };
});

import { requireApiToken } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/server";
import { MAX_REFERENCE_IMAGE_BYTES } from "@/lib/file-type";
import { resolveApiReferences } from "@/lib/api-references";
import { POST as postElements } from "../elements/route";
import { GET as getJob } from "../jobs/[id]/route";

const userA = "11111111-1111-4111-8111-111111111111";
const userB = "22222222-2222-4222-8222-222222222222";
const jobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const uploadModes = [
  { label: "direct", staged: false },
  { label: "staged", staged: true },
] as const;

const auth = {
  ok: true,
  userId: userA,
  tokenId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  tokenPrefix: "ms_live_test",
  scopes: ["read", "upload", "generate"],
  monthlyCapUsd: null,
  profile: {} as never,
} as const;

const mockedRequireApiToken = vi.mocked(requireApiToken);
const mockedCreateAdminClient = vi.mocked(createAdminClient);

function fakeFile(data: Uint8Array, name: string, type = "application/octet-stream"): File {
  return new File([Uint8Array.from(data)], name, { type });
}

function makeUploadAdmin(data: Blob) {
  const download = vi.fn(async () => ({ data, error: null }));
  const remove = vi.fn(async () => ({ data: [], error: null }));
  return {
    client: {
      storage: { from: vi.fn(() => ({ download, remove })) },
    } as unknown as ReturnType<typeof createAdminClient>,
    download,
    remove,
  };
}

function elementRequest(file?: File, stagedKey?: string): Request {
  const form = new FormData();
  form.set("name", "sample_asset");
  if (file) form.set("file", file);
  if (stagedKey) {
    form.set("staged_key", stagedKey);
    form.set("filename", "sample.mp4");
    form.set("content_type", "video/mp4");
  }
  return new Request("https://example.test/api/v1/elements", { method: "POST", body: form });
}

async function postInvalidUpload(file: File, staged: boolean): Promise<Response> {
  const stagedKey = `staging/${userA}/33333333-3333-4333-8333-333333333333`;
  const storage = makeUploadAdmin(new Blob([await file.arrayBuffer()], { type: file.type }));
  mockedCreateAdminClient.mockReturnValue(storage.client);
  return postElements(elementRequest(staged ? undefined : file, staged ? stagedKey : undefined));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("API v1 ownership", () => {
  it("rejects a foreign element reference before loading its asset", async () => {
    const client = {
      from: (table: string) => {
        if (table !== "elements") throw new Error(`Unexpected table ${table}`);
        let selectedUser: string | null = null;
        let selectedId: string | null = null;
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: (column: string, value: string) => {
            if (column === "user_id") selectedUser = value;
            if (column === "id") selectedId = value;
            return builder;
          },
          is: () => builder,
          maybeSingle: async () => ({
            data: selectedId === "foreign-element" ? { id: selectedId, user_id: userB } : null,
            error: null,
          }),
          then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
            Promise.resolve(
              selectedUser === userA ? { data: [], error: null } : { data: null, error: null },
            ).then(resolve, reject),
        };
        return builder;
      },
    } as unknown as SupabaseClient<Database>;

    const result = await resolveApiReferences({
      admin: client,
      userId: userA,
      modelId: "seedance-2.5",
      resolution: "480p",
      prompt: "@Image 1 waves",
      imageRefs: ["foreign-element"],
    });

    expect(result).toMatchObject({ ok: false, status: 403, code: "forbidden_reference" });
  });

  it("returns 404 when a caller polls another user's job", async () => {
    mockedRequireApiToken.mockResolvedValue(auth as never);
    const from = vi.fn((table: string) => {
      let filters: Record<string, string> = {};
      const builder = {
        select: () => builder,
        eq: (column: string, value: string) => {
          filters = { ...filters, [column]: value };
          return builder;
        },
        maybeSingle: async () =>
          table === "scenes"
            ? {
                data: {
                  id: jobId,
                  project_id: projectId,
                  status: "done",
                  video_prompt: "private prompt",
                  ai_generated_prompt: null,
                  duration_s: 4,
                  is_talking_head: false,
                  render_settings_override: null,
                  estimated_cost_usd: 0.56,
                },
                error: null,
              }
            : filters.user_id === userA
              ? { data: null, error: null }
              : { data: { id: projectId, user_id: userB, render_settings: null }, error: null },
      };
      return builder;
    });
    mockedCreateAdminClient.mockReturnValue({ from } as never);

    const response = await getJob(new Request(`https://example.test/api/v1/jobs/${jobId}`), {
      params: Promise.resolve({ id: jobId }),
    });

    expect(response.status).toBe(404);
    expect(from).toHaveBeenCalledTimes(2);
  });

  it("rejects staged keys belonging to another user", async () => {
    mockedRequireApiToken.mockResolvedValue(auth as never);
    const storage = makeUploadAdmin(new Blob([new Uint8Array([0, 1, 2])]));
    mockedCreateAdminClient.mockReturnValue(storage.client);

    const response = await postElements(
      elementRequest(undefined, `staging/${userB}/33333333-3333-4333-8333-333333333333`),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "forbidden_staged_key" });
    expect(storage.download).not.toHaveBeenCalled();
  });

  it.each(uploadModes)("uses the same signature check for $label uploads", async ({ staged }) => {
    mockedRequireApiToken.mockResolvedValue(auth as never);
    const response = await postInvalidUpload(
      fakeFile(new Uint8Array([0, 1, 2]), "bad.bin"),
      staged,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_media_file" });
  });

  it.each(uploadModes)("uses the same size check for $label uploads", async ({ staged }) => {
    mockedRequireApiToken.mockResolvedValue(auth as never);
    const bytes = new Uint8Array(MAX_REFERENCE_IMAGE_BYTES + 1);
    bytes.set([0xff, 0xd8, 0xff]);
    const response = await postInvalidUpload(fakeFile(bytes, "large.jpg", "image/jpeg"), staged);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "file_too_large" });
  });

  it.each(uploadModes)(
    "uses the same MP4 duration check for $label uploads",
    async ({ staged }) => {
      mockedRequireApiToken.mockResolvedValue(auth as never);
      const bytes = new Uint8Array(12);
      bytes.set([0, 0, 0, 12], 0);
      bytes.set([0x66, 0x74, 0x79, 0x70], 4);
      const response = await postInvalidUpload(fakeFile(bytes, "bad.mp4", "video/mp4"), staged);

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({ code: "invalid_media_file" });
    },
  );
});
