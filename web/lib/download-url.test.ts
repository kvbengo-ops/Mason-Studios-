import { describe, expect, it } from "vitest";
import { asAttachment } from "./download-url";

// The bug this exists to stop coming back: pressing Download opened the clip
// in a tab instead of saving it, because `<a download>` is ignored for
// cross-origin hrefs and every signed URL here is cross-origin — the app is
// on onrender.com and storage is on supabase.co. Supabase answers with
// Content-Disposition when asked by query parameter, which is server-side and
// therefore survives that rule.
const SIGNED =
  "https://wyaxxmwmhayanlviovsg.supabase.co/storage/v1/object/sign/media/projects/p1/clip/abc.mp4?token=xyz";

describe("asAttachment", () => {
  it("adds the download parameter Supabase reads", () => {
    expect(asAttachment(SIGNED, "scene-1.mp4")).toContain("download=scene-1.mp4");
  });

  // The signed key is a uuid. Without a value the saved file is named after
  // the storage object rather than the scene, which is the difference between
  // a usable Downloads folder and a pile of hex.
  it("names the saved file", () => {
    const url = new URL(asAttachment(SIGNED, "scene-1.mp4"));
    expect(url.searchParams.get("download")).toBe("scene-1.mp4");
  });

  // The token is what makes the URL work at all — appending must not disturb
  // the query string that was already there.
  it("keeps the signing token", () => {
    const url = new URL(asAttachment(SIGNED, "scene-1.mp4"));
    expect(url.searchParams.get("token")).toBe("xyz");
  });

  it("still asks for an attachment when there is no filename", () => {
    const url = new URL(asAttachment(SIGNED, null));
    expect(url.searchParams.has("download")).toBe(true);
    expect(url.searchParams.get("download")).toBe("");
  });

  it("treats a blank filename as no filename", () => {
    expect(new URL(asAttachment(SIGNED, "   ")).searchParams.get("download")).toBe("");
  });

  // Called twice — a re-render, a memo miss — must not stack parameters.
  it("is idempotent", () => {
    const once = asAttachment(SIGNED, "scene-1.mp4");
    expect(asAttachment(once, "scene-1.mp4")).toBe(once);
  });

  // A control whose failure mode should be "opens the file", not "the page
  // crashed". A relative href is same-origin anyway, where the `download`
  // attribute does apply.
  it("returns a relative href untouched rather than throwing", () => {
    expect(asAttachment("/api/projects/p1/archive", "clips.zip")).toBe(
      "/api/projects/p1/archive",
    );
  });
});
