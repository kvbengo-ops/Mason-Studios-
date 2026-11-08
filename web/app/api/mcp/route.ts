import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-auth";
import { GET as listElements } from "@/app/api/v1/elements/route";
import { POST as generateClip } from "@/app/api/v1/generate/route";
import { POST as generateImage } from "@/app/api/v1/images/route";
import { GET as getImage } from "@/app/api/v1/images/[id]/route";
import { GET as getJob } from "@/app/api/v1/jobs/[id]/route";
import { POST as quoteClip } from "@/app/api/v1/quote/route";

export const dynamic = "force-dynamic";

/**
 * POST /api/mcp — a hosted MCP server (Streamable HTTP, stateless JSON, no SSE)
 * so claude.ai / Claude Desktop / mobile can drive Mason as a custom connector.
 *
 * A thin adapter, deliberately: every tool calls the matching /api/v1 route
 * handler in-process with the caller's token as a Bearer header, so auth,
 * scopes, rate limits, validation, idempotency and spend caps are the API's
 * own — nothing here decides who may spend what.
 *
 * Auth: `?token=ms_live_…` on the connector URL (claude.ai's connector form has
 * no header field) or an `Authorization: Bearer` header.
 * ponytail: token-in-URL — whoever has the URL can spend as that account, and
 * the URL can land in access logs. Revoking the token is the kill switch.
 * OAuth (RFC 9728 metadata + authorization server) is the upgrade path.
 *
 * No upload tool: a hosted fetch-this-URL tool is an SSRF surface, and a chat
 * attachment's bytes never reach a connector anyway. Uploads stay in the web
 * app; generated images are filed as Elements automatically.
 */

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type JsonRpcId = string | number | null;
type ToolArgs = Record<string, unknown>;

const clipProps = {
  prompt: {
    type: "string",
    description:
      "What happens in the clip. Mention refs by position: @Image 1, @Video 1, @Audio 1 (order of the *_refs arrays).",
  },
  model_id: {
    type: "string",
    description:
      'e.g. "wan-3.0" (resolution "480P"/"720P"/"1080P"), "seedance-2.5-byteplus" ("480p"). Case matters.',
  },
  resolution: { type: "string" },
  duration_s: { type: "integer", description: "Seconds, e.g. 4 or 10." },
  is_talking_head: { type: "boolean" },
  image_refs: {
    type: "array",
    items: { type: "string" },
    description: "Element ids from list_elements, in @Image order.",
  },
  video_refs: { type: "array", items: { type: "string" } },
  audio_refs: { type: "array", items: { type: "string" } },
};
const clipRequired = ["prompt", "model_id", "resolution", "duration_s"];
const idempotencyProp = {
  idempotency_key: {
    type: "string",
    description:
      "Reuse the key from a previous attempt to retry without paying twice. Generated if omitted.",
  },
};
const jobIdSchema = {
  type: "object",
  properties: { job_id: { type: "string" } },
  required: ["job_id"],
};

const TOOLS = [
  {
    name: "list_elements",
    description:
      "List the account's saved Elements (reference images, videos, audio) with their ids and names. Free.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "quote_clip",
    description: "Price a video clip without generating it. Free. Quote before generate_clip.",
    inputSchema: { type: "object", properties: clipProps, required: clipRequired },
  },
  {
    name: "generate_clip",
    description:
      "Generate a video clip. SPENDS REAL MONEY against the account's spend caps. Returns job_id; poll get_job.",
    inputSchema: {
      type: "object",
      properties: { ...clipProps, ...idempotencyProp },
      required: clipRequired,
    },
  },
  {
    name: "get_job",
    description:
      "Status of a generate_clip job (queued, rendering, done, failed). When done: cost and a download_url. Free.",
    inputSchema: jobIdSchema,
  },
  {
    name: "generate_image",
    description:
      "Generate a picture. SPENDS REAL MONEY. Tag saved Elements as @name in the prompt to use them as references. The picture is saved as a new Element. Returns job_id; poll get_image.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        model: {
          type: "string",
          description:
            'Optional, e.g. "nano-banana" (default, cheapest), "nano-banana-2", "seedream-5.0-pro".',
        },
        aspect_ratio: {
          type: "string",
          description: 'Optional, e.g. "9:16" (default), "1:1", "16:9".',
        },
        resolution: {
          type: "string",
          description: "Optional pixel tier, if the model supports it.",
        },
        ...idempotencyProp,
      },
      required: ["prompt"],
    },
  },
  {
    name: "get_image",
    description:
      "Status of a generate_image job (queued, generating, completed, failed, billing_unknown). When completed: element_id (usable in generate_clip image_refs) and a download_url. Free.",
    inputSchema: jobIdSchema,
  },
];

