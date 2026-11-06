"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import type { JSX } from "react";
import Link from "next/link";
import {
  Bell,
  Check,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Coins,
  HandCoins,
  ImageIcon,
  SlidersHorizontal,
} from "lucide-react";
import { markAllNotificationsRead, markNotificationRead } from "@/actions/notifications";
import type { Notification } from "@/lib/notifications";
import { notificationHref } from "@/lib/notification-href";
import { formatAllowanceAmount, type AllowanceDisplayUnit } from "@/lib/format-usd";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Database } from "@/types/db";

type NotificationRow = Database["public"]["Tables"]["notifications"]["Row"];

const MANILA_TIME_ZONE = "Asia/Manila";
const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: MANILA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: MANILA_TIME_ZONE,
  month: "short",
  day: "numeric",
  year: "numeric",
});
const timeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: MANILA_TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
});

function dayKey(date: Date): string {
  const parts = dayKeyFormatter.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function previousDayKey(todayKey: string): string {
  const [year = 1970, month = 1, day = 1] = todayKey.split("-").map(Number);
  const previous = new Date(Date.UTC(year, month - 1, day - 1));
  return [
    previous.getUTCFullYear(),
    String(previous.getUTCMonth() + 1).padStart(2, "0"),
    String(previous.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function notificationFromRealtime(row: NotificationRow): Notification {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    metadata: row.metadata,
    created_at: row.created_at,
    read_at: row.read_at,
    scene_id: row.scene_id,
    allowance_request_id: row.allowance_request_id,
  };
}

function iconFor(kind: Notification["kind"]): typeof CircleCheck {
  if (kind === "credit_requested") return HandCoins;
  if (kind === "credit_denied") return CircleX;
  if (kind === "credit_limits_changed") return SlidersHorizontal;
  if (kind === "credit_received" || kind === "credit_sent" || kind === "credit_renewed")
    return Coins;
  if (kind === "image_queued") return Clock;
  if (kind === "image_generating") return ImageIcon;
  if (kind === "image_failed" || kind === "image_billing_unknown") return CircleAlert;
  return CircleCheck;
}

function dateLabel(value: string, todayKey: string): string {
  const date = new Date(value);
  const notificationDay = dayKey(date);
  if (notificationDay === todayKey) return "Today";
  if (notificationDay === previousDayKey(todayKey)) return "Yesterday";
  return dateFormatter.format(date);
}

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

function notificationBody(notification: Notification, displayUnit: AllowanceDisplayUnit): string {
  const amountUsd = metadataValue(
    notification,
    notification.kind === "credit_requested" ? "requested_usd" : "amount_usd",
  );
  if (typeof amountUsd !== "number") return notification.body;

  const amount = formatAllowanceAmount(amountUsd, displayUnit);
  if (notification.kind === "credit_requested") return `${amount} requested.`;
  if (notification.kind === "credit_approved") {
    return `${amount} added to your weekly allowance.`;
  }
  if (notification.kind === "credit_sent") return `${amount} passed to a teammate.`;
  if (notification.kind === "credit_received") {
    return `${amount} added to your weekly allowance by a teammate.`;
  }
  return notification.body;
}

export function NotificationsList({
  initialNotifications,
  displayUnit,
  currentUserId,
}: {
  initialNotifications: Notification[];
  displayUnit: AllowanceDisplayUnit;
  currentUserId: string;
}): JSX.Element {
  const [notifications, setNotifications] = useState(initialNotifications);
  const [previousInitialNotifications, setPreviousInitialNotifications] =
    useState(initialNotifications);
  if (previousInitialNotifications !== initialNotifications) {
    setPreviousInitialNotifications(initialNotifications);
    setNotifications(initialNotifications);
  }
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [isPending, startTransition] = useTransition();
  const todayKey = dayKey(new Date());
  const grouped = useMemo((): [string, Notification[]][] => {
    const groups = new Map<string, Notification[]>();
    for (const notification of notifications) {
      if (filter === "unread" && notification.read_at) continue;
      const label = dateLabel(notification.created_at, todayKey);
      groups.set(label, [...(groups.get(label) ?? []), notification]);
    }
    return [...groups];
  }, [filter, notifications, todayKey]);
  const unread = notifications.filter((notification) => !notification.read_at).length;

  useEffect((): (() => void) => {
    const supabase = createClient();
    const channel = supabase
      .channel(`notification-inbox:${currentUserId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${currentUserId}`,
        },
        (payload): void => {
          const notification = notificationFromRealtime(payload.new as NotificationRow);
          setNotifications((current) =>
            current.some((item) => item.id === notification.id)
              ? current
              : [notification, ...current].slice(0, 100),
          );
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${currentUserId}`,
        },
        (payload): void => {
          const notification = notificationFromRealtime(payload.new as NotificationRow);
          setNotifications((current) =>
            current.map((item) => (item.id === notification.id ? notification : item)),
          );
        },
      )
      .subscribe();

    return (): void => {
      void supabase.removeChannel(channel);
    };
  }, [currentUserId]);

  function markRead(notification: Notification): void {
    if (notification.read_at) return;
    const markedAt = new Date().toISOString();
    setNotifications((current) =>
      current.map((item) => (item.id === notification.id ? { ...item, read_at: markedAt } : item)),
    );
    startTransition(async () => {
      await markNotificationRead(notification.id);
    });
  }

  function markAllRead(): void {
    const markedAt = new Date().toISOString();
    setNotifications((current) =>
      current.map((item) => ({ ...item, read_at: item.read_at ?? markedAt })),
    );
    startTransition(async () => {
      await markAllNotificationsRead();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
        <Button
          type="button"
          size="sm"
          variant={filter === "all" ? "secondary" : "ghost"}
          aria-pressed={filter === "all"}
          onClick={() => setFilter("all")}
        >
          All
        </Button>
        <Button
          type="button"
          size="sm"
          variant={filter === "unread" ? "secondary" : "ghost"}
          aria-pressed={filter === "unread"}
          onClick={() => setFilter("unread")}
        >
          Unread{unread ? ` (${unread})` : ""}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="link"
          className="ml-auto"
          disabled={!unread || isPending}
          onClick={markAllRead}
        >
          <Check aria-hidden="true" />
          Mark all as read
        </Button>
      </div>

      {grouped.length ? (
        grouped.map(([label, rows], groupIndex) => {
          const headingId = `notification-group-${groupIndex}`;
          return (
            <section key={label} aria-labelledby={headingId}>
              <h2
                id={headingId}
                className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {label}
              </h2>
              <div className="divide-y divide-border rounded-lg border border-border bg-card">
                {rows.map((notification) => {
                  const Icon = iconFor(notification.kind);
                  return (
                    <Link
                      key={notification.id}
                      href={notificationHref(notification)}
                      onClick={() => markRead(notification)}
                      className={cn(
                        "flex items-start gap-3 p-4 outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        !notification.read_at && "bg-accent/20",
                      )}
                    >
                      <span
                        className={cn(
                          "flex size-9 shrink-0 items-center justify-center rounded-full",
                          notification.kind === "scene_completed" ||
                            notification.kind === "credit_approved"
                            ? "bg-success/15 text-success"
                            : "bg-accent text-accent-foreground",
                        )}
                      >
                        <Icon aria-hidden="true" className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="font-medium text-foreground">{notification.title}</span>
                          {!notification.read_at ? (
                            <span
                              aria-label="Unread"
                              className="size-1.5 shrink-0 rounded-full bg-primary"
                            />
                          ) : null}
                        </span>
                        <span className="mt-0.5 block text-sm text-muted-foreground">
                          {notificationBody(notification, displayUnit)}
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {timeFormatter.format(new Date(notification.created_at))}
                        </span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            </section>
          );
        })
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-12 text-center">
          <Bell aria-hidden="true" className="size-6 text-muted-foreground" />
          <p className="font-medium">
            {filter === "unread" ? "You’re all caught up" : "No notifications yet"}
          </p>
          <p className="text-sm text-muted-foreground">
            Updates about images, scenes, tasks and credits will appear here.
          </p>
        </div>
      )}
    </div>
  );
}
