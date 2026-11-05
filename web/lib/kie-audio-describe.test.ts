import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_DESCRIBE_MODEL,
  describeReferenceAudio,
  __setKieAudioFetchForTests,
  __resetKieAudioTestSeams,
} from "./kie-audio-describe";

// kie's envelope for this endpoint is Gemini's own shape, not kie's usual
// {code, msg, data} — the verified call (this file's own header comment)
// returned candidates[...].content.parts[...].text with the schema's fields
// JSON-encoded INSIDE that string, plus a top-level credits_consumed.
function geminiResponse(json: Record<string, unknown>, creditsConsumed = 0.03): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }],
      credits_consumed: creditsConsumed,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function audioDownloadResponse(): Response {
  return new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "content-type": "audio/mpeg" },
  });
}

beforeEach(() => {
  vi.stubEnv("KIE_API_KEY", "test-kie-key");
  vi.stubEnv("MODE", "production");
  // downloadAudioAsBase64 calls the global `fetch` directly (the signed
  // storage URL, not kie's API) — see this module's own header for why that
  // step is not routed through the same fetchImpl seam as the kie call
  // itself: two different hosts, two different reasons to fail.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => audioDownloadResponse()),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  __resetKieAudioTestSeams();
});

describe("describeReferenceAudio — request shape and parsing", () => {
  it("sends generateContent (never streamGenerateContent) with an inlineData audio part, and parses the nested JSON string", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    const fetchMock = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string);
      return geminiResponse({
        voice: "a mature female voice with a clear, resonant timbre and a standard German accent",
        delivery: "calm and deliberate with measured pacing",
        language: "de-DE",
        transcript: "Manche warten auf den Bus. Ich warte auf das hier.",
        usable: true,
        problem: "",
      });
    });
    __setKieAudioFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await describeReferenceAudio({
      audioUrl: "https://storage.example/voice1.mp3",
      name: "voice1",
      category: "audio",
    });

    expect(capturedUrl).toBe(
      `https://api.kie.ai/gemini/v1/models/${AUDIO_DESCRIBE_MODEL}:generateContent`,
    );
    expect(capturedUrl).not.toContain("streamGenerateContent");

    const contents = capturedBody.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    const parts = contents[0]!.parts;
    const inline = parts.find((p) => "inlineData" in p) as {
      inlineData: { mimeType: string; data: string };
    };
    expect(inline.inlineData.mimeType).toBe("audio/mpeg");
    // Base64 of the three bytes the download stub returned.
    expect(inline.inlineData.data).toBe(Buffer.from([1, 2, 3]).toString("base64"));

    // The composed description carries voice + delivery, never the
    // transcript — see the module's own comment on why splicing the
    // reference clip's exact words into an unrelated scene's prompt would
    // read as an instruction to repeat them.
    expect(result.description).toContain("mature female voice");
    expect(result.description).toContain("calm and deliberate");
    expect(result.description).not.toContain("Manche warten");

    // 0.03 credits * $0.005/credit, the exact receipt in this module's header.
    expect(result.costUsd).toBeCloseTo(0.00015);
  });

  // THE CATEGORY REACHES KIE. The interface comment on `category` used to say
  // "context only — nothing branches on it", which is true of control flow and
  // was read as meaning the value stays local. It does not: it is interpolated
  // into `instruction`, and `instruction` is parts[0].text of this POST. This
  // asserts the reach itself, not just describeRoleLine's return value, so a
  // future refactor that drops the role line from the prompt fails here rather
  // than silently shipping a describe with no steer.
  it("carries the category into the text part of the request body, correctly articled", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return geminiResponse({
        voice: "a young adult female voice",
        delivery: "deliberate and relaxed",
        language: "de-DE",
        transcript: "Manche warten auf den Bus.",
        usable: true,
        problem: "",
      });
    });
    __setKieAudioFetchForTests(fetchMock as unknown as typeof fetch);

    await describeReferenceAudio({
      audioUrl: "https://storage.example/voice1.mp3",
      name: "voice1",
      category: "audio",
    });

    const contents = capturedBody.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    const text = contents[0]!.parts.find((p) => "text" in p) as { text: string };
    expect(text.text).toContain("This is saved as an audio reference.");
    // The exact shape production shipped until this change. Pinned as a
    // NEGATIVE so the article cannot quietly regress to the hard-coded "a".
    expect(text.text).not.toContain("a audio reference");
  });

  it("accepts audioBase64 + mediaType directly, and never downloads anything for it", async () => {
    // THE BYTES PROBLEM: registerElement's describeOnSave calls this before
    // the file has ever reached storage — there is no signed URL yet, only
    // the File the operator just picked. This is the entry that lets it call
    // in anyway, mirroring describeReferenceImage's imageBase64 + mediaType.
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
      expect(inline.inlineData.mimeType).toBe("audio/wav");
      expect(inline.inlineData.data).toBe(Buffer.from([9, 9, 9]).toString("base64"));
      return geminiResponse({
        voice: "a young male voice with a light Irish accent",
        delivery: "upbeat and quick",
        language: "en-IE",
        transcript: "irrelevant",
        usable: true,
      });
    });
    __setKieAudioFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await describeReferenceAudio({
      audioBase64: Buffer.from([9, 9, 9]).toString("base64"),
      mediaType: "audio/wav",
      name: "voice2",
      category: "audio",
    });

    expect(result.description).toContain("young male voice");
    // The download seam (global fetch, used only for a signed URL) must
    // never fire when the caller already handed over bytes.
    expect(downloadFetch).not.toHaveBeenCalled();
  });

  it("throws when neither audioUrl nor audioBase64+mediaType was supplied", async () => {
    await expect(describeReferenceAudio({ name: "voice3", category: "audio" })).rejects.toThrow(
      /needs either audioUrl, or audioBase64 with mediaType/,
    );
  });
});

