import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IMAGE_DESCRIBE_MODEL,
  KieImageDescribeError,
  describeReferenceImage,
  __setKieImageFetchForTests,
  __resetKieImageTestSeams,
} from "./kie-image-describe";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  __resetKieImageTestSeams();
});

describe("kie image description", () => {
  it("sends image bytes to Gemini and records the returned cost", async () => {
    vi.stubEnv("MODE", "production");
    vi.stubEnv("KIE_API_KEY", "test-kie-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-type": "image/png" },
          }),
      ),
    );
    let request: RequestInit | undefined;
    __setKieImageFetchForTests(
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(url).toBe(
          `https://api.kie.ai/gemini/v1/models/${IMAGE_DESCRIBE_MODEL}:generateContent`,
        );
        request = init;
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify({ description: "a woman in a linen shirt" }) }],
                },
              },
            ],
            credits_consumed: 0.03,
          }),
        );
      }) as typeof fetch,
    );

    const result = await describeReferenceImage({
      imageUrl: "https://storage.example/image.png",
      category: "character",
    });

    expect(result).toEqual({ description: "a woman in a linen shirt", costUsd: 0.00015 });
    expect(request?.headers).toEqual({
      Authorization: "Bearer test-kie-key",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(request?.body as string);
    expect(body.generationConfig).not.toHaveProperty("maxOutputTokens");
    expect(body.contents[0].parts[0].text).toMatch(/NEVER transcribe text/);
    expect(body.contents[0].parts[1].inlineData).toEqual({ mimeType: "image/png", data: "AQID" });
  });

  it("preserves a reported charge when Gemini returns an invalid description", async () => {
    vi.stubEnv("MODE", "production");
    vi.stubEnv("KIE_API_KEY", "test-kie-key");
    __setKieImageFetchForTests(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: JSON.stringify({ description: "" }) }] } }],
              credits_consumed: 0.03,
            }),
          ),
      ) as typeof fetch,
    );

    await expect(
      describeReferenceImage({ imageBase64: "AQID", mediaType: "image/png" }),
    ).rejects.toMatchObject({ name: KieImageDescribeError.name, costUsd: 0.00015 });
  });

  it("reports truncation without exposing the model's raw text", async () => {
    vi.stubEnv("MODE", "production");
    vi.stubEnv("KIE_API_KEY", "test-kie-key");
    __setKieImageFetchForTests(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              candidates: [
                {
                  finishReason: "MAX_TOKENS",
                  content: { parts: [{ text: '{"description":"unfinished' }] },
                },
              ],
              credits_consumed: 0.03,
            }),
          ),
      ) as typeof fetch,
    );

    await expect(
      describeReferenceImage({ imageBase64: "AQID", mediaType: "image/png" }),
    ).rejects.toMatchObject({
      message: "kie Gemini's image description was not parseable JSON (finish_reason: MAX_TOKENS).",
      costUsd: 0.00015,
    });
  });
});
