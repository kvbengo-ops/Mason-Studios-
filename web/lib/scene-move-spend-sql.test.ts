import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  fileURLToPath(
    new URL("../../supabase/migrations/0123_scene_move_spend_attribution.sql", import.meta.url),
  ),
  "utf8",
);

describe("scene move spend attribution migration", () => {
  it("backfills moved scenes and keeps future moves in sync", () => {
    expect(MIGRATION).toMatch(
      /update public\.runs r\s+set project_id = s\.project_id\s+from public\.scenes s\s+where r\.scene_id = s\.id\s+and r\.project_id is distinct from s\.project_id;/i,
    );
    expect(MIGRATION).toMatch(
      /create trigger scenes_sync_run_project_id\s+after update of project_id on public\.scenes\s+for each row\s+execute function public\.sync_run_project_id_from_scene\(\);/i,
    );
  });
});
