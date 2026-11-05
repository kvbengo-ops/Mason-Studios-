import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VIDEO_DESCRIBE_MODEL,
  MAX_DESCRIBABLE_VIDEO_BYTES,
  MIN_PROMPT_TOKENS_FOR_A_REAL_READ,
  VideoDescribeUnusableError,
  describeReferenceVideo,
  __setKieVideoFetchForTests,
  __resetKieVideoTestSeams,
} from "./kie-video-describe";

// kie's envelope for this endpoint is Gemini's own shape, not kie's usual
// {code, msg, data} — see kie-audio-describe.test.ts's identical header
// comment. The one field this helper carries that audio's never needed is
// usageMetadata.promptTokenCount: per this module's own header ("THE
// DANGEROUS FINDING"), it is the ONLY thing that tells a genuine read
// apart from an instruction-only invention — the status, the shape, the
// JSON validity and the billing are identical either way. Defaults to 200,
// comfortably inside the genuinely-read cluster measured in the module's
// header, so a test that doesn't care about the guard doesn't have to
// think about it.
function geminiResponse(
  json: Record<string, unknown>,
  promptTokenCount = 200,
  creditsConsumed = 0.03,
): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }],
      usageMetadata: { promptTokenCount },
      credits_consumed: creditsConsumed,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Builds the raw envelope by hand rather than through geminiResponse, for the tests that need to omit or malform a field geminiResponse always fills in. */
function rawEnvelopeResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function videoDownloadResponse(): Response {
  return new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "content-type": "video/mp4" },
  });
}

// THE CENTREPIECE FIXTURE. Every field a schema-valid, vivid, entirely
// plausible video description — modelled on kie's own INVENTED answer for
// a 21.2MB clip of pure random static (2026-09-09 probe, this module's file
// header): "a woman with long blonde hair spinning around in a sunlit
// bedroom." Nothing about this payload is wrong. That is the whole point:
// the invention and the genuine read below differ in ONE thing only, the
// promptTokenCount passed alongside it — never these fields.
function invention() {
  return {
    subject: "a woman with long blonde hair",
    setting: "a sunlit bedroom",
    motion: "spinning around slowly, arms outstretched",
    camera: "static wide shot, no movement",
    usable: true,
    problem: "",
  };
}

beforeEach(() => {
  vi.stubEnv("KIE_API_KEY", "test-kie-key");
  vi.stubEnv("MODE", "production");
  // downloadVideoAsBase64 calls the global `fetch` directly (the signed
  // storage URL), never the fetchImpl seam — see this module's own comment
  // on why that step stays separate from the kie call it makes afterward.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => videoDownloadResponse()),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  __resetKieVideoTestSeams();
});

