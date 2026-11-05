import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { AuthorizationError, requireProjectReadable } from "@/actions/guard";
import { createClient } from "@/lib/supabase/server";

// Same boundary-mock convention as the archive route's own test file and
// actions/project.test.ts: fake the guard and the Supabase client factory,
// leave lib/brief-csv.ts and lib/csv.ts real (they have their own unit
// tests — this file is about the ROUTE's use of the permissive guard and
// its response framing, not CSV quoting).
vi.mock("@/actions/guard", () => ({
  requireProjectReadable: vi.fn(),
  AuthorizationError: class AuthorizationError extends Error {},
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

const mockedRequireProjectReadable = vi.mocked(requireProjectReadable);
const mockedCreateClient = vi.mocked(createClient);

interface SceneRow {
  idx: number;
  script_line: string | null;
  video_prompt: string | null;
  is_talking_head: boolean;
  duration_s: number;
}

function stubSupabase({ scenes, error }: { scenes?: SceneRow[]; error?: { message: string } }) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: async () => ({ data: error ? null : (scenes ?? []), error: error ?? null }),
        }),
      }),
    }),
  } as unknown as ReturnType<typeof createClient> extends Promise<infer T> ? T : never;
}

function makeRequest(): Request {
  return new Request("https://example.test/api/projects/proj-1/brief-csv");
}

function makeParams(id = "proj-1") {
  return { params: Promise.resolve({ id }) };
}

const scenes: SceneRow[] = [
  {
    idx: 0,
    script_line: "Hello, world",
    video_prompt: "a prompt",
    is_talking_head: true,
    duration_s: 4,
  },
];

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/projects/[id]/brief-csv — permissive guard admits a non-owning admin", () => {
  it("returns 200 for a caller requireProjectReadable admits with isOwner: false", async () => {
    // This is the exact case the strict guard broke on Deliver: a
    // non-owning admin who was let into the Brief page must also be let
    // into this download. isOwner: false here models that admin, not the
    // project's owner.
    mockedRequireProjectReadable.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.com" },
      profile: {} as never,
      project: { title: "Some User's Project" } as never,
      reached: {} as never,
      isOwner: false,
    } as never);
    mockedCreateClient.mockResolvedValue(stubSupabase({ scenes }));

    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    const text = await response.text();
    expect(text).toContain("Hello, world");
  });
});

describe("GET /api/projects/[id]/brief-csv — authorization refusal", () => {
  it("refuses an unauthorized caller with 403 and never queries scenes", async () => {
    mockedRequireProjectReadable.mockRejectedValue(new AuthorizationError("not allowed"));

    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "not allowed" });
    expect(mockedCreateClient).not.toHaveBeenCalled();
  });

  it("re-throws a non-AuthorizationError rejection (e.g. Next's notFound()) rather than swallowing it", async () => {
    class FakeNotFound extends Error {}
    mockedRequireProjectReadable.mockRejectedValue(new FakeNotFound("NEXT_NOT_FOUND"));

    await expect(GET(makeRequest(), makeParams())).rejects.toBeInstanceOf(FakeNotFound);
  });
});

describe("GET /api/projects/[id]/brief-csv — content type and filename", () => {
  it("emits a UTF-8 BOM-prefixed CSV body and a bounded, injection-safe filename", async () => {
    const injectedTitle = 'Evil\r\nX-Injected: yes\r\n"' + "A".repeat(2000);
    mockedRequireProjectReadable.mockResolvedValue({
      user: { id: "u1", email: "u@test.com" },
      profile: {} as never,
      project: { title: injectedTitle } as never,
      reached: {} as never,
      isOwner: true,
    } as never);
    mockedCreateClient.mockResolvedValue(stubSupabase({ scenes }));

    const response = await GET(makeRequest(), makeParams());

    const disposition = response.headers.get("Content-Disposition") ?? "";
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).toMatch(/^attachment; filename="[^"]*-brief\.csv"; filename\*=UTF-8''/);
    expect(disposition.length).toBeLessThan(300);

    // response.text() decodes via TextDecoder, which strips a leading BOM
    // by default — read raw bytes instead to prove the route actually
    // wrote the BOM's 3 bytes (EF BB BF) onto the wire.
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("500s and never builds a CSV or filename when the scenes query errors", async () => {
    mockedRequireProjectReadable.mockResolvedValue({
      user: { id: "u1", email: "u@test.com" },
      profile: {} as never,
      project: { title: "Some Project" } as never,
      reached: {} as never,
      isOwner: true,
    } as never);
    mockedCreateClient.mockResolvedValue(stubSupabase({ error: { message: "db exploded" } }));

    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toMatch(/db exploded/);
  });
});
