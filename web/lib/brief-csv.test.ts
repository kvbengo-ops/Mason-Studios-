import { describe, expect, it } from "vitest";
import {
  briefCsvFilename,
  briefCsvRows,
  buildBriefCsv,
  type BriefCsvSceneInput,
} from "@/lib/brief-csv";

const scene = (overrides: Partial<BriefCsvSceneInput> = {}): BriefCsvSceneInput => ({
  idx: 0,
  scriptLine: "Hey, check this out.",
  videoPrompt: "Close-up on the product label.",
  isTalkingHead: true,
  durationS: 6,
  ...overrides,
});

describe("briefCsvRows", () => {
  it("renders the scene index 1-based, matching the on-screen '#' column", () => {
    const rows = briefCsvRows([scene({ idx: 0 }), scene({ idx: 4 })]);
    expect(rows[0]?.[0]).toBe("1");
    expect(rows[1]?.[0]).toBe("5");
  });

  it("carries script line and video prompt through unmodified (escaping is csv.ts's job)", () => {
    const rows = briefCsvRows([scene({ scriptLine: "a, b", videoPrompt: null })]);
    expect(rows[0]).toEqual(["1", "a, b", null, "A-roll", "6"]);
  });

  it("labels the roll toggle A-roll/B-roll to match RollToggle in scene-table.tsx", () => {
    const rows = briefCsvRows([scene({ isTalkingHead: true }), scene({ isTalkingHead: false })]);
    expect(rows[0]?.[3]).toBe("A-roll");
    expect(rows[1]?.[3]).toBe("B-roll");
  });

  it("stringifies duration in seconds", () => {
    const rows = briefCsvRows([scene({ durationS: 8 })]);
    expect(rows[0]?.[4]).toBe("8");
  });
});

describe("buildBriefCsv", () => {
  it("includes the header row", () => {
    const csv = buildBriefCsv([]);
    expect(csv).toBe("Scene,Script line,Video prompt,Roll,Duration (s)\r\n");
  });

  it("quotes a scene field containing a comma, a quote, and a newline", () => {
    const csv = buildBriefCsv([scene({ videoPrompt: 'Say "hi", then\ncut to product' })]);
    expect(csv).toContain('"Say ""hi"", then\ncut to product"');
  });

  it("neutralises a script line that starts with a dash", () => {
    const csv = buildBriefCsv([scene({ scriptLine: "- cold open on kitchen counter" })]);
    expect(csv).toContain("'- cold open on kitchen counter");
  });

  it("renders a null video prompt as an empty cell, not the text 'null'", () => {
    const csv = buildBriefCsv([scene({ videoPrompt: null })]);
    expect(csv).not.toContain("null");
  });
});

describe("briefCsvFilename", () => {
  it("appends -brief.csv to a clean title", () => {
    expect(briefCsvFilename("Summer Launch")).toBe("Summer Launch-brief.csv");
  });

  // The 1444-character title was a real, shipped bug — the filename must
  // stay well under any filesystem/header length ceiling regardless.
  it("caps an absurdly long (1444-char) title to a bounded filename", () => {
    const longTitle = "x".repeat(1444);
    const filename = briefCsvFilename(longTitle);
    expect(filename.length).toBeLessThanOrEqual(110);
    expect(filename.endsWith("-brief.csv")).toBe(true);
  });

  it("strips header/filesystem-hostile characters from the title", () => {
    expect(briefCsvFilename('Summer "Launch"/Q4')).toBe("Summer LaunchQ4-brief.csv");
  });

  it("falls back to 'project-brief.csv' for an empty or all-stripped title", () => {
    expect(briefCsvFilename("")).toBe("project-brief.csv");
    expect(briefCsvFilename('///"""')).toBe("project-brief.csv");
  });
});
