import Link from "next/link";
import type { JSX } from "react";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { PANEL } from "@/components/kpi-tile";
import { buildAttentionItems, type AttentionInput } from "@/lib/needs-attention";
import { cn } from "@/lib/utils";

/** Only things an admin can act on, each linking to where it is fixed. Shared by /users and /accounts-control. */
export function NeedsAttention({ input }: { input: AttentionInput }): JSX.Element {
  const items = buildAttentionItems(input);
  return (
    <section aria-labelledby="needs-attention-heading" className={cn(PANEL, "p-5 sm:p-6")}>
      <h2
        id="needs-attention-heading"
        className="flex items-center gap-2 text-sm font-semibold text-foreground"
      >
        <TriangleAlert
          aria-hidden="true"
          className={cn("size-4", items.length ? "text-destructive" : "text-muted-foreground")}
        />
        Needs attention
      </h2>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">Nothing needs attention.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border/70">
          {items.map((item) => (
            <li key={item.key}>
              <Link
                href={item.href}
                className="flex items-center justify-between gap-3 rounded-md py-2.5 text-sm text-foreground tabular-nums hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="min-w-0">{item.label}</span>
                <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