describe("describeReferenceVideo — request shape and parsing", () => {
  it("sends generateContent (never streamGenerateContent) with an inlineData video part, and parses the nested JSON string", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    const fetchMock = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string);
      return geminiResponse({
        subject: "a woman in a blue dress",
        setting: "a city street at dusk",
        motion: "walking toward the camera",
        camera: "slow dolly-in",
        usable: true,
        problem: "",
      });
    });
    __setKieVideoFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await describeReferenceVideo({
      videoUrl: "https://storage.example/clip1.mp4",
      name: "clip1",
      category: "video",
    });

    expect(capturedUrl).toBe(
      `https://api.kie.ai/gemini/v1/models/${VIDEO_DESCRIBE_MODEL}:generateContent`,
    );
    expect(capturedUrl).not.toContain("streamGenerateContent");

    const contents = capturedBody.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    const parts = contents[0]!.parts;
    const inline = parts.find((p) => "inlineData" in p) as {
      inlineData: { mimeType: string; data: string };
    };
    expect(inline.inlineData.mimeType).toBe("video/mp4");
    // Base64 of the three bytes the download stub returned.
    expect(inline.inlineData.data).toBe(Buffer.from([1, 2, 3]).toString("base64"));

    // subject + setting + motion + camera, joined as one phrase — never
    // four sentences (composeDescription's own reasoning).
    expect(result.description).toBe(
      "a woman in a blue dress, a city street at dusk, walking toward the camera, slow dolly-in",
    );
    expect(result.costUsd).toBeCloseTo(0.03 * 0.005);
  });

  it("accepts videoBase64 + mediaType directly, and never downloads anything for it", async () => {
    const downloadFetch = vi.mocked(fetch);
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        contents: Array<{ parts: Array<Record<string, unknown>> }>;
      };
      const inline = body.contents[0]!.parts.find((p) => "inlineData" in p) as {
        inlineData: { mimeType: string; data: string };
      };
      // The exact bytes handed in, not whatever the global fetch stub would
      // have returned had this wrongly gone through the download path.
      expect(inline.inlineData.mimeType).toBe("video/quicktime");
      expect(inline.inlineData.data).toBe(Buffer.from([9, 9, 9]).toString("base64"));
      return geminiResponse({
        subject: "a chef",
        setting: "a restaurant kitchen",
        motion: "chopping vegetables",
        camera: "static overhead",
        usable: true,
      });
    });
    __setKieVideoFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await describeReferenceVideo({
      videoBase64: Buffer.from([9, 9, 9]).toString("base64"),
      mediaType: "video/quicktime",
      name: "clip2",
      category: "video",
    });

    expect(result.description).toContain("a chef");
    // The download seam (global fetch, used only for a signed URL) must
    // never fire when the caller already handed over bytes.
    expect(downloadFetch).not.toHaveBeenCalled();
  });

  it("throws when neither videoUrl nor videoBase64+mediaType was supplied", async () => {
    await expect(describeReferenceVideo({ name: "clip3", category: "video" })).rejects.toThrow(
      /needs either videoUrl, or videoBase64 with mediaType/,
    );
  });
});

