import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { AuthorizationError, requireAdmin } from "@/actions/guard";
import { createAdminClient, createClient } from "@/lib/supabase/server";

vi.mock("@/actions/guard", () => ({
  requireAdmin: vi.fn(),
  AuthorizationError: class AuthorizationError extends Error {},
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

const mockedRequireAdmin = vi.mocked(requireAdmin);
const mockedCreateClient = vi.mocked(createClient);
const mockedCreateAdminClient = vi.mocked(createAdminClient);

function makeRequest(query = ""): Request {
  return new Request(`https://example.test/api/accounts-control/runs-csv${query}`);
}

// One bulk call per 1,000 keys; records every batch it was asked to sign.
const signedBatches: string[][] = [];
function mockBulkSigning(): void {
  mockedCreateAdminClient.mockReturnValue({
    storage: {
      from: () => ({
        createSignedUrls: async (paths: string[]) => {
          signedBatches.push(paths);
          return {
            data: paths.map((path) => ({
              path,
              signedUrl: "https://signed.example/preview.jpg",
              error: null,
            })),
            error: null,
          };
        },
      }),
    },
  } as unknown as ReturnType<typeof createAdminClient>);
}

// runs: select -> gte -> lt -> order -> order -> range
function runsTable(range: (from: number) => Promise<unknown>, window: string[]) {
  return {
    select: () => ({
      gte: (_column: string, value: string) => {
        window.push(value);
        return {
          lt: (_c: string, end: string) => {
            window.push(end);
            return { order: () => ({ order: () => ({ range }) }) };
          },
        };
      },
    }),
  };
}

afterEach(() => {
  vi.clearAllMocks();
  signedBatches.length = 0;
});

describe("GET /api/accounts-control/runs-csv", () => {
  it("exports every page of the window and refuses non-admin callers", async () => {
    mockedRequireAdmin.mockRejectedValue(new AuthorizationError("not allowed"));
    const denied = await GET(makeRequest());
    expect(denied.status).toBe(403);
    expect(mockedCreateClient).not.toHaveBeenCalled();

    mockedRequireAdmin.mockResolvedValue({ user: {} as never, profile: {} as never });
    mockBulkSigning();
    const runPage = Array.from({ length: 1000 }, () => ({
      model: "bytedance/seedance-2-5",
      vendor: "kie",
      cost_usd: 0.56,
      user_id: null,
      projects: { user_id: "u1" },
    }));
    let runPageRequests = 0;
    const window: string[] = [];
    mockedCreateClient.mockResolvedValue({
      from(table: string) {
        if (table === "runs") {
          return runsTable(async (from: number) => {
            runPageRequests += 1;
            return { data: from === 0 ? runPage : [runPage[0]], error: null };
          }, window);
        }
        return {
          select: () => ({
            in: async () => ({ data: [{ id: "u1", email: "alice@example.com" }], error: null }),
          }),
        };
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const response = await GET(makeRequest("?days=7"));
    const csv = await response.text();
    expect(response.status).toBe(200);
    expect(runPageRequests).toBe(2);
    // Every page is read with the same [start, end) window: one gte + one lt each.
    expect(window).toHaveLength(2 * runPageRequests);
    expect(window.slice(2)).toEqual(window.slice(0, 2));
    expect(new Date(window[0]!).getTime()).toBeLessThan(new Date(window[1]!).getTime());
    expect(csv.startsWith("preview,user_email,provider,model,cost_usd,details\r\n")).toBe(true);
    expect(csv.match(/,alice@example\.com,kie,bytedance\/seedance-2-5,0\.56,/g)).toHaveLength(1001);
    expect(response.headers.get("Content-Disposition")).toContain("runs-last-7-days.csv");
  });

  it("signs previews in one bulk call and exports the run's error", async () => {
    mockedRequireAdmin.mockResolvedValue({ user: {} as never, profile: {} as never });
    mockBulkSigning();
    mockedCreateClient.mockResolvedValue({
      from(table: string) {
        if (table === "runs") {
          return runsTable(
            async () => ({
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
            [],
          );
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
    expect(signedBatches).toEqual([["users/u1/image.png"]]);
    expect(await response.text()).toContain(
      "https://signed.example/preview.jpg,alice@example.com,kie,image-model,0.02,Failed render",
    );
    expect(response.headers.get("Content-Disposition")).toContain("runs-last-14-days.csv");
  });
});