function rpcResult(id: JsonRpcId, result: unknown): NextResponse {
  return NextResponse.json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: JsonRpcId, code: number, message: string, status = 200): NextResponse {
  return NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}

/** Strips the MCP-only idempotency_key and returns it as the header value. */
function withIdempotency(args: ToolArgs): { body: ToolArgs; key: string } {
  const { idempotency_key: given, ...body } = args;
  return { body, key: typeof given === "string" && given.trim() ? given.trim() : randomUUID() };
}

async function callTool(
  name: string,
  args: ToolArgs,
  origin: string,
  authorization: string,
): Promise<Response> {
  const get = (path: string): Request =>
    new Request(origin + path, { headers: { Authorization: authorization } });
  const post = (path: string, body: ToolArgs, idempotencyKey?: string): Request =>
    new Request(origin + path, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    });
  const id = String(args.job_id ?? "");

  switch (name) {
    case "list_elements":
      return listElements(get("/api/v1/elements"));
    case "quote_clip":
      return quoteClip(post("/api/v1/quote", args));
    case "generate_clip": {
      const { body, key } = withIdempotency(args);
      return withKey(await generateClip(post("/api/v1/generate", body, key)), key);
    }
    case "get_job":
      return getJob(get(`/api/v1/jobs/${encodeURIComponent(id)}`), {
        params: Promise.resolve({ id }),
      });
    case "generate_image": {
      const { body, key } = withIdempotency(args);
      return withKey(await generateImage(post("/api/v1/images", body, key)), key);
    }
    case "get_image":
      return getImage(get(`/api/v1/images/${encodeURIComponent(id)}`), {
        params: Promise.resolve({ id }),
      });
    default:
      return NextResponse.json(
        { error: `Unknown tool: ${name}`, code: "unknown_tool" },
        { status: 404 },
      );
  }
}

/** Appends the key used, so the model can retry the same attempt instead of paying twice. */
async function withKey(response: Response, key: string): Promise<Response> {
  const text = await response.text();
  return new Response(`${text}\nidempotency_key: ${key}`, { status: response.status });
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token")?.trim();
  const authorization = queryToken
    ? `Bearer ${queryToken}`
    : (request.headers.get("Authorization") ?? "");

  let message: {
    jsonrpc?: unknown;
    id?: JsonRpcId;
    method?: unknown;
    params?: Record<string, unknown>;
  };
  try {
    message = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }
  if (Array.isArray(message) || typeof message !== "object" || message === null) {
    return rpcError(
      null,
      -32600,
      "Expected one JSON-RPC message (batching is not supported).",
      400,
    );
  }
  const { id = null, method, params = {} } = message;

  // tools/call is authorized by the /api/v1 handler it reaches (with that
  // endpoint's own scope and rate bucket); everything else is checked here,
  // so a bad token fails at connect time instead of at the first tool.
  if (method !== "tools/call") {
    const auth = await requireApiToken(
      new Request(url, { headers: { Authorization: authorization } }),
      "read",
    );
    if (!auth.ok) return auth.response;
  }

  // Notifications (no id) get no body.
  if (message.id === undefined) return new Response(null, { status: 202 });

  switch (method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "mason", version: "1.0.0" },
        instructions:
          "Mason Studios: generate images and short videos. Quote before generating; generate_* tools spend real money. " +
          "Poll get_job / get_image every ~10s until finished, then share the download_url.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args =
        typeof params.arguments === "object" && params.arguments !== null
          ? (params.arguments as ToolArgs)
          : {};
      try {
        const response = await callTool(name, args, url.origin, authorization);
        const text = `HTTP ${response.status}\n${await response.text()}`;
        return rpcResult(id, { content: [{ type: "text", text }], isError: !response.ok });
      } catch (error) {
        console.error(`POST /api/mcp tools/call ${name} failed`, error);
        return rpcResult(id, {
          content: [{ type: "text", text: "Tool call failed." }],
          isError: true,
        });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${String(method)}`);
  }
}

/** No server-initiated stream: this server only answers POSTs. */
export function GET(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
