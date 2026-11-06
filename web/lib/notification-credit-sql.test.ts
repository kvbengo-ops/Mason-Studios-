import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SQL = readFileSync(
  fileURLToPath(
    new URL(
      "../../supabase/migrations/0125_credit_denied_and_limits_changed_notifications.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("credit denied / limits changed notification migration", () => {
  it("notifies the requester only on a pending → denied decision, once", () => {
    expect(SQL).toContain("if old.status <> 'pending' or new.status <> 'denied' then");
    expect(SQL).toContain("notifications_credit_denied_once_idx");
  });

  it("notifies editors only, and folds one Save's three writes into one item", () => {
    expect(SQL).toContain("if new.role not in ('editor', 'trusted_editor') then");
    expect(SQL).toContain("created_at > now() - interval '2 minutes'");
    expect(SQL).toContain("and read_at is null");
  });

  // The top bar files a notification under Credits by this prefix.
  it("keeps both new kinds under the credit_ prefix", () => {
    expect(SQL).toContain("'credit_denied', 'credit_limits_changed'");
    expect(SQL).not.toMatch(/'limits_changed'/);
  });
});