describe("describeReferenceVideo — the invention guard (2026-09-09 incident)", () => {
  // TEST 1: THE INVENTION IS REFUSED. Same fixture as the control below,
  // promptTokenCount 11 — the exact count kie's silently-dropped-media
  // response measured. The description is flawless; only the token count
  // says otherwise.
  it("refuses an invented description even though it is perfectly well-formed and schema-valid", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => geminiResponse(invention(), 11, 0.03));
    __setKieVideoFetchForTests(fetchMock as unknown as typeof fetch);

    let caught: unknown;
    try {
      await describeReferenceVideo({
        videoBase64: Buffer.from([1, 2, 3]).toString("base64"),
        mediaType: "video/mp4",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(VideoDescribeUnusableError);
    // Carries the metered cost so the caller still records the spend — kie
    // billed for this call whether or not it actually watched anything.
    expect((caught as VideoDescribeUnusableError).costUsd).toBeCloseTo(0.03 * 0.005);
  });

  // TEST 2: THE CONTROL. The IDENTICAL fixture, differing only in
  // promptTokenCount (200, inside the genuinely-read cluster). Proves test 1
  // fails on the token count and nothing else about the payload.
  it("accepts the identical fixture when promptTokenCount shows a real read", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => geminiResponse(invention(), 200, 0.03));
    __setKieVideoFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await describeReferenceVideo({
      videoBase64: Buffer.from([1, 2, 3]).toString("base64"),
      mediaType: "video/mp4",
    });

    expect(result.description).toBe(
      "a woman with long blonde hair, a sunlit bedroom, spinning around slowly, arms outstretched, static wide shot, no movement",
    );
    expect(result.costUsd).toBeCloseTo(0.03 * 0.005);
  });

  // TEST 3: an absent usageMetadata object entirely is not evidence the
  // clip was read — it is treated exactly like a low promptTokenCount.
  it("treats a response with no usageMetadata at all as an invention", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      rawEnvelopeResponse({
        candidates: [{ content: { parts: [{ text: JSON.stringify(invention()) }] } }],
        credits_consumed: 0.03,
      }),
    );
    __setKieVideoFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(
      describeReferenceVideo({
        videoBase64: Buffer.from([1, 2, 3]).toString("base64"),
        mediaType: "video/mp4",
      }),
    ).rejects.toBeInstanceOf(VideoDescribeUnusableError);
  });

  it("treats a usageMetadata object with no promptTokenCount field as an invention", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      rawEnvelopeResponse({
        candidates: [{ content: { parts: [{ text: JSON.stringify(invention()) }] } }],
        usageMetadata: {},
        credits_consumed: 0.03,
      }),
    );
    __setKieVideoFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(
      describeReferenceVideo({
        videoBase64: Buffer.from([1, 2, 3]).toString("base64"),
        mediaType: "video/mp4",
      }),
    ).rejects.toBeInstanceOf(VideoDescribeUnusableError);
  });

  it("treats a non-numeric promptTokenCount as an invention", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      rawEnvelopeResponse({
        candidates: [{ content: { parts: [{ text: JSON.stringify(invention()) }] } }],
        usageMetadata: { promptTokenCount: "200" },
        credits_consumed: 0.03,
      }),
    );
    __setKieVideoFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(
      describeReferenceVideo({
        videoBase64: Buffer.from([1, 2, 3]).toString("base64"),
        mediaType: "video/mp4",
      }),
    ).rejects.toBeInstanceOf(VideoDescribeUnusableError);
  });

  // TEST 4: THE BOUNDARY, against the exported constant rather than a
  // hardcoded 100 — so this test still guards the real threshold if it is
  // ever retuned.
  it("throws one token below MIN_PROMPT_TOKENS_FOR_A_REAL_READ", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        geminiResponse(invention(), MIN_PROMPT_TOKENS_FOR_A_REAL_READ - 1),
      );
    __setKieVideoFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(
      describeReferenceVideo({
        videoBase64: Buffer.from([1, 2, 3]).toString("base64"),
        mediaType: "video/mp4",
      }),
    ).rejects.toBeInstanceOf(VideoDescribeUnusableError);
  });

  it("passes exactly at MIN_PROMPT_TOKENS_FOR_A_REAL_READ", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        geminiResponse(invention(), MIN_PROMPT_TOKENS_FOR_A_REAL_READ),
      );
    __setKieVideoFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await describeReferenceVideo({
      videoBase64: Buffer.from([1, 2, 3]).toString("base64"),
      mediaType: "video/mp4",
    });

    expect(result.description).toContain("a woman with long blonde hair");
  });

  // TEST 5: OVERSIZE IS REFUSED WITHOUT A VENDOR CALL. Checked against the
  // clip's raw byte length before fetchImpl is ever touched — asserting the
  // mock was never invoked, not merely that something threw, is the point:
  // nothing may be billed for a file already known to fall in the invention
  // band.
  it("refuses a clip over MAX_DESCRIBABLE_VIDEO_BYTES before any fetch, and reports no cost", async () => {
    const fetchMock = vi.fn();
    __setKieVideoFetchForTests(fetchMock as unknown as typeof fetch);

    const oversizeBase64 = Buffer.alloc(MAX_DESCRIBABLE_VIDEO_BYTES + 1, 7).toString("base64");

    let caught: unknown;
    try {
      await describeReferenceVideo({ videoBase64: oversizeBase64, mediaType: "video/mp4" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(VideoDescribeUnusableError);
    expect((caught as VideoDescribeUnusableError).costUsd).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("describeReferenceVideo — an unusable clip never fails silently", () => {
  it("lets an honestly unusable clip keep its own reason", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      geminiResponse({
        subject: "",
        setting: "",
        motion: "",
        camera: "",
        usable: false,
        problem: "corrupted file, first three seconds are solid black",
      }),
    );
    __setKieVideoFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(
      describeReferenceVideo({ videoUrl: "https://storage.example/broken.mp4" }),
    ).rejects.toThrow(/corrupted file/);
    await expect(
      describeReferenceVideo({ videoUrl: "https://storage.example/broken.mp4" }),
    ).rejects.toThrow(/write the description yourself/);
  });

  it("throws rather than returning undefined when kie's response has no candidates text", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      rawEnvelopeResponse({
        candidates: [],
        usageMetadata: { promptTokenCount: 200 },
      }),
    );
    __setKieVideoFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(
      describeReferenceVideo({ videoUrl: "https://storage.example/x.mp4" }),
    ).rejects.toThrow(/no describable content/);
  });
});

describe("describeReferenceVideo — usable but empty", () => {
  it("refuses a clip described as usable with blank fields", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      geminiResponse({
        subject: "   ",
        setting: "",
        motion: "",
        camera: "",
        usable: true,
        problem: "",
      }),
    );
    __setKieVideoFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(
      describeReferenceVideo({ videoUrl: "https://storage.example/x.mp4" }),
    ).rejects.toThrow(/nothing written about it/);
  });

  it("still records what the refusal cost, rather than throwing the receipt away", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        geminiResponse(
          { subject: "", setting: "", motion: "", camera: "", usable: true },
          200,
          0.03,
        ),
      );
    __setKieVideoFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(
      describeReferenceVideo({ videoUrl: "https://storage.example/x.mp4" }),
    ).rejects.toMatchObject({ costUsd: 0.03 * 0.005 });
  });
});

