import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { AuthorizationError, requireAdmin } from "@/actions/guard";
import { createClient } from "@/lib/supabase/server";
import { signedUrl } from "@/lib/storage";

vi.mock("@/actions/guard", () => ({
  requireAdmin: vi.fn(),
  AuthorizationError: class AuthorizationError extends Error {},
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  signedUrl: vi.fn(async () => "https://signed.example/preview.jpg"),
}));

const mockedRequireAdmin = vi.mocked(requireAdmin);
const mockedCreateClient = vi.mocked(createClient);

function makeRequest(): Request {
  return new Request("https://example.test/api/accounts-control/runs-csv");
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/accounts-control/runs-csv", () => {
  it("exports all pages and refuses non-admin callers", async () => {
    mockedRequireAdmin.mockRejectedValue(new AuthorizationError("not allowed"));
    const denied = await GET(makeRequest());
    expect(denied.status).toBe(403);
    expect(mockedCreateClient).not.toHaveBeenCalled();

    mockedRequireAdmin.mockResolvedValue({ user: {} as never, profile: {} as never });
    const runPage = Array.from({ length: 1000 }, () => ({
      model: "bytedance/seedance-2-5",
      vendor: "kie",
      cost_usd: 0.56,
      user_id: null,
      projects: { user_id: "u1" },
      scenes: { duration_s: 4 },
    }));
    let runPageRequests = 0;
    const supabase = {
      from(table: string) {
        if (table === "runs") {
          return {
            select: () => ({
              order: () => ({
                order: () => ({
                  range: async (from: number) => {
                    runPageRequests += 1;
                    return {
                      data: from === 0 ? runPage : [runPage[0]],
                      error: null,
                    };
                  },
                }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            in: async () => ({ data: [{ id: "u1", email: "alice@example.com" }], error: null }),
          }),
        };
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>;
    mockedCreateClient.mockResolvedValue(supabase);

    const response = await GET(makeRequest());
    const csv = await response.text();
    expect(response.status).toBe(200);
    expect(runPageRequests).toBe(2);
    expect(csv.startsWith("\uFEFFpreview,user_email,provider,model,cost_usd,details\r\n")).toBe(
      true,
    );
    expect(csv.match(/,alice@example\.com,kie,bytedance\/seedance-2-5,0\.56,/g)).toHaveLength(
      1001,
    );
    expect(response.headers.get("Content-Disposition")).toContain("all-runs.csv");
  });

  it("exports a signed preview link and the run's error", async () => {
    mockedRequireAdmin.mockResolvedValue({ user: {} as never, profile: {} as never });
    mockedCreateClient.mockResolvedValue({
      from(table: string) {
        if (table === "runs") {
          return {
            select: () => ({
              order: () => ({
                order: () => ({
                  range: async () => ({
                    data: [
                      {
                        asset_id: "asset-1",
                        scene_id: null,
                        created_at: "2026-11-08T00:00:00Z",
                        error: "Failed render",
                        model: "image-model",
                        vendor: "kie",
                        cost_usd: 0.02,
                        user_id: "u1",
                        projects: null,
                      },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "profiles") {
          return {
            select: () => ({
              in: async () => ({ data: [{ id: "u1", email: "alice@example.com" }], error: null }),
            }),
          };
        }
        return {
          select: () => ({
            in: async () => ({
              data: [{ id: "asset-1", storage_key: "users/u1/image.png" }],
              error: null,
            }),
          }),
        };
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    expect(signedUrl).toHaveBeenCalledWith("users/u1/image.png");
    expect(await response.text()).toContain(
      "https://signed.example/preview.jpg,alice@example.com,kie,image-model,0.02,Failed render",
    );
  });
});
