"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/actions/guard";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/action-result";

const NOTIFICATIONS_PATH = "/notifications";
const SIDEBAR_LAYOUT_PATH = "/";

async function markNotificationsRead(notificationIds: string[] | null): Promise<ActionResult> {
  await requireUser();
  const supabase = await createClient();
  const { error } = await supabase.rpc("mark_notifications_read", {
    notification_ids: notificationIds,
  });
  if (error) throw new Error(`Failed to mark notifications read: ${error.message}`);
  revalidatePath(NOTIFICATIONS_PATH);
  revalidatePath(SIDEBAR_LAYOUT_PATH, "layout");
  return undefined;
}

export async function markNotificationRead(id: string): Promise<ActionResult> {
  return markNotificationsRead([id]);
}

export async function markAllNotificationsRead(): Promise<ActionResult> {
  return markNotificationsRead(null);
}