describe("describeReferenceVideo — malformed responses", () => {
  it("throws on a non-200 HTTP status", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () =>
          new Response("server error", { status: 500, statusText: "Internal Server Error" }),
      );
    __setKieVideoFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(
      describeReferenceVideo({ videoUrl: "https://storage.example/x.mp4" }),
    ).rejects.toThrow(/kie Gemini HTTP 500/);
  });

  it("throws when kie's response body is not parseable JSON", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      rawEnvelopeResponse({
        candidates: [{ content: { parts: [{ text: "{not valid json" }] } }],
        usageMetadata: { promptTokenCount: 200 },
        credits_consumed: 0.03,
      }),
    );
    __setKieVideoFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(
      describeReferenceVideo({ videoUrl: "https://storage.example/x.mp4" }),
    ).rejects.toThrow(/not parseable JSON/);
  });

  it("throws when kie's response does not match the expected shape", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      geminiResponse({
        subject: "a dog",
        // setting, motion, camera, usable all missing — fails the schema.
      }),
    );
    __setKieVideoFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(
      describeReferenceVideo({ videoUrl: "https://storage.example/x.mp4" }),
    ).rejects.toThrow(/did not match the expected shape/);
  });
});

describe("describeReferenceVideo — the description is a phrase, not four sentences", () => {
  it("joins subject, setting, motion and camera without a full stop or a field label", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      geminiResponse({
        subject: "a golden retriever.",
        setting: "a public park at midday.",
        motion: "running after a thrown ball.",
        camera: "handheld, following the dog.",
        usable: true,
      }),
    );
    __setKieVideoFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await describeReferenceVideo({ videoUrl: "https://storage.example/x.mp4" });

    expect(result.description).toBe(
      "a golden retriever, a public park at midday, running after a thrown ball, handheld, following the dog",
    );
    expect(result.description).not.toMatch(/\.\s|\.$/);
  });
});

describe("describeReferenceVideo — MODE=development", () => {
  it("returns a mock description without calling fetch, and never bills anything", async () => {
    vi.stubEnv("MODE", "development");
    const fetchMock = vi.fn();
    __setKieVideoFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await describeReferenceVideo({ videoUrl: "https://storage.example/x.mp4" });

    expect(result.costUsd).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
