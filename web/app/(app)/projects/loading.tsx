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

const COLUMN_WIDTHS = ["w-24", "w-16", "w-16", "w-12", "w-12"];

export default function StudioLoading(): JSX.Element {
  return (
    <main role="status" aria-label="Loading Studio" className="flex flex-col gap-6 p-6">
      <header className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-medium text-foreground">Studio</h1>
          <Skeleton aria-hidden="true" className="h-4 w-20" />
        </div>
        <Skeleton aria-hidden="true" className="h-9 w-32 rounded-lg" />
      </header>

      <div aria-hidden="true" className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-10 w-full max-w-md rounded-lg" />
        <Skeleton className="h-9 w-32 rounded-lg" />
      </div>

      <div aria-hidden="true">
        <Table className="table-fixed">
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
            {Array.from({ length: 6 }, (_, row) => (
              <TableRow key={row}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <Skeleton className="size-12 shrink-0 rounded-md" />
                    <Skeleton className="h-4 w-32" />
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-2">
                    <Skeleton className="h-1.5 w-14 rounded-full" />
                    <Skeleton className="h-3 w-8" />
                  </div>
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-20" />
                </TableCell>
                <TableCell numeric>
                  <Skeleton className="ml-auto h-4 w-12" />
                </TableCell>
                <TableCell>
                  <Skeleton className="ml-auto h-8 w-8 rounded-md" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <footer
        aria-hidden="true"
        className="flex flex-col gap-4 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <Skeleton className="h-8 w-24 rounded-lg" />
        <Skeleton className="h-9 w-40 rounded-lg" />
      </footer>
    </main>
  );
}
