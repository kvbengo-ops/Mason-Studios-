import type { JSX } from "react";
import { UserAvatar } from "@/components/user-avatar";

export function UserPresenceStrip({
  total,
  online,
  users,
}: {
  total: number | null;
  online: number | null;
  users: { id: string; username: string; email: string; avatarUrl?: string }[];
}): JSX.Element {
  if (total === null || online === null) {
    return (
      <div className="rounded-lg border border-border bg-card px-5 py-4 text-sm text-muted-foreground">
        User activity is temporarily unavailable.
      </div>
    );
  }

  const visibleUsers = users.slice(0, 6);
  return (
    <section
      aria-label="User presence"
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-card px-5 py-4 sm:min-h-20 sm:flex-row sm:flex-wrap sm:items-center sm:gap-6"
    >
      <div className="shrink-0">
        <p className="flex items-center gap-2 text-sm tabular-nums">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-success" />
          <span className="font-semibold text-foreground">{online} online</span>
          <span className="text-muted-foreground">of {total}</span>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Active in the last 2 minutes · updates every 30 s
        </p>
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-3 sm:min-w-32">
        <div
          role="img"
          aria-label={`${online} of ${total} users online`}
          className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-success"
            style={{ width: `${total > 0 ? (online / total) * 100 : 0}%` }}
          />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {total - online} offline
        </span>
      </div>
      {online === 0 ? (
        <p className="text-xs text-muted-foreground">Nobody online right now</p>
      ) : (
        <div className="flex shrink-0 items-center gap-3">
          <div className="flex -space-x-2">
            {visibleUsers.map((user) => (
              <UserAvatar key={user.id} {...user} className="size-8 ring-2 ring-card" />
            ))}
          </div>
          {online > visibleUsers.length && (
            <span className="text-xs tabular-nums text-muted-foreground">
              +{online - visibleUsers.length}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
