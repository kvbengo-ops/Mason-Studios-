import type { Notification } from "@/lib/notifications";

/**
 * The approver's own words on an allowance notification, exactly as written, or null when the
 * notification carries none. Approved and received grants keep it in metadata.note (0139); a
 * denial and rows written before 0139 only have it inside the body text.
 */
export function grantMessage(
  notification: Pick<Notification, "kind" | "body" | "metadata">,
): string | null {
  if (!notification.kind.startsWith("credit_")) return null;
  const metadata = notification.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const note = metadata.note;
    if (typeof note === "string" && note.trim()) return note.trim();
  }
  const text =
    notification.kind === "credit_denied"
      ? /was denied:\s*([\s\S]+)$/.exec(notification.body)?.[1]
      : /\sNote:\s*([\s\S]+)$/.exec(notification.body)?.[1];
  return text?.trim() || null;
}
