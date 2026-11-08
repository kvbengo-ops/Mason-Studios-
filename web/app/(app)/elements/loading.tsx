import type { JSX } from "react";
import { Skeleton } from "@/components/ui/skeleton";

export default function ElementsLoading(): JSX.Element {
  return (
    <main
      role="status"
      aria-label="Loading Elements Library"
      className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8"
    >
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Elements Library</h1>
        <div aria-hidden="true" className="flex flex-col gap-2">
          <Skeleton className="h-4 w-full max-w-2xl" />
          <Skeleton className="h-4 w-3/4 max-w-xl" />
        </div>
      </header>

      <Skeleton aria-hidden="true" className="h-10 w-44 rounded-lg" />
      <div aria-hidden="true" className="flex flex-col gap-2">
        <Skeleton className="h-3 w-full max-w-3xl" />
        <Skeleton className="h-3 w-4/5 max-w-2xl" />
      </div>

      <div aria-hidden="true" className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-8 w-full rounded-lg sm:w-56" />
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-8 w-16 rounded-lg" />
        ))}
      </div>

      <section aria-hidden="true" className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="flex min-w-0 flex-col rounded-xl border bg-card shadow-sm">
            <Skeleton className="aspect-[4/3] w-full rounded-t-xl" />
            <div className="flex flex-col gap-3 p-3.5">
              <div className="flex items-center justify-between gap-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-5 w-14 rounded-full" />
              </div>
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-5/6" />
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}
