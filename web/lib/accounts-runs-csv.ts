import { toCsv } from "@/lib/csv";

export interface AccountsRunCsvRow {
  preview: string | null;
  userEmail: string | null;
  provider: string;
  model: string;
  costUsd: number | null;
  details: string | null;
}

export function buildAccountsRunsCsv(runs: readonly AccountsRunCsvRow[]): string {
  return toCsv(
    ["preview", "user_email", "provider", "model", "cost_usd", "details"],
    runs.map((run) => [
      run.preview,
      run.userEmail,
      run.provider,
      run.model,
      run.costUsd === null ? null : String(run.costUsd),
      run.details,
    ]),
  );
}
