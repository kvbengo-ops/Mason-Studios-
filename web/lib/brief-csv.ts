// Gate 1's "Export CSV" download — app/(app)/projects/[id]/brief/page.tsx
// and app/api/projects/[id]/brief-csv/route.ts. The pure, unit-testable
// half (row/filename shaping); the route handler is just I/O (the scenes
// query + the HTTP response) wired around it, same split as
// lib/archive.ts / app/api/projects/[id]/archive/route.ts.
//
// ## This is a read for review and sharing, NOT a save file
//
// Do not wire this into the script importer (lib/script-columns.ts's
// parseTwoColumnScript) as a round trip, and do not let the UI copy imply
// one. parseTwoColumnScript splits an input line on the FIRST tab, then
// the first `|` — it never looks at commas. A comma-separated line from
// THIS export, pasted back into the Brief/character-setup script textarea,
// therefore parses as a single column: the video-prompt half silently
// disappears into the script cell. Worse, parseTwoColumnScript never
// throws by design (see that file's header — a parser that can fail on odd
// input would block the workflow it exists to make safer), so that bad
// "import" produces no error and no warning; it looks exactly like a
// successful one. The next person who wants a save/restore path for a
// brief needs a real round-trip format (or a comma-aware import mode) —
// this CSV is not it, and teaching the importer about CSV using this
// module's output as the round-trip case is explicitly out of scope here.
//
// ## Column choice
//
// Mirrors what components/scene-table.tsx actually renders on the Brief
// page (#, Script line, Video prompt, Roll, Sec) — not lib/script-columns.ts's
// ScriptRow field names verbatim. ScriptRow (`script`/`visualIdea`)
// describes PARSED, not-yet-compiled INPUT; once a project reaches the
// Brief page, the analogous on-screen fields are scenes.script_line and
// scenes.video_prompt (the operator edits video_prompt directly in the
// table — that's the compiled/editable value, not the earlier
// scenes.visual_idea input that shaped it). Two more per-scene facts are
// visibly on this page and are included for the same "match the screen"
// reason: the A-roll/B-roll toggle and the duration in seconds.
//
// projects.product_appearance and projects.pronunciation_guide
// (0041_product_appearance.sql) are deliberately left out: they're
// PROJECT-level fields set on an earlier step, this page never displays
// them, and repeating the same project-level string on every scene row
// would misrepresent them as per-scene data that varies by row.

import { toCsv } from "@/lib/csv";
import { sanitizeArchiveTitle } from "@/lib/archive";

export interface BriefCsvSceneInput {
  /** Zero-based scene order (scenes.idx). Rendered 1-based, matching the
   *  "#" column scene-table.tsx shows. */
  idx: number;
  scriptLine: string | null;
  videoPrompt: string | null;
  isTalkingHead: boolean;
  durationS: number;
}

const HEADER = ["Scene", "Script line", "Video prompt", "Roll", "Duration (s)"] as const;

/** One CSV data row per scene, in caller-supplied order (the route sorts
 *  by idx before calling this, same as the Brief page's own query). */
export function briefCsvRows(scenes: readonly BriefCsvSceneInput[]): (string | null)[][] {
  return scenes.map((scene) => [
    String(scene.idx + 1),
    scene.scriptLine,
    scene.videoPrompt,
    scene.isTalkingHead ? "A-roll" : "B-roll",
    String(scene.durationS),
  ]);
}

/** The full CSV document body (header + one row per scene). RFC 4180
 *  quoting and formula-injection neutralisation happen inside toCsv/csvField
 *  (lib/csv.ts) — this function only shapes the rows. */
export function buildBriefCsv(scenes: readonly BriefCsvSceneInput[]): string {
  return toCsv([...HEADER], briefCsvRows(scenes));
}

/**
 * Filename for the download, carrying the project title. Reuses
 * lib/archive.ts's sanitizeArchiveTitle rather than re-implementing
 * title-sanitisation a second time — that function's name is a holdover
 * from its original (zip) call site, but its job (strip control/header/
 * filesystem-hostile characters, collapse whitespace, cap length, fall
 * back to "project" for an empty/all-stripped title) is generic and
 * already covers the pathological case that matters here: a project title
 * can be up to 1444 characters (a real, shipped bug), which would
 * otherwise land untruncated in a Content-Disposition header.
 */
export function briefCsvFilename(title: string): string {
  return `${sanitizeArchiveTitle(title)}-brief.csv`;
}
