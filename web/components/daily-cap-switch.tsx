"use client";

// The installation-wide "Enable daily cap" control on /users
// (actions/account.ts's setUserDailyCapEnabled, app_settings, 0077).
//
// The daily burst guard is a feature a team OPTS INTO. It ships off, because
// the editors asked not to be stopped mid-job by a ceiling that made them
// wait until tomorrow to finish work they were already inside their weekly
// allowance to do. This is where a team that decides it wants one turns it
// on — from the app, by an admin, rather than by editing render.yaml and
// waiting for a redeploy, which is what USER_DAILY_CAP_ENABLED required.
//
// ENABLING is one click; DISABLING confirms. That asymmetry is deliberate
// and matches reject-account-dialog.tsx beside it: turning a spend guard ON
// only ever refuses more, so a misclick costs an editor one refusal they can
// ask about. Turning it OFF removes a limit from every account at once and
// nothing on screen would say it had happened.

import { useState, useTransition } from "react";
import type { JSX } from "react";
import { unstable_rethrow } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PendingButton } from "@/components/pending-button";
import { setUserDailyCapEnabled } from "@/actions/account";

export function DailyCapSwitch({
  enabled,
  /** How many accounts follow the default — i.e. have no override of their own. */
  followingDefaultCount,
}: {
  enabled: boolean;
  followingDefaultCount: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function submit(next: boolean): void {
    setErrorMessage(null);
    startTransition(async () => {
      try {
        const result = await setUserDailyCapEnabled(next);
        if (result?.error) {
          setErrorMessage(result.error);
          return;
        }
        setOpen(false);
      } catch (error) {
        unstable_rethrow(error);
        setErrorMessage(
          error instanceof Error ? error.message : "Failed to change the daily cap setting.",
        );
      }
    });
  }

  if (!enabled) {
    return (
      <div className="flex flex-col gap-0.5">
        <PendingButton size="sm" variant="outline" onClick={() => submit(true)} pending={isPending}>
          Enable daily cap
        </PendingButton>
        {errorMessage ? <span className="text-xs text-destructive">{errorMessage}</span> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant="outline">
            Daily cap on — disable
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn the daily cap off?</DialogTitle>
            <DialogDescription>
              {followingDefaultCount === 1
                ? "One account follows this setting"
                : `${followingDefaultCount} accounts follow this setting`}{" "}
              and will lose their daily ceiling. Their weekly allowance and the team&apos;s daily
              cap still apply, so nobody can spend more overall — but one editor can spend a
              week&apos;s worth in an afternoon and then be stopped until Monday. Accounts set
              individually keep whatever was chosen for them.
            </DialogDescription>
          </DialogHeader>

          {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <PendingButton variant="destructive" onClick={() => submit(false)} pending={isPending}>
              Turn off
            </PendingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {errorMessage && !open ? (
        <span className="text-xs text-destructive">{errorMessage}</span>
      ) : null}
    </div>
  );
}
