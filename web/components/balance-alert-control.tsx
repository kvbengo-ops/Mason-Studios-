"use client";

import { useState } from "react";
import type { JSX } from "react";
import { BellRing } from "lucide-react";
import { toast } from "sonner";
import { setBalanceAlerts } from "@/actions/account";
import { PendingButton } from "@/components/pending-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAsyncAction } from "@/components/use-async-action";
import type { BalanceAlertSettings } from "@/lib/balance-alert";

function parseThreshold(raw: string): number | null | "invalid" {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : "invalid";
}

/**
 * Accounts Control's low-balance alerts: email the chosen admins once when the
 * kie or BytePlus balance drops below its threshold (lib/balance-alert.ts).
 */
export function BalanceAlertControl({
  settings,
}: {
  settings: BalanceAlertSettings;
}): JSX.Element {
  const [kie, setKie] = useState(settings.kieThresholdUsd?.toString() ?? "");
  const [bytePlus, setBytePlus] = useState(settings.bytePlusThresholdUsd?.toString() ?? "");
  const [recipients, setRecipients] = useState<ReadonlySet<string>>(
    new Set(settings.recipientIds),
  );
  const { pending, run } = useAsyncAction();

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
      } catch {
        toast.error("Could not save the balance alerts.");
      }
    });
  }

  return (
    <section
      aria-labelledby="balance-alerts-heading"
      className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card p-5"
    >
      <div className="flex items-start gap-3">
        <BellRing aria-hidden="true" className="mt-0.5 size-4 text-primary" />
        <div className="flex flex-col gap-1">
          <h2 id="balance-alerts-heading" className="text-sm font-semibold">
            Low balance alerts
          </h2>
          <p className="text-xs text-muted-foreground">
            Emails the admins you pick once when a balance drops below its threshold, and again
            only after it has been topped up and dropped again. Leave a threshold blank to turn
            that alert off.
          </p>
          {settings.emailConfigured ? null : (
            <p className="text-xs text-destructive">
              Email is not set up: add RESEND_API_KEY to web/.env.local on the server. Settings
              save, but nothing sends until then.
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="balance-alert-kie">Kie below (USD)</Label>
          <Input
            id="balance-alert-kie"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            placeholder="Off"
            value={kie}
            onChange={(event) => setKie(event.target.value)}
            disabled={pending}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="balance-alert-byteplus">BytePlus below (USD)</Label>
          <Input
            id="balance-alert-byteplus"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            placeholder="Off"
            value={bytePlus}
            onChange={(event) => setBytePlus(event.target.value)}
            disabled={pending}
          />
        </div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Admins to notify</legend>
        {settings.admins.length === 0 ? (
          <p className="text-xs text-muted-foreground">No active admins.</p>
        ) : (
          settings.admins.map((admin) => (
            <label key={admin.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={recipients.has(admin.id)}
                onChange={() => toggle(admin.id)}
                disabled={pending}
                className="size-4 accent-primary"
              />
              {admin.label}
            </label>
          ))
        )}
      </fieldset>

      <PendingButton type="button" className="self-start" pending={pending} onClick={save}>
        Save alerts
      </PendingButton>
    </section>
  );
}
