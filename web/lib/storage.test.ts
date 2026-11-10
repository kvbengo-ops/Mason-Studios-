import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getImageUrl,
  buildStorageKey,
  extFromContentType,
  extFromFilename,
  MEDIA_BUCKET,
  signedUrl,
  signedUrlWithExpiry,
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

  it("getImageUrl signs the pre-sized copy, never a transform", async () => {
    const admin = fakeAdmin();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const key = `projects/p/ref_frame/${crypto.randomUUID()}.png`;
    const url = await getImageUrl(key, "thumb", 3600);

    expect(url).toContain(`${key}.thumb.webp`);
    expect(admin.createSignedUrl).toHaveBeenCalledWith(`${key}.thumb.webp`, 3600, undefined);
  });

  it("getImageUrl falls back to the original when the copy is missing", async () => {
    const admin = fakeAdmin();
    admin.createSignedUrl.mockImplementationOnce(
      async () =>
        ({
          data: null,
          error: { message: "Object not found" },
        }) as never,
    );
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const key = `projects/p/ref_frame/${crypto.randomUUID()}.png`;
    const url = await getImageUrl(key, "medium", 3600);

    expect(url).toContain(`${key}?`);
    expect(admin.createSignedUrl).toHaveBeenLastCalledWith(key, 3600, undefined);
  });

  it("getImageUrl asks for a missing copy once, then goes straight to the original", async () => {
    const admin = fakeAdmin();
    const original = admin.createSignedUrl.getMockImplementation()!;
    admin.createSignedUrl.mockImplementation(async (key: string, ttl: number) =>
      key.endsWith(".thumb.webp")
        ? ({ data: null, error: { message: "Object not found" } } as never)
        : original(key, ttl),
    );
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const key = `projects/p/ref_frame/${crypto.randomUUID()}.png`;
    await getImageUrl(key, "thumb", 600);
    await getImageUrl(key, "thumb", 600);

    const copyCalls = admin.createSignedUrl.mock.calls.filter(([k]) =>
      String(k).endsWith(".thumb.webp"),
    );
    expect(copyCalls).toHaveLength(1);
  });

  it("getImageUrl signs a non-image key as it is", async () => {
    const admin = fakeAdmin();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const key = `projects/p1/clip/${crypto.randomUUID()}.mp4`;
    await getImageUrl(key, "thumb");

    expect(admin.createSignedUrl).toHaveBeenCalledTimes(1);
    expect(admin.createSignedUrl).toHaveBeenCalledWith(key, 3600, undefined);
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

  it("signedUrlWithExpiry returns 3600 on fresh sign and accurate remaining seconds on cache hit", async () => {
    vi.useFakeTimers();
    const admin = fakeAdmin();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const key = `projects/p1/clip/${crypto.randomUUID()}.mp4`;
    const first = await signedUrlWithExpiry(key, 3600);
    expect(first.expiresInSeconds).toBe(3600);

    vi.advanceTimersByTime(1000 * 600); // 10 minutes later
    const second = await signedUrlWithExpiry(key, 3600);
    expect(second.url).toBe(first.url);
    expect(second.expiresInSeconds).toBe(3000);
    expect(admin.createSignedUrl).toHaveBeenCalledTimes(1);
  });
});
