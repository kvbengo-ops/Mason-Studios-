"use client";

import { useState } from "react";
import type { JSX, ReactNode } from "react";
import { unstable_rethrow } from "next/navigation";
import { toast } from "sonner";
import { saveGeneratedElement } from "@/actions/save-generated-element";
import { useAsyncAction } from "@/components/use-async-action";
import { Button } from "@/components/ui/button";
import { ElementTagNameField } from "@/components/element-tag-name-field";
import { Label } from "@/components/ui/label";
import { PendingButton } from "@/components/pending-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function SaveGeneratedElementButton({
  assetId,
  renderTrigger,
}: {
  assetId: string;
  renderTrigger?: (open: () => void) => ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [destination, setDestination] = useState("mine");
  const [error, setError] = useState<string | null>(null);
  const { pending, run } = useAsyncAction();
  return (
    <>
      {renderTrigger ? (
        renderTrigger(() => setOpen(true))
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          Save to elements
        </Button>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!pending) setOpen(value);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save to elements</DialogTitle>
            <DialogDescription>
              Name the tag and choose where to save it. Shared is visible to everyone; Mine stays in
              your library.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                setError(null);
                const formData = new FormData();
                formData.set("assetId", assetId);
                formData.set("name", name);
                formData.set("destination", destination);
                try {
                  const result = await saveGeneratedElement(formData);
                  if (result?.error) {
                    setError(result.error);
                    return;
                  }
                  if (result?.notice) toast(result.notice);
                  setOpen(false);
                } catch (error) {
                  unstable_rethrow(error);
                  setError("Could not save the element. Try again.");
                }
              });
            }}
          >
            <ElementTagNameField
              value={name}
              onChange={setName}
              shared={destination === "shared"}
              disabled={pending}
            />
            <div className="space-y-2">
              <Label htmlFor={`element-destination-${assetId}`}>Save to</Label>
              <select
                id={`element-destination-${assetId}`}
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
                disabled={pending}
                className="w-full rounded-md border bg-background p-2 text-sm text-foreground"
              >
                <option value="mine" className="bg-popover text-popover-foreground">
                  Mine
                </option>
                <option value="shared" className="bg-popover text-popover-foreground">
                  Shared
                </option>
              </select>
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <PendingButton type="submit" pending={pending}>
              Save element
            </PendingButton>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
