"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Bell } from "lucide-react";
import { markNotificationRead } from "@/actions/notifications";
import { AccountMenu } from "@/components/account-menu";
import { createClient } from "@/lib/supabase/client";
import type { SidebarBudget } from "@/lib/sidebar-budget";
import type { Notification } from "@/lib/notifications";
import { grantMessage } from "@/lib/grant-message";
import { notificationHref } from "@/lib/notification-href";
import type { Database } from "@/types/db";

type NotificationRow = Database["public"]["Tables"]["notifications"]["Row"];

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

export function TopBar({
  unreadNotificationCount,
  initialNotifications,
  currentUserId,
  email,
  roleLabel,
  avatarUrl,
  isAdmin,
  budget,
}: {
  unreadNotificationCount: number | null;
  initialNotifications: Notification[];
  currentUserId: string;
  email: string;
  roleLabel: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  budget: SidebarBudget | null;
}): JSX.Element {
  const [filter, setFilter] = useState<"all" | "activity" | "credits" | "messages">("all");
  const [notificationCount, setNotificationCount] = useState(unreadNotificationCount);
  const [notifications, setNotifications] = useState(initialNotifications);
  const [previousNotificationCount, setPreviousNotificationCount] =
    useState(unreadNotificationCount);

  if (previousNotificationCount !== unreadNotificationCount) {
    setPreviousNotificationCount(unreadNotificationCount);
    setNotificationCount(unreadNotificationCount);
  }
  const [previousInitialNotifications, setPreviousInitialNotifications] =
    useState(initialNotifications);
  if (previousInitialNotifications !== initialNotifications) {
    setPreviousInitialNotifications(initialNotifications);
    setNotifications(initialNotifications);
  }

  useEffect((): (() => void) => {
    const supabase = createClient();
    const channel = supabase
      .channel(`notifications:${currentUserId}`)
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
          if (notification.kind === "image_queued" || notification.kind === "image_generating") {
            return;
          }
          setNotificationCount((count) => (count ?? 0) + 1);
          setNotifications((current) => [notification, ...current].slice(0, 20));
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
          const progress =
            notification.kind === "image_queued" || notification.kind === "image_generating";
          if (!progress && payload.old.read_at === null && payload.new.read_at !== null) {
            setNotificationCount((count) => Math.max(0, (count ?? 0) - 1));
          }
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

  const visibleNotifications = notifications
    .filter(
      (notification) =>
        notification.kind !== "image_queued" && notification.kind !== "image_generating",
    )
    .filter((notification) => {
      if (filter === "credits") return notification.kind.startsWith("credit_");
      if (filter === "activity") return !notification.kind.startsWith("credit_");
      if (filter === "messages") return grantMessage(notification) !== null;
      return true;
    })
    .slice(0, 5);

  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center justify-between border-b border-sidebar-border bg-sidebar/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-sidebar/80 sm:px-6">
      <div className="flex items-center gap-3 md:hidden">
        <label
          htmlFor="sidebar-toggle"
          className="cursor-pointer rounded-md border border-sidebar-border px-3 py-1.5 text-sm text-sidebar-foreground transition-[background-color,transform] duration-200 hover:bg-sidebar-accent active:scale-95"
        >
          Menu
        </label>
      </div>

      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        <div className="group/preview relative">
          <Link
            href="/notifications"
            aria-label="Notifications"
            className="group/notifications relative inline-flex size-10 items-center justify-center rounded-full text-sidebar-foreground/70 outline-none transition-[background-color,color,transform] duration-200 hover:-translate-y-px hover:bg-sidebar-accent hover:text-sidebar-foreground active:scale-90 focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          >
            <Bell
              aria-hidden="true"
              className="size-5 transition-transform duration-200 group-hover/notifications:-rotate-6 group-hover/notifications:scale-110"
            />
            {notificationCount ? (
              <span
                key={notificationCount}
                aria-label={`${notificationCount} unread notifications`}
                className="pointer-events-none absolute -right-0.5 -top-0.5 flex min-w-4 animate-in items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground zoom-in-50 duration-200"
              >
                {notificationCount > 9 ? "9+" : notificationCount}
              </span>
            ) : null}
          </Link>

          <div className="pointer-events-none invisible absolute -right-12 top-full z-50 w-[calc(100vw-2rem)] max-w-80 translate-y-1 pt-2 opacity-0 transition-[opacity,transform,visibility] duration-200 group-hover/preview:pointer-events-auto group-hover/preview:visible group-hover/preview:translate-y-0 group-hover/preview:opacity-100 group-focus-within/preview:pointer-events-auto group-focus-within/preview:visible group-focus-within/preview:translate-y-0 group-focus-within/preview:opacity-100 sm:right-0 sm:w-80">
            <div className="overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl shadow-black/10">
              <div className="border-b border-border px-3 py-3">
                <div className="flex items-center justify-between gap-3 px-1">
                  <p className="text-sm font-semibold">Notifications</p>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {notificationCount ?? 0} unread
                  </span>
                </div>
                <div
                  role="group"
                  aria-label="Filter notifications"
                  className="mt-3 flex gap-1 rounded-lg bg-muted/60 p-1"
                >
                  {(
                    [
                      ["all", "All"],
                      ["activity", "Activity"],
                      ["credits", "Allowance"],
                      ["messages", "Messages"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={filter === value}
                      onClick={() => setFilter(value)}
                      className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${filter === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {visibleNotifications.length ? (
                <div className="max-h-[min(65vh,28rem)] divide-y divide-border overflow-y-auto overscroll-contain">
                  {visibleNotifications.map((notification) => (
                    <Link
                      key={notification.id}
                      href={notificationHref(notification)}
                      onClick={() => {
                        if (!notification.read_at) void markNotificationRead(notification.id);
                      }}
                      className={`group/item flex items-start gap-3 px-4 py-3 outline-none transition-colors duration-150 hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${notification.read_at ? "" : "bg-accent/20"}`}
                    >
                      <span
                        aria-hidden="true"
                        className={`mt-1.5 size-2 shrink-0 rounded-full ${notification.read_at ? "bg-muted-foreground/30" : "bg-destructive"}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="block truncate text-sm font-medium">
                            {notification.title}
                          </span>
                          <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                            {notification.kind.startsWith("credit_") ? "Allowance" : "Activity"}
                          </span>
                        </span>
                        {filter === "messages" ? (
                          <span className="mt-1 block whitespace-pre-wrap break-words rounded-md bg-muted/60 px-2 py-1.5 text-xs text-foreground">
                            {grantMessage(notification)}
                          </span>
                        ) : (
                          <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                            {notification.body}
                          </span>
                        )}
                      </span>
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {filter === "credits"
                    ? "No allowance notifications yet."
                    : filter === "activity"
                      ? "No activity notifications yet."
                      : filter === "messages"
                        ? "No messages from grants yet."
                        : "No notifications yet."}
                </p>
              )}
              <Link
                href="/notifications"
                className="block border-t border-border px-4 py-3 text-center text-sm font-medium text-primary outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                See all notifications
              </Link>
            </div>
          </div>
        </div>

        <div className="h-6 w-px bg-sidebar-border" aria-hidden="true" />

        <AccountMenu
          email={email}
          roleLabel={roleLabel}
          avatarUrl={avatarUrl}
          isAdmin={isAdmin}
          budget={budget}
          placement="topbar"
        />
      </div>
    </header>
  );
}
