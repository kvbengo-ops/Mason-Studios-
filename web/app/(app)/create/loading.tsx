import type { JSX } from "react";
import { CreateModeSkeleton } from "@/components/create-mode-switch";

export default function Loading(): JSX.Element {
  return (
    <div data-create-page className="flex min-h-full w-full flex-col px-4 md:px-6">
      <header className="flex flex-wrap items-start justify-between gap-4 px-0 pb-4 pt-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold tracking-tight">Create</h1>
          <p className="text-sm text-muted-foreground">
            Everything you generate lands here, newest first.
          </p>
        </div>
      </header>
      <CreateModeSkeleton video={false} />
    </div>
  );
}
