import type { JSX } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const COLUMN_WIDTHS = ["w-28", "w-16", "w-32", "w-14", "w-20", "w-24", "w-16"];

export default function AllowancesLoading(): JSX.Element {
  return (
    <main role="status" aria-label="Loading allowance requests" className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium text-foreground">Allowance requests</h1>
        <div aria-hidden="true" className="flex items-center gap-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-8 w-24 rounded-lg" />
        </div>
      </header>

      <section aria-hidden="true" className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 2 }, (_, index) => (
          <div key={index} className="rounded-xl border bg-card p-5">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="mt-5 h-8 w-28" />
            <Skeleton className="mt-3 h-3 w-4/5" />
          </div>
        ))}
      </section>

      <Skeleton aria-hidden="true" className="h-10 w-full rounded-lg" />

      <div aria-hidden="true">
        <Table>
          <TableHeader>
            <TableRow>
              {COLUMN_WIDTHS.map((width, index) => (
                <TableHead key={index}>
                  <Skeleton className={`h-3 ${width}`} />
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 5 }, (_, row) => (
              <TableRow key={row}>
                {COLUMN_WIDTHS.map((width, column) => (
                  <TableCell key={column}>
                    <Skeleton className={`h-4 ${width}`} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </main>
  );
}
