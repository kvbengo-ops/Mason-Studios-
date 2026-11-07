"use client";

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type CostConfirmation = {
  title: string;
  estimateUsd: number;
  action: string;
  note?: string;
};

export function useCostConfirmation(): [
  (details: CostConfirmation) => Promise<boolean>,
  JSX.Element,
] {
  const [request, setRequest] = useState<CostConfirmation | null>(null);
  const resolveRef = useRef<((confirmed: boolean) => void) | null>(null);

  useEffect(() => () => resolveRef.current?.(false), []);

  function settle(confirmed: boolean): void {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setRequest(null);
    resolve?.(confirmed);
  }

  function confirm(details: CostConfirmation): Promise<boolean> {
    if (resolveRef.current) return Promise.resolve(false);
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      setRequest(details);
    });
  }

  const dialog = (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
    >
      {request ? (
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Sparkles className="size-5" aria-hidden="true" />
            </div>
            <DialogTitle>{request.title}</DialogTitle>
            <DialogDescription>Review the estimated cost before continuing.</DialogDescription>
          </DialogHeader>
          <dl className="rounded-xl border bg-muted/30 p-4 text-sm">
            <div className="flex items-center justify-between gap-4">
              <dt className="text-muted-foreground">Estimated cost</dt>
              <dd className="text-lg font-semibold">${request.estimateUsd.toFixed(4)}</dd>
            </div>
          </dl>
          {request.note ? (
            <p className="text-xs leading-relaxed text-muted-foreground">{request.note}</p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => settle(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={() => settle(true)}>
              {request.action}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );

  return [confirm, dialog];
}
