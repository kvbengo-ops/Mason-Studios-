import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SQL = readFileSync(
  fileURLToPath(new URL("../../supabase/migrations/0140_balance_alerts.sql", import.meta.url)),
  "utf8",
);

// AGENTS.md: a new table needs RLS and a policy, or it is either readable by
// every signed-in account (0007's grants) or silently empty.
describe("balance_alert_settings migration", () => {
  it("enables RLS with an admin-only select policy and no write policy", () => {
    expect(SQL).toContain("alter table balance_alert_settings enable row level security;");
    expect(SQL).toMatch(/create policy balance_alert_settings_select[\s\S]*for select/);
    expect(SQL).toContain("using ((select is_admin()))");
    expect(SQL).not.toMatch(/for (insert|update|delete|all)/);
  });

  it("seeds the single row the app updates", () => {
    expect(SQL).toContain("insert into balance_alert_settings (id) values (true);");
  });
});
