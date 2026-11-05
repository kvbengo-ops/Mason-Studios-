import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { toJpeg } from "@/lib/to-jpeg";

async function image(format: "png" | "webp", alpha: number): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 4, channels: 4, background: { r: 255, g: 0, b: 0, alpha } },
  })
    [format]()
    .toBuffer();
}

describe("toJpeg", () => {
  it.each(["png", "webp"] as const)("re-encodes a %s upload as a .jpg JPEG", async (format) => {
    const file = new File([new Uint8Array(await image(format, 1))], `shot.${format}`, {
      type: `image/${format}`,
    });

    const out = await toJpeg(file);

    expect(out.type).toBe("image/jpeg");
    expect(out.name).toBe("shot.jpg");
    const meta = await sharp(Buffer.from(await out.arrayBuffer())).metadata();
    expect(meta.format).toBe("jpeg");
    expect([meta.width, meta.height]).toEqual([8, 4]);
  });

  it("flattens transparency onto white", async () => {
    const file = new File([new Uint8Array(await image("png", 0))], "logo.png", {
      type: "image/png",
    });

    const out = await toJpeg(file);

    const { data } = await sharp(Buffer.from(await out.arrayBuffer()))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(Math.min(...data)).toBeGreaterThan(245);
  });

  it("returns a JPEG untouched", async () => {
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], "photo.jpg", {
      type: "image/jpeg",
    });
    expect(await toJpeg(file)).toBe(file);
  });

  it.each([
    ["voice.mp3", "audio/mpeg"],
    ["clip.mp4", "video/mp4"],
  ])("leaves %s alone", async (name, type) => {
    const file = new File([new Uint8Array([1, 2, 3])], name, { type });
    expect(await toJpeg(file)).toBe(file);
  });
});
