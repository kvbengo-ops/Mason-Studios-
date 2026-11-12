"use client";

import { useState } from "react";
import type { JSX } from "react";
import { useRouter } from "next/navigation";
import { BellRing, Mail, TriangleAlert, Wallet } from "lucide-react";
import { toast } from "sonner";
import { setBalanceAlerts } from "@/actions/account";
import { PendingButton } from "@/components/pending-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAsyncAction } from "@/components/use-async-action";
import { dateTimeFormatter } from "@/lib/datetime";
import { formatUsd } from "@/lib/format-usd";
import type { BalanceAlertSettings } from "@/lib/balance-alert";
import { cn } from "@/lib/utils";

function parseThreshold(raw: string): number | null | "invalid" {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : "invalid";
}

const thresholdText = (value: number | null): string => value?.toString() ?? "";

/** One vendor's row: its live balance, the threshold field, and what the alert will do. */
function VendorThreshold({
  id,
  label,
  balanceUsd,
  value,
  onChange,
  alertedAt,
  disabled,
}: {
  id: string;
  label: string;
  balanceUsd: number | null;
  value: string;
  onChange: (value: string) => void;
  alertedAt: string | null;
  disabled: boolean;
}): JSX.Element {
  const threshold = parseThreshold(value);
  const on = typeof threshold === "number";
  const below = on && balanceUsd !== null && balanceUsd < threshold;
  const status = !on
    ? { text: "Off", tone: "border-border bg-muted text-muted-foreground" }
    : alertedAt
      ? {
          text: `Sent ${dateTimeFormatter.format(new Date(alertedAt))}`,
          tone: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
        }
      : {
          text: "Armed",
          tone: "border-green-600/40 bg-green-500/10 text-green-700 dark:text-green-400",
        };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/30 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-lg bg-background ring-1 ring-border">
            <Wallet aria-hidden="true" className="size-4 text-muted-foreground" />
          </span>
          <div className="flex flex-col">
            <label htmlFor={id} className="text-sm font-medium">
              {label}
            </label>
            <span className="text-xs tabular-nums text-muted-foreground">
              Balance {balanceUsd === null ? "unavailable" : formatUsd(balanceUsd)}
            </span>
          </div>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
            status.tone,
          )}
        >
          {status.text}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Alert when below</span>
        <div className="relative flex-1">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
            $
          </span>
          <input
            id={id}
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            placeholder="Off"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
            aria-invalid={threshold === "invalid"}
            className="h-9 w-full rounded-md border border-input bg-background pl-7 pr-3 text-sm tabular-nums shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-destructive disabled:opacity-50"
          />
        </div>
        {on ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange("")}
          >
            Turn off
          </Button>
        ) : null}
      </div>

      {below && !alertedAt ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Already below this. Saving sends an email on the next balance check, within a minute.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Accounts Control's low-balance alerts, behind a header button under "Manage
 * accounts": per-vendor thresholds and the admins to email (lib/balance-alert.ts).
 */
export function BalanceAlertControl({
  settings,
  kieBalanceUsd,
  bytePlusBalanceUsd,
}: {
  settings: BalanceAlertSettings;
  kieBalanceUsd: number | null;
  bytePlusBalanceUsd: number | null;
}): JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kie, setKie] = useState(thresholdText(settings.kieThresholdUsd));
  const [bytePlus, setBytePlus] = useState(thresholdText(settings.bytePlusThresholdUsd));
  const [recipients, setRecipients] = useState<ReadonlySet<string>>(
    new Set(settings.recipientIds),
  );
  const { pending, run } = useAsyncAction();

  const activeCount =
    (settings.kieThresholdUsd !== null ? 1 : 0) + (settings.bytePlusThresholdUsd !== null ? 1 : 0);
  const fired = settings.kieAlertedAt !== null || settings.bytePlusAlertedAt !== null;

  function openDialog(next: boolean): void {
    if (pending) return;
    if (next) {
      // Every open starts from what is saved, not from an abandoned edit.
      setKie(thresholdText(settings.kieThresholdUsd));
      setBytePlus(thresholdText(settings.bytePlusThresholdUsd));
      setRecipients(new Set(settings.recipientIds));
    }
    setOpen(next);
  }

  function toggle(id: string): void {
    setRecipients((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function save(): void {
    const kieThresholdUsd = parseThreshold(kie);
    const bytePlusThresholdUsd = parseThreshold(bytePlus);
    if (kieThresholdUsd === "invalid" || bytePlusThresholdUsd === "invalid") {
      toast.error("A threshold must be blank or zero or more.");
      return;
    }
    if ((kieThresholdUsd !== null || bytePlusThresholdUsd !== null) && recipients.size === 0) {
      toast.error("Pick at least one admin to email.");
      return;
    }
    run(async () => {
      try {
        const result = await setBalanceAlerts({
          kieThresholdUsd,
          bytePlusThresholdUsd,
          recipientIds: [...recipients],
        });
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        toast.success("Balance alerts saved.");
        setOpen(false);
        router.refresh();
      } catch {
        toast.error("Could not save the balance alerts.");
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => openDialog(true)}
        className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-card px-4 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="relative">
          <BellRing aria-hidden="true" className="size-4" />
          {fired ? (
            <span
              aria-hidden="true"
              className="absolute -right-1 -top-1 size-2 rounded-full bg-amber-500 ring-2 ring-card"
            />
          ) : null}
        </span>
        Balance alerts
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-medium",
            activeCount > 0
              ? "bg-green-500/10 text-green-700 dark:text-green-400"
              : "bg-muted text-muted-foreground",
          )}
        >
          {activeCount > 0 ? `${activeCount} on` : "Off"}
        </span>
        {fired ? <span className="sr-only">(an alert has been sent)</span> : null}
      </button>

      <Dialog open={open} onOpenChange={openDialog}>
        <DialogContent className="gap-0 p-0 sm:max-w-xl">
          <DialogHeader className="flex-row items-start gap-3 border-b border-border/70 p-6 text-left">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
              <BellRing aria-hidden="true" className="size-5" />
            </span>
            <div className="flex flex-col gap-1">
              <DialogTitle>Low balance alerts</DialogTitle>
              <DialogDescription>
                Email the admins you pick when a vendor balance drops below its threshold. One
                email per drop; it re-arms once the balance is topped up.
              </DialogDescription>
            </div>
          </DialogHeader>

          <div className="flex max-h-[65vh] flex-col gap-6 overflow-y-auto p-6">
            {settings.emailConfigured ? null : (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
              >
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                Email is not set up: add RESEND_API_KEY to web/.env.local on the server. Settings
                save, but nothing sends until then.
              </div>
            )}

            <section aria-labelledby="balance-alert-thresholds" className="flex flex-col gap-3">
              <h3
                id="balance-alert-thresholds"
                className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                Thresholds
              </h3>
              <VendorThreshold
                id="balance-alert-kie"
                label="Kie"
                balanceUsd={kieBalanceUsd}
                value={kie}
                onChange={setKie}
                alertedAt={settings.kieAlertedAt}
                disabled={pending}
              />
              <VendorThreshold
                id="balance-alert-byteplus"
                label="BytePlus"
                balanceUsd={bytePlusBalanceUsd}
                value={bytePlus}
                onChange={setBytePlus}
                alertedAt={settings.bytePlusAlertedAt}
                disabled={pending}
              />
            </section>

            <section aria-labelledby="balance-alert-recipients" className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <h3
                  id="balance-alert-recipients"
                  className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  Notify · {recipients.size} of {settings.admins.length}
                </h3>
                {settings.admins.length > 0 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      setRecipients(
                        recipients.size === settings.admins.length
                          ? new Set()
                          : new Set(settings.admins.map((admin) => admin.id)),
                      )
                    }
                  >
                    {recipients.size === settings.admins.length ? "Clear all" : "Select all"}
                  </Button>
                ) : null}
              </div>
              {settings.admins.length === 0 ? (
                <p className="text-xs text-muted-foreground">No active admins.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-border/70 overflow-hidden rounded-xl border border-border/70">
                  {settings.admins.map((admin) => {
                    const checked = recipients.has(admin.id);
                    return (
                      <li key={admin.id}>
                        <label
                          className={cn(
                            "flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-muted/60",
                            checked && "bg-primary/5",
                          )}
                        >
                          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold uppercase text-muted-foreground">
                            {admin.label.charAt(0)}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{admin.label}</span>
                          {checked ? (
                            <Mail aria-hidden="true" className="size-4 text-primary" />
                          ) : null}
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggle(admin.id)}
                            disabled={pending}
                            className="size-4 accent-primary"
                          />
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>

          <DialogFooter className="border-t border-border/70 p-4">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => openDialog(false)}
            >
              Cancel
            </Button>
            <PendingButton type="button" pending={pending} onClick={save}>
              Save alerts
            </PendingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
