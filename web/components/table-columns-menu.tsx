"use client";

import { useEffect, useId, useState, type JSX, type ReactNode } from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, Columns3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export interface ToggleableColumn {
  /** Matches `data-col` on that column's <th> and <td>s. */
  id: string;
  label: string;
  defaultHidden?: boolean;
}

/**
 * A "Columns" menu over server-rendered table children. Hiding is a <style>
 * scoped to this wrapper, so the server render already hides the default
 * columns (no flash) and the table stays a Server Component. The choice is
 * kept per browser in localStorage.
 */
export function TableColumnsMenu({
  storageKey,
  columns,
  children,
}: {
  storageKey: string;
  columns: readonly ToggleableColumn[];
  children: ReactNode;
}): JSX.Element {
  const scope = `cols-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [hidden, setHidden] = useState<readonly string[]>(() =>
    columns.filter((c) => c.defaultHidden).map((c) => c.id),
  );

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      const parsed: unknown = saved ? JSON.parse(saved) : null;
      if (Array.isArray(parsed)) {
        setHidden(parsed.filter((id): id is string => columns.some((c) => c.id === id)));
      }
    } catch {
      // Storage blocked or corrupt: keep the defaults.
    }
  }, [storageKey, columns]);

  const toggle = (id: string, visible: boolean): void => {
    const next = visible ? hidden.filter((h) => h !== id) : [...hidden, id];
    setHidden(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Not persisted; still applied for this visit.
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Columns3 aria-hidden="true" className="size-4" />
              Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {columns.map((column) => {
              const visible = !hidden.includes(column.id);
              return (
                <DropdownMenuPrimitive.CheckboxItem
                  key={column.id}
                  checked={visible}
                  onCheckedChange={(checked) => toggle(column.id, checked === true)}
                  onSelect={(e) => e.preventDefault()}
                  className="relative flex cursor-default select-none items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-none focus:bg-accent focus:text-accent-foreground"
                >
                  <span className="absolute left-2 flex size-4 items-center justify-center">
                    <DropdownMenuPrimitive.ItemIndicator>
                      <Check aria-hidden="true" className="size-4" />
                    </DropdownMenuPrimitive.ItemIndicator>
                  </span>
                  {column.label}
                </DropdownMenuPrimitive.CheckboxItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {hidden.length > 0 ? (
        <style>
          {hidden.map((id) => `#${scope} [data-col="${id}"]{display:none}`).join("")}
        </style>
      ) : null}
      <div id={scope} className="min-w-0">
        {children}
      </div>
    </div>
  );
}
