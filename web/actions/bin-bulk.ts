"use server";

import { requireAdmin } from "@/actions/guard";
import { purgeDeletedScene, purgeDeletedVersion } from "@/actions/ugc";
import type { ActionNotice, ActionResult } from "@/lib/action-result";

/** At most this many entries per press, so one request stays well inside the platform's time limit. */
const MAX_BULK_PURGE = 200;

/**
 * Permanently deletes the Bin entries an admin ticked on /bin: `scene` and
 * `version` ids from the checkboxes. Admin only, checked here and again by each
 * one-entry action it reuses, so a bulk delete removes exactly what the single
 * "Delete permanently" button would, files included.
 */
export async function purgeBinEntries(formData: FormData): Promise<ActionResult | ActionNotice> {
  await requireAdmin();

  const sceneIds = [...new Set(formData.getAll("scene").map(String).filter(Boolean))];
  const versionIds = [...new Set(formData.getAll("version").map(String).filter(Boolean))];
  const total = sceneIds.length + versionIds.length;
  if (total === 0) return { error: "Select at least one entry to delete." };
  if (total > MAX_BULK_PURGE) {
    return { error: `Select at most ${MAX_BULK_PURGE} entries at a time (you selected ${total}).` };
  }

  let deleted = 0;
  let failed = 0;
  // Versions first: a version whose scene is also selected is removed with it
  // anyway, and the other order would report that version as a failure.
  for (const versionId of versionIds) {
    const form = new FormData();
    form.set("versionId", versionId);
    const result = await purgeDeletedVersion(form).catch(() => ({ error: "failed" }));
    if (result && "error" in result && result.error) failed++;
    else deleted++;
  }
  for (const sceneId of sceneIds) {
    const form = new FormData();
    form.set("sceneId", sceneId);
    const result = await purgeDeletedScene(form).catch(() => ({ error: "failed" }));
    if (result && "error" in result && result.error) failed++;
    else deleted++;
  }

  if (deleted === 0) return { error: "Nothing was deleted; those entries may already be gone." };
  return {
    notice:
      failed > 0
        ? `Permanently deleted ${deleted}. ${failed} could not be deleted (already gone, or an error).`
        : `Permanently deleted ${deleted}.`,
  };
}
