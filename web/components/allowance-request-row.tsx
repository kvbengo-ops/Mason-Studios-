"use client";

import { useState } from "react";
import type { JSX, KeyboardEvent, ReactNode } from "react";
import { AllowanceStatusBadge } from "@/components/allowance-status-badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TableRow } from "@/components/ui/table";
import { dateTimeFormatter } from "@/lib/datetime";
import { formatUsd } from "@/lib/format-usd";
import type { AllowanceRequestStatus } from "@/types/db";

export function AllowanceRequestRow({
  requestId,
  userId,
  username,
  email,
  requestedUsd,
  reason,
  status,
  createdAt,
  decidedByEmail,
  decidedAt,
  decisionNote,
  children,
}: {
  requestId: string;
  userId: string;
  username: string;
  email: string;
  requestedUsd: number;
  reason: string | null;
  status: AllowanceRequestStatus;
  createdAt: string;
  decidedByEmail: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);

  function onKeyDown(event: KeyboardEvent<HTMLTableRowElement>): void {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(true);
    }
  }

  return (
    <>
      <TableRow
        tabIndex={0}
        aria-label={`Preview allowance request from ${email}`}
        className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button, a, input, textarea")) return;
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      >
        {children}
      </TableRow>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Allowance request</DialogTitle>
          </DialogHeader>
          <dl className="grid gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">Requester</dt>
              <dd className="font-medium">
                {username} · {email}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Requested amount</dt>
              <dd className="font-medium">{formatUsd(requestedUsd)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Reason</dt>
              <dd className="whitespace-pre-wrap break-words">{reason || "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <AllowanceStatusBadge status={status} />
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Requested at</dt>
              <dd>{dateTimeFormatter.format(new Date(createdAt))}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Decision</dt>
              <dd>
                {decidedAt
                  ? `${decidedByEmail ?? "Unknown approver"} · ${dateTimeFormatter.format(new Date(decidedAt))}`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Decision note</dt>
              <dd className="whitespace-pre-wrap break-words">{decisionNote || "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Request ID</dt>
              <dd className="break-all font-mono text-xs">{requestId}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Requester ID</dt>
              <dd className="break-all font-mono text-xs">{userId}</dd>
            </div>
          </dl>
        </DialogContent>
      </Dialog>
    </>
  );
}
