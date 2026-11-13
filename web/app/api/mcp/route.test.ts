// /api/mcp is an adapter: it must authenticate the connector URL's token and
// forward every tool to the matching /api/v1 handler with that token, never
// decide anything about money itself.
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/api-auth", () => ({ requireApiToken: vi.fn() }));
vi.mock("@/app/api/v1/elements/route", () => ({ GET: vi.fn() }));
vi.mock("@/app/api/v1/quote/route", () => ({ POST: vi.fn() }));
vi.mock("@/app/api/v1/generate/route", () => ({ POST: vi.fn() }));
vi.mock("@/app/api/v1/jobs/[id]/route", () => ({ GET: vi.fn() }));
vi.mock("@/app/api/v1/images/route", () => ({ POST: vi.fn() }));
vi.mock("@/app/api/v1/images/[id]/route", () => ({ GET: vi.fn() }));

import { requireApiToken } from "@/lib/api-auth";
import { POST as generateClip } from "@/app/api/v1/generate/route";
import { GET as getJob } from "@/app/api/v1/jobs/[id]/route";
import { POST } from "./route";

const TOKEN = `ms_live_${"a".repeat(64)}`;

function rpc(body: unknown, query = `?token=${TOKEN}`): Request {
  return new Request(`https://app.example.test/api/mcp${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(() => vi.resetAllMocks());

describe("POST /api/mcp", () => {
  it("refuses initialize without a valid token, with the API's own 401", async () => {
    vi.mocked(requireApiToken).mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { error: "Invalid API token.", code: "invalid_token" },
        { status: 401 },
      ),
    } as never);
    const res = await POST(rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, ""));
    expect(res.status).toBe(401);
  });

  it("answers claude.ai's 2025-11-25 initialize with that same version", async () => {
    vi.mocked(requireApiToken).mockResolvedValue({ ok: true } as never);
    const init = await POST(
      rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" },
      }),
    );
    expect((await init.json()).result.protocolVersion).toBe("2025-11-25");
  });

  it("authenticates the ?token= on connect and lists the tools", async () => {
    vi.mocked(requireApiToken).mockResolvedValue({ ok: true } as never);
    const init = await POST(
      rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    );
    expect((await init.json()).result.protocolVersion).toBe("2025-06-18");
    const authRequest = vi.mocked(requireApiToken).mock.calls[0]?.[0];
    expect(authRequest?.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);

    const list = await POST(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const names = (await list.json()).result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual([
      "list_elements",
      "quote_clip",
      "generate_clip",
      "get_job",
      "generate_image",
      "get_image",
    ]);
  });

  it("answers a notification with 202 and no body", async () => {
    vi.mocked(requireApiToken).mockResolvedValue({ ok: true } as never);
    const res = await POST(rpc({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("forwards generate_clip to /api/v1/generate with the token and an Idempotency-Key, not as a body field", async () => {
    vi.mocked(generateClip).mockResolvedValue(NextResponse.json({ job_id: "j1" }, { status: 202 }));
    const res = await POST(
      rpc({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "generate_clip",
          arguments: {
            prompt: "p",
            model_id: "wan-3.0",
            resolution: "480P",
            duration_s: 4,
            idempotency_key: "k-1",
          },
        },
      }),
    );
    const forwarded = vi.mocked(generateClip).mock.calls[0]?.[0];
    expect(forwarded?.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(forwarded?.headers.get("Idempotency-Key")).toBe("k-1");
    expect(await forwarded?.json()).not.toHaveProperty("idempotency_key");
    // tools/call is authorized by the v1 handler it reaches, not twice.
    expect(requireApiToken).not.toHaveBeenCalled();

    const { result } = await res.json();
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('"job_id":"j1"');
    expect(result.content[0].text).toContain("idempotency_key: k-1");
  });

  it("surfaces a v1 refusal as a tool error, and passes the job id through", async () => {
    vi.mocked(getJob).mockResolvedValue(
      NextResponse.json({ error: "Job was not found." }, { status: 404 }),
    );
    const res = await POST(
      rpc({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "get_job", arguments: { job_id: "x" } },
      }),
    );
    expect(await vi.mocked(getJob).mock.calls[0]?.[1].params).toEqual({ id: "x" });
    expect((await res.json()).result.isError).toBe(true);
  });
});
