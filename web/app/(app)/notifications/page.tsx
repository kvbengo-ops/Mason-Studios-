import type { JSX } from "react";
import { requireUser } from "@/actions/guard";
import { getNotifications } from "@/lib/notifications";
import { NotificationsList } from "@/components/notifications-list";

export default async function NotificationsPage(): Promise<JSX.Element> {
  const { user } = await requireUser();
  const notifications = await getNotifications(user.id);
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-medium text-foreground">Notifications</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Updates about your scenes and weekly credits.
        </p>
      </div>
      <NotificationsList initialNotifications={notifications} currentUserId={user.id} />
    </div>
  );
}
