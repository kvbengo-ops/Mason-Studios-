import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MIGRATION = fileURLToPath(
  new URL("../../supabase/migrations/0122_weekly_credit_renewal_notifications.sql", import.meta.url),
);
const SQL = readFileSync(MIGRATION, "utf8");

describe("weekly credit notification migration", () => {
  it("uses Manila week boundaries without requiring pg_cron", () => {
    expect(SQL).not.toContain("create extension if not exists pg_cron");
    expect(SQL).not.toContain("cron.schedule(");
    expect(SQL).toContain("now() at time zone 'Asia/Manila'");
    expect(SQL).toContain("where p.status = 'active'");
    expect(SQL).toContain("notifications_credit_renewed_once_idx");
    expect(SQL).toContain("on conflict do nothing");
  });

  it("leaves queued and generating image progress in the Runs panel", () => {
    expect(SQL).toContain("new.settled_at is null then");
    expect(SQL).toContain("event_kind := 'image_completed'");
    expect(SQL).not.toContain("event_kind := 'image_queued'");
    expect(SQL).not.toContain("event_kind := 'image_generating'");
  });
});
