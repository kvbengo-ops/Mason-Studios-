import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildStorageKey,
  extFromContentType,
  extFromFilename,
  MEDIA_BUCKET,
  signedUrl,
} from "./storage";
import { createAdminClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(),
}));

describe("MEDIA_BUCKET", () => {
  it("is a stable, non-empty bucket name", () => {
    expect(MEDIA_BUCKET).toBe("media");
  });
});

describe("buildStorageKey", () => {
  it("shapes keys as projects/{projectId}/{kind}/{uuid}.{ext}", () => {
    const key = buildStorageKey({ projectId: "proj-123", kind: "character_ref", ext: "png" });

    expect(key).toMatch(
      /^projects\/proj-123\/character_ref\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/,
    );
  });

  it("produces a distinct key on every call", () => {
    const a = buildStorageKey({ projectId: "p", kind: "product_ref", ext: "jpg" });
    const b = buildStorageKey({ projectId: "p", kind: "product_ref", ext: "jpg" });
    expect(a).not.toBe(b);
  });

  it("scopes the path by both project id and asset kind", () => {
    const characterKey = buildStorageKey({ projectId: "p1", kind: "character_ref", ext: "png" });
    const refFrameKey = buildStorageKey({ projectId: "p1", kind: "ref_frame", ext: "png" });

    expect(characterKey.startsWith("projects/p1/character_ref/")).toBe(true);
    expect(refFrameKey.startsWith("projects/p1/ref_frame/")).toBe(true);
  });
});

describe("extFromContentType", () => {
  it("maps known content types to extensions", () => {
    expect(extFromContentType("image/png")).toBe("png");
    expect(extFromContentType("image/webp")).toBe("webp");
    expect(extFromContentType("video/mp4")).toBe("mp4");
    expect(extFromContentType("image/jpeg")).toBe("jpg");
  });

  it("falls back to jpg for unknown or missing content types", () => {
    expect(extFromContentType("application/octet-stream")).toBe("jpg");
    expect(extFromContentType(null)).toBe("jpg");
  });
});

describe("extFromFilename", () => {
  it("extracts the lowercased extension", () => {
    expect(extFromFilename("photo.PNG", "jpg")).toBe("png");
    expect(extFromFilename("headshot.jpeg", "jpg")).toBe("jpeg");
  });

  it("falls back when there is no extension", () => {
    expect(extFromFilename("noext", "jpg")).toBe("jpg");
  });
});

