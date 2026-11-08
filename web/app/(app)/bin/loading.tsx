import type { JSX } from "react";
import { Skeleton } from "@/components/ui/skeleton";

function BinCardSkeleton(): JSX.Element {
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-3">
      <Skeleton className="aspect-[9/16] w-full rounded-md" />
      <Skeleton className="h-5 w-12" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-3 w-2/3" />
      <div className="flex gap-2">
        <Skeleton className="h-8 w-20 rounded-lg" />
        <Skeleton className="h-8 w-24 rounded-lg" />
      </div>
    </div>
  );
}

export default function BinLoading(): JSX.Element {
  return (
    <main
      role="status"
      aria-label="Loading Bin"
      className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8"
    >
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Bin</h1>
        <div aria-hidden="true" className="flex flex-col gap-2">
          <Skeleton className="h-4 w-full max-w-2xl" />
          <Skeleton className="h-4 w-3/4 max-w-xl" />
        </div>
      </header>

      <section aria-hidden="true" className="flex flex-col gap-3">
        <Skeleton className="h-6 w-40" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <BinCardSkeleton key={index} />
          ))}
        </div>
      </section>

      <section aria-hidden="true" className="flex flex-col gap-3 rounded-lg border bg-card p-3">
        <Skeleton className="h-9 w-full rounded-t-md" />
        <Skeleton className="h-4 w-16" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <BinCardSkeleton key={index} />
          ))}
        </div>
      </section>
    </main>
  );
}
