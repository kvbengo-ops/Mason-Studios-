import { describe, expect, it } from "vitest";
import {
  archiveFileCount,
  archiveFilename,
  buildClipEntries,
  contentDispositionHeader,
  sanitizeArchiveTitle,
} from "./archive";

describe("buildClipEntries", () => {
  // The whole point of the archive is dragging its contents into a
  // timeline in order — if this drifts from scene order, the archive is
  // actively worse than downloading clips one at a time in the UI's order.
  it("orders entries by idx regardless of input order", () => {
    const entries = buildClipEntries([
      { idx: 3, storageKey: "projects/p/clip/c.mp4" },
      { idx: 1, storageKey: "projects/p/clip/a.mp4" },
      { idx: 2, storageKey: "projects/p/clip/b.mp4" },
    ]);

    // Names are one above their (0-based) idx — filenameForClip's job; see
    // lib/manifest.test.ts. idx 1/2/3 are the 2nd/3rd/4th scenes.
    expect(entries.map((entry) => entry.name)).toEqual([
      "scene-02.mp4",
      "scene-03.mp4",
      "scene-04.mp4",
    ]);
  });

  // Zero-padding is what makes "scene-02" sort before "scene-10" in a file
  // browser — this is the same filenameForClip used for the per-clip
  // download links, so the two never disagree on a name.
  it("zero-pads scene numbers so double digits sort correctly", () => {
    const entries = buildClipEntries([
      { idx: 10, storageKey: "projects/p/clip/j.mp4" }, // 11th scene
      { idx: 2, storageKey: "projects/p/clip/b.mp4" }, // 3rd scene
    ]);

    const names = [...entries].map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(["scene-03.mp4", "scene-11.mp4"]);
  });

  it("does not mutate the input array", () => {
    const input = [
      { idx: 2, storageKey: "b.mp4" },
      { idx: 1, storageKey: "a.mp4" },
    ];
    const copy = [...input];
    buildClipEntries(input);
    expect(input).toEqual(copy);
  });

  it("carries the storage key through unmodified", () => {
    const entries = buildClipEntries([{ idx: 1, storageKey: "projects/p/clip/xyz.mov" }]);
    expect(entries[0]?.storageKey).toBe("projects/p/clip/xyz.mov");
  });
});

describe("archiveFileCount", () => {
  // Shown right on the "Download all" button — if it disagrees with what
  // the route actually zips, the button is lying to the editor.
  it("counts clips plus the always-included manifest", () => {
    expect(archiveFileCount(3, false)).toBe(4);
  });

  it("adds one more when a final asset exists", () => {
    expect(archiveFileCount(3, true)).toBe(5);
  });

  it("still counts the manifest with zero clips", () => {
    expect(archiveFileCount(0, false)).toBe(1);
  });
});

describe("sanitizeArchiveTitle", () => {
  // Titles are operator-typed free text that ends up inside a
  // Content-Disposition header — this is the case that matters most.
  it("strips characters that would break a Content-Disposition header", () => {
    expect(sanitizeArchiveTitle('Summer "Launch"')).toBe("Summer Launch");
  });

  it("strips path separators so the name is safe as a bare filename", () => {
    expect(sanitizeArchiveTitle("Q3/Q4 Campaign")).toBe("Q3Q4 Campaign");
  });

  it("strips control characters, including CR/LF that could inject headers", () => {
    expect(sanitizeArchiveTitle("Launch\r\nX-Evil-Header 1")).toBe("LaunchX-Evil-Header 1");
  });

  it("collapses internal whitespace runs to a single space", () => {
    expect(sanitizeArchiveTitle("Summer    Launch")).toBe("Summer Launch");
  });

  it("trims leading and trailing whitespace", () => {
    expect(sanitizeArchiveTitle("  Summer Launch  ")).toBe("Summer Launch");
  });

  // A title that sanitizes down to nothing (all-punctuation, or blank)
  // must not produce an empty filename.
  it("falls back to 'project' when nothing survives sanitisation", () => {
    expect(sanitizeArchiveTitle('///"""')).toBe("project");
  });

  it("falls back to 'project' for a blank title", () => {
    expect(sanitizeArchiveTitle("   ")).toBe("project");
  });

  it("caps length so an absurdly long title can't blow out the header", () => {
    const long = "a".repeat(500);
    expect(sanitizeArchiveTitle(long).length).toBeLessThanOrEqual(100);
  });

  it("leaves an already-clean title untouched", () => {
    expect(sanitizeArchiveTitle("Summer Launch 2026")).toBe("Summer Launch 2026");
  });
});

describe("archiveFilename", () => {
  it("appends .zip to the sanitized title", () => {
    expect(archiveFilename("Summer Launch")).toBe("Summer Launch.zip");
  });
});

describe("contentDispositionHeader", () => {
  it("quotes the ascii filename and includes a UTF-8 filename* form", () => {
    const header = contentDispositionHeader("Summer Launch.zip");
    expect(header).toBe(
      "attachment; filename=\"Summer Launch.zip\"; filename*=UTF-8''Summer%20Launch.zip",
    );
  });

  // Non-ASCII survives sanitizeArchiveTitle (it only strips control and
  // header-hostile chars, not unicode) so this header must still be valid
  // for a title that got through with e.g. accented characters.
  it("substitutes non-ASCII in the fallback filename but preserves it in filename*", () => {
    const header = contentDispositionHeader("Café Launch.zip");
    expect(header).toContain('filename="Caf_ Launch.zip"');
    expect(header).toContain("filename*=UTF-8''Caf%C3%A9%20Launch.zip");
  });
});
