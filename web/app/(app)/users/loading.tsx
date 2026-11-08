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

const COLUMN_WIDTHS = [
  "w-28",
  "w-24",
  "w-14",
  "w-14",
  "w-16",
  "w-8",
  "w-16",
  "w-14",
  "w-14",
  "w-14",
  "w-16",
];

export default function UsersLoading(): JSX.Element {
  return (
    <main role="status" aria-label="Loading users" className="flex flex-col gap-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-medium text-foreground">Users</h1>
          <div aria-hidden="true" className="flex items-center gap-4">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-8 w-24 rounded-lg" />
          </div>
        </div>
        <Skeleton aria-hidden="true" className="h-9 w-40 rounded-lg" />
      </header>

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
            {Array.from({ length: 6 }, (_, row) => (
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
