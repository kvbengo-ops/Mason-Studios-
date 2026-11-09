import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __setBytePlusImageFetchForTests,
  BYTEPLUS_SEEDREAM_SIZES,
  generateBytePlusSeedreamImage,
} from "./byteplus-image";
import { SEEDREAM_PRO_ASPECT_RATIOS } from "./seedream";

describe("BYTEPLUS_SEEDREAM_SIZES", () => {
  it("covers every Seedream ratio at both tiers, inside BytePlus's pixel limits", () => {
    for (const tier of ["1K", "2K"] as const) {
      for (const ratio of SEEDREAM_PRO_ASPECT_RATIOS) {
        const size = BYTEPLUS_SEEDREAM_SIZES[tier][ratio];
        expect(size, `${tier} ${ratio}`).toBeDefined();
        const [w, h] = size!.split("x").map(Number) as [number, number];
        const [rw, rh] = ratio.split(":").map(Number) as [number, number];
        expect(w * h, `${tier} ${ratio} pixels`).toBeGreaterThanOrEqual(921_600);
        expect(w * h, `${tier} ${ratio} pixels`).toBeLessThanOrEqual(4_624_220);
        expect(w / h, `${tier} ${ratio} shape`).toBeCloseTo(rw / rh, 2);
      }
    }
  });
});

describe("generateBytePlusSeedreamImage", () => {
  let sent: Record<string, unknown> | null = null;
  const respond = (status: number, body: unknown) =>
    __setBytePlusImageFetchForTests(async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(body), { status });
    });

  beforeEach(() => {
    process.env.BYTEPLUS_API_KEY = "test-key";
    sent = null;
  });
  afterEach(() => {
    __setBytePlusImageFetchForTests(fetch);
    delete process.env.BYTEPLUS_API_KEY;
  });

  it("sends explicit pixels with no watermark, and prices from the image count", async () => {
    respond(200, { data: [{ url: "https://img/x.jpeg" }], usage: { generated_images: 1 } });
    const out = await generateBytePlusSeedreamImage({
      prompt: "a face",
      aspectRatio: "9:16",
      resolution: "1K",
    });
    expect(sent).toMatchObject({ size: "720x1280", watermark: false, response_format: "url" });
    expect(out).toEqual({ url: "https://img/x.jpeg", costUsd: 0.045 });
  });

  it("prices 2K at the 2K rate", async () => {
    respond(200, { data: [{ url: "https://img/y.jpeg" }], usage: { generated_images: 1 } });
    const out = await generateBytePlusSeedreamImage({
      prompt: "a face",
      aspectRatio: "1:1",
      resolution: "2K",
    });
    expect(sent).toMatchObject({ size: "2048x2048" });
    expect(out.costUsd).toBe(0.09);
  });

  it("sends one reference as a string and several as an array", async () => {
    respond(200, { data: [{ url: "https://img/r.jpeg" }], usage: { generated_images: 1 } });
    const base = { prompt: "x", aspectRatio: "9:16", resolution: "1K" } as const;
    await generateBytePlusSeedreamImage({ ...base, refImageUrls: ["https://a"] });
    expect(sent).toMatchObject({ image: "https://a" });
    await generateBytePlusSeedreamImage({ ...base, refImageUrls: ["https://a", "https://b"] });
    expect(sent).toMatchObject({ image: ["https://a", "https://b"] });
    await generateBytePlusSeedreamImage(base);
    expect(sent).not.toHaveProperty("image");
  });

  it("surfaces BytePlus's own error code on a refusal", async () => {
    respond(400, { error: { code: "InputTextSensitiveContentDetected", message: "blocked" } });
    await expect(
      generateBytePlusSeedreamImage({ prompt: "x", aspectRatio: "9:16", resolution: "1K" }),
    ).rejects.toThrow("InputTextSensitiveContentDetected");
  });

  it("refuses a tier Seedream 5.0 Pro does not offer, before any request", async () => {
    respond(200, {});
    await expect(
      generateBytePlusSeedreamImage({ prompt: "x", aspectRatio: "9:16", resolution: "4K" }),
    ).rejects.toThrow("does not offer 4K");
    expect(sent).toBeNull();
  });
});
