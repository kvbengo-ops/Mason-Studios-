import { toCsv } from "@/lib/csv";
import { CREDITS_PER_USD } from "@/lib/kie/rates";

export interface AccountsRunCsvRow {
  username: string | null;
  model: string;
  provider: string;
  costUsd: number | null;
  durationS: number | null;
}

export function buildAccountsRunsCsv(runs: readonly AccountsRunCsvRow[]): string {
  return toCsv(
    ["username", "model", "provider", "cost_usd", "kie_credits", "duration_s"],
    runs.map((run) => [
      run.username,
      run.model,
      run.provider,
      run.costUsd === null ? null : String(run.costUsd),
      run.provider.toLowerCase() === "kie" && run.costUsd !== null
        ? String(Number((run.costUsd * CREDITS_PER_USD).toFixed(1)))
        : null,
      run.durationS === null ? null : String(run.durationS),
    ]),
  );
}
