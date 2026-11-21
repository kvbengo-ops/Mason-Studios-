"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/actions/guard";
import { RUNS_CLEARED_COOKIE } from "@/lib/runs-view";

// Clears the Accounts Control runs table for this browser only (owner, 2026-11-21).
// Nothing is deleted: runs feed the spend caps and the CSV export, which ignore this.

/** Hides every run up to now from this admin's runs table. */
export async function clearRunsView(): Promise<void> {
  await requireAdmin();
  (await cookies()).set(RUNS_CLEARED_COOKIE, new Date().toISOString(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/accounts-control",
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath("/accounts-control");
}

/** Shows every run in the window again. */
export async function restoreRunsView(): Promise<void> {
  await requireAdmin();
  (await cookies()).delete({ name: RUNS_CLEARED_COOKIE, path: "/accounts-control" });
  revalidatePath("/accounts-control");
}
