import { createClient } from "@/lib/supabase/server";
import type { Json, NotificationKind } from "@/types/db";

export interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  metadata: Json;
  created_at: string;
  read_at: string | null;
  scene_id: string | null;
  allowance_request_id: string | null;
}

export async function getNotifications(userId: string): Promise<Notification[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("notifications")
    .select(
      "id, kind, title, body, metadata, created_at, read_at, scene_id, allowance_request_id",
    )
    .eq("user_id", userId)
    .neq("kind", "image_queued")
    .neq("kind", "image_generating")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`Failed to load notifications: ${error.message}`);
  return data ?? [];
}

export async function getRecentNotifications(userId: string): Promise<Notification[]> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("notifications")
      .select(
        "id, kind, title, body, metadata, created_at, read_at, scene_id, allowance_request_id",
      )
      .eq("user_id", userId)
      .neq("kind", "image_queued")
      .neq("kind", "image_generating")
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    return data ?? [];
  } catch (error) {
    console.error("Failed to load recent notifications", error);
    return [];
  }
}

export async function getUnreadNotificationCount(userId: string): Promise<number | null> {
  try {
    const supabase = await createClient();
    const { count, error } = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .neq("kind", "image_queued")
      .neq("kind", "image_generating")
      .is("read_at", null);
    return error ? null : (count ?? 0);
  } catch (error) {
    console.error("Failed to load notification count", error);
    return null;
  }
}
