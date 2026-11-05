import type { Notification } from "@/lib/notifications";

function metadataValue(notification: Notification, key: string): unknown {
  if (
    notification.metadata === null ||
    Array.isArray(notification.metadata) ||
    typeof notification.metadata !== "object"
  ) {
    return undefined;
  }
  return notification.metadata[key];
}

export function notificationHref(notification: Notification): string {
  if (notification.kind === "scene_completed") {
    const projectId = metadataValue(notification, "project_id");
    if (typeof projectId === "string" && notification.scene_id) {
      return metadataValue(notification, "project_kind") === "clip"
        ? `/create?tab=video&scene=${notification.scene_id}`
        : `/projects/${projectId}/scenes/${notification.scene_id}`;
    }
    return "/projects";
  }
  if (notification.kind.startsWith("task_")) return "/projects";
  if (notification.kind.startsWith("image_")) {
    const projectId = metadataValue(notification, "project_id");
    return typeof projectId === "string" ? `/images/${projectId}` : "/image-generator";
  }
  return notification.kind === "credit_received" ||
    notification.kind === "credit_sent" ||
    notification.kind === "credit_renewed"
    ? "/profile"
    : "/allowances";
}
