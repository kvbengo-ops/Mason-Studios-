"use client";

import { useEffect, useState, useTransition } from "react";
import type { JSX } from "react";
import { useRouter } from "next/navigation";
import { unstable_rethrow } from "next/navigation";
import { toast } from "sonner";
import { purgeBinEntries } from "@/actions/bin-bulk";
import { Button } from "@/components/ui/button";
import { PendingButton } from "@/components/pending-button";
import { MAX_BULK_PURGE } from "@/lib/bin-bulk-limit";

/** The id the per-card checkboxes point their `form` attribute at. */
export const BIN_BULK_FORM_ID = "bin-bulk";

function boxes(): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(
      `input[type="checkbox"][form="${BIN_BULK_FORM_ID}"]`,
    ),
  );
}

/**
 * Admin-only toolbar for /bin: counts the ticked cards, selects all shown, and
 * permanently deletes the selection after one confirm. The checkboxes live in
 * each card and join this form through their `form` attribute, since the cards
 * already hold their own forms and forms cannot nest.
 */
export function BinBulkBar({ shown }: { shown: number }): JSX.Element | null {
  const router = useRouter();
  const [count, setCount] = useState(0);
  const [pending, start] = useTransition();

  useEffect(() => {
    const recount = (): void => setCount(boxes().filter((box) => box.checked).length);
    recount();
    document.addEventListener("change", recount);
    return () => document.removeEventListener("change", recount);
  }, [shown]);

  if (shown === 0) return null;

  const setAll = (checked: boolean): void => {
    for (const box of boxes()) box.checked = checked;
    setCount(checked ? boxes().length : 0);
  };

  function submit(form: HTMLFormElement): void {
    if (
      !window.confirm(
        `Permanently delete ${count} ${count === 1 ? "entry" : "entries"}? Their files are removed from storage for good and can no longer be restored.`,
      )
    ) {
      return;
    }
    const data = new FormData(form);
    // Versions first, the order purgeBinEntries itself uses, then scenes —
    // cut into calls of at most MAX_BULK_PURGE so any selection goes through.
    const entries = [
      ...data.getAll("version").map((id) => ["version", String(id)] as const),
      ...data.getAll("scene").map((id) => ["scene", String(id)] as const),
    ];
    start(async () => {
      try {
        const notices: string[] = [];
        for (let i = 0; i < entries.length; i += MAX_BULK_PURGE) {
          const batch = new FormData();
          for (const [field, id] of entries.slice(i, i + MAX_BULK_PURGE)) batch.append(field, id);
          const result = await purgeBinEntries(batch);
          if (result && "error" in result && result.error) toast.error(result.error);
          else if (result && "notice" in result && result.notice) notices.push(result.notice);
        }
        if (notices.length > 0) toast(notices.join(" "), { duration: 8000 });
        setAll(false);
        router.refresh();
      } catch (error) {
        unstable_rethrow(error);
        toast.error("Could not delete the selected entries. Try again.");
      }
    });
  }

  return (
    <form
      id={BIN_BULK_FORM_ID}
      onSubmit={(event) => {
        event.preventDefault();
        submit(event.currentTarget);
      }}
      className="sticky top-0 z-20 flex flex-wrap items-center gap-2 rounded-lg border bg-card/95 px-3 py-2 backdrop-blur"
    >
      <span className="text-sm font-medium tabular-nums" aria-live="polite">
        {count} selected
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => setAll(true)}
      >
        Select all shown ({shown})
      </Button>
      {count > 0 ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => setAll(false)}
        >
          Clear
        </Button>
      ) : null}
      <span className="flex-1" />
      <PendingButton
        type="submit"
        variant="outline"
        size="sm"
        pending={pending}
        disabled={count === 0}
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        {`Delete ${count} permanently`}
      </PendingButton>
    </form>
  );
}
