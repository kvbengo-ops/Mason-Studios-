import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { AuthorizationError, requireAdmin } from "@/actions/guard";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/actions/guard", () => ({
  requireAdmin: vi.fn(),
  AuthorizationError: class AuthorizationError extends Error {},
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
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
            in: async () => ({ data: [{ id: "u1", username: "alice" }], error: null }),
          }),
        };
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>;
    mockedCreateClient.mockResolvedValue(supabase);

    const response = await GET(makeRequest());
    const csv = await response.text();
    expect(response.status).toBe(200);
    expect(runPageRequests).toBe(2);
    expect(csv.match(/alice,bytedance\/seedance-2-5,kie,0\.56,112,4/g)).toHaveLength(1001);
    expect(response.headers.get("Content-Disposition")).toContain("all-runs.csv");
  });
});