describe("signedUrl", () => {
  // Supabase's real createSignedUrl() embeds an `iat` (issued-at) claim, so
  // it returns a DIFFERENT token on every call even for the same
  // (storageKey, expiresIn) — see this file's signedUrl() memoization
  // comment for how that was verified. This fake mirrors that: every call
  // returns a distinct URL, so if signedUrl() ever returns the same string
  // twice, that's proof the memoization cache served the second call
  // instead of asking "Supabase" again — not a coincidence.
  function fakeAdmin(): {
    storage: { from: ReturnType<typeof vi.fn> };
    createSignedUrl: ReturnType<typeof vi.fn>;
  } {
    const createSignedUrl = vi.fn(async (key: string, expiresIn: number) => ({
      data: {
        signedUrl: `https://fake.test/${key}?ttl=${expiresIn}&n=${createSignedUrl.mock.calls.length}`,
      },
      error: null,
    }));
    return {
      storage: { from: vi.fn(() => ({ createSignedUrl })) },
      createSignedUrl,
    };
  }

  afterEach(() => {
    vi.mocked(createAdminClient).mockReset();
    vi.useRealTimers();
  });

  it("says so when Storage answers a transform with the original bytes", async () => {
    // THE FAILURE THIS CATCHES IS SILENT. Storage returns a
    // `/render/image/sign/...` URL when transformations are available and a
    // plain `/object/sign/...` one — the original, full-size bytes — when
    // they are not, with no error either way. Verified against the local
    // stack, which has no /render/image route: signing the same key with and
    // without a transform returned byte-identical URLs. A picker asking for
    // 320px thumbnails then downloads 7 MB PNGs and looks perfectly fine.
    const admin = fakeAdmin();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await signedUrl("projects/p/ref_frame/a.png", 3600, { width: 320 });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("untransformed object URL"));
    warn.mockRestore();
  });

  it("returns the identical URL for repeated calls within the freshness window", async () => {
    const admin = fakeAdmin();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const key = `test/${crypto.randomUUID()}.png`;
    const first = await signedUrl(key, 3600);
    const second = await signedUrl(key, 3600);

    expect(second).toBe(first);
    expect(admin.createSignedUrl).toHaveBeenCalledTimes(1);
  });

  it("signs again once the cached entry is past its requested TTL", async () => {
    vi.useFakeTimers();
    const admin = fakeAdmin();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const key = `test/${crypto.randomUUID()}.png`;
    const first = await signedUrl(key, 60);
    // Advance past the full requested TTL (not just the cache's internal
    // fresh-fraction) so this stays valid regardless of exactly where that
    // fraction is tuned.
    vi.advanceTimersByTime(61_000);
    const second = await signedUrl(key, 60);

    expect(second).not.toBe(first);
    expect(admin.createSignedUrl).toHaveBeenCalledTimes(2);
  });

  it("does not share a cache entry across different requested TTLs for the same key", async () => {
    const admin = fakeAdmin();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const key = `test/${crypto.randomUUID()}.png`;
    await signedUrl(key, 600);
    await signedUrl(key, 1200);

    expect(admin.createSignedUrl).toHaveBeenCalledTimes(2);
  });

  // The scenario the task that added `transform` was explicitly worried
  // about: a display call site (transform set) and a fal-input/manifest
  // call site (no transform) reading the SAME storageKey at the SAME TTL.
  // If transform weren't part of the cache key, whichever call landed first
  // would silently hand its cached URL to the other.
  it("does not share a cache entry between a transformed and an untransformed request for the same key", async () => {
    const admin = fakeAdmin();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const key = `test/${crypto.randomUUID()}.png`;
    const untransformed = await signedUrl(key, 3600);
    const transformed = await signedUrl(key, 3600, { quality: 80 });

    expect(transformed).not.toBe(untransformed);
    expect(admin.createSignedUrl).toHaveBeenCalledTimes(2);

    // Repeating either request within the freshness window hits its own
    // cache entry rather than re-signing or colliding with the other.
    const untransformedAgain = await signedUrl(key, 3600);
    const transformedAgain = await signedUrl(key, 3600, { quality: 80 });
    expect(untransformedAgain).toBe(untransformed);
    expect(transformedAgain).toBe(transformed);
    expect(admin.createSignedUrl).toHaveBeenCalledTimes(2);
  });

  it("does not share a cache entry across different transform options for the same key", async () => {
    const admin = fakeAdmin();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const key = `test/${crypto.randomUUID()}.png`;
    await signedUrl(key, 3600, { quality: 80 });
    await signedUrl(key, 3600, { quality: 60 });

    expect(admin.createSignedUrl).toHaveBeenCalledTimes(2);
  });

  it("passes the transform through to createSignedUrl's options", async () => {
    const admin = fakeAdmin();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const key = `test/${crypto.randomUUID()}.png`;
    await signedUrl(key, 3600, { quality: 80 });

    expect(admin.createSignedUrl).toHaveBeenCalledWith(key, 3600, {
      transform: { quality: 80 },
    });
  });

  it("throws rather than transform a non-image key (e.g. a video)", async () => {
    const admin = fakeAdmin();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const key = `projects/p1/clip/${crypto.randomUUID()}.mp4`;

    await expect(signedUrl(key, 3600, { quality: 80 })).rejects.toThrow(/not.*image|image.*mp4/i);
    expect(admin.createSignedUrl).not.toHaveBeenCalled();
  });
});
