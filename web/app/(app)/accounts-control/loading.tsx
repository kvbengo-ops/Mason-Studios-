import type { JSX } from "react";
import { Skeleton } from "@/components/ui/skeleton";

export default function AccountsControlLoading(): JSX.Element {
  return (
    <main
      role="status"
      aria-label="Loading Accounts and Spending Control"
      className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-4 py-6 sm:gap-8 md:px-8 md:py-10"
    >
      <header className="flex flex-wrap items-end justify-between gap-5">
        <div className="flex max-w-2xl flex-1 flex-col gap-3">
          <Skeleton className="h-3 w-28" />
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Accounts and Spending Control
          </h1>
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <Skeleton className="h-10 w-40 rounded-xl" />
      </header>

      <section aria-hidden="true" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="rounded-2xl border border-border/70 bg-card p-5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-4 h-7 w-32" />
            <Skeleton className="mt-3 h-3 w-28" />
          </div>
        ))}
      </section>

      <div
        aria-hidden="true"
        className="flex flex-wrap items-center justify-between gap-4 border-b border-border/70 pb-4"
      >
        <div className="flex gap-1 rounded-xl border border-border/70 bg-muted/40 p-1">
          <Skeleton className="h-9 w-24 rounded-lg" />
          <Skeleton className="h-9 w-24 rounded-lg" />
          <Skeleton className="h-9 w-20 rounded-lg" />
        </div>
        <Skeleton className="h-9 w-48 rounded-lg" />
      </div>

      <section
        aria-hidden="true"
        className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]"
      >
        <div className="rounded-2xl border border-border/70 bg-card p-5 sm:p-6">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="mt-6 h-64 w-full rounded-lg sm:h-72" />
          <div className="mt-4 flex justify-between">
            {Array.from({ length: 7 }, (_, index) => (
              <Skeleton key={index} className="h-3 w-8" />
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-6">
          {[0, 1].map((panel) => (
            <div key={panel} className="rounded-2xl border border-border/70 bg-card p-5 sm:p-6">
              <Skeleton className="h-5 w-32" />
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="mt-5 flex items-center justify-between gap-4">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-4 w-16" />
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>
      <span className="sr-only">Loading…</span>
    </main>
  );
}