describe("describeReferenceAudio — an unusable clip never fails silently", () => {
  it("throws a message that tells the operator to write the description themselves", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      geminiResponse({
        voice: "",
        delivery: "",
        language: "",
        transcript: "",
        usable: false,
        problem: "mostly silence",
      }),
    );
    __setKieAudioFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(
      describeReferenceAudio({ audioUrl: "https://storage.example/silent.mp3" }),
    ).rejects.toThrow(/mostly silence/);
    await expect(
      describeReferenceAudio({ audioUrl: "https://storage.example/silent.mp3" }),
    ).rejects.toThrow(/write the description yourself/);
  });

  it("throws rather than returning undefined when kie's response has no candidates text", async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ candidates: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    __setKieAudioFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(
      describeReferenceAudio({ audioUrl: "https://storage.example/x.mp3" }),
    ).rejects.toThrow(/no describable content/);
  });
});

describe("describeReferenceAudio — usable but empty", () => {
  // The gap the schema cannot close: z.string() accepts "", so usable:true
  // with nothing written parses cleanly. Before this guard it composed
  // ". Delivery: ." — a billed call writing punctuation into ai_description,
  // and from there into every prompt that ever tagged this voice.
  it("refuses a clip described as usable with a blank voice and delivery", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      geminiResponse({
        voice: "   ",
        delivery: "",
        language: "en-US",
        transcript: "",
        usable: true,
        problem: "",
      }),
    );
    __setKieAudioFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(
      describeReferenceAudio({ audioUrl: "https://storage.example/x.mp3" }),
    ).rejects.toThrow(/nothing written about the voice/);
  });

  it("still records what the refusal cost, rather than throwing the receipt away", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        geminiResponse(
          { voice: "", delivery: "", language: "en-US", transcript: "", usable: true },
          0.03,
        ),
      );
    __setKieAudioFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(
      describeReferenceAudio({ audioUrl: "https://storage.example/x.mp3" }),
    ).rejects.toMatchObject({ costUsd: 0.03 * 0.005 });
  });

  it("lets an honestly unusable clip keep its own reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      geminiResponse({
        voice: "",
        delivery: "",
        language: "en-US",
        transcript: "",
        usable: false,
        problem: "music with no speech",
      }),
    );
    __setKieAudioFetchForTests(fetchMock as unknown as typeof fetch);

    // The vendor's own reason survives rather than being replaced by the
    // blank-fields message — that check deliberately runs after `usable`.
    await expect(
      describeReferenceAudio({ audioUrl: "https://storage.example/x.mp3" }),
    ).rejects.toThrow(/music with no speech/);
  });
});

describe("describeReferenceAudio — the description is a noun phrase, not two sentences", () => {
  // It is spliced in at the operator's tag, mid-sentence. "speaks to camera
  // in @voice1" used to become "...in a mature female voice. Delivery: calm
  // and deliberate." — a full stop and a bare label wedged inside their own
  // clause.
  it("joins voice and delivery without a full stop or a Delivery: label", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      geminiResponse({
        voice: "a mature female voice with a standard German accent.",
        delivery: "calm and deliberate with measured pacing.",
        language: "de-DE",
        transcript: "irrelevant",
        usable: true,
      }),
    );
    __setKieAudioFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await describeReferenceAudio({ audioUrl: "https://storage.example/x.mp3" });

    expect(result.description).toBe(
      "a mature female voice with a standard German accent, calm and deliberate with measured pacing",
    );
    expect(result.description).not.toContain("Delivery:");
    expect(result.description).not.toMatch(/\.$/);
  });
});

describe("describeReferenceAudio — MODE=development", () => {
  it("returns a mock description without calling fetch, and never bills anything", async () => {
    vi.stubEnv("MODE", "development");
    const fetchMock = vi.fn();
    __setKieAudioFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await describeReferenceAudio({ audioUrl: "https://storage.example/x.mp3" });

    expect(result.costUsd).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
