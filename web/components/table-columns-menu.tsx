"use client";

import { useId, useMemo, useState, useSyncExternalStore, type JSX, type ReactNode } from "react";
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

// Same-tab writes don't fire the `storage` event, so toggles notify directly.
const listeners = new Set<() => void>();
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}
function notify(): void {
  for (const listener of listeners) listener();
}
function readSaved(storageKey: string): string | null {
  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    return null; // Storage blocked: the defaults apply.
  }
}
function parseSaved(saved: string | null, columns: readonly ToggleableColumn[]): string[] | null {
  try {
    const parsed: unknown = saved ? JSON.parse(saved) : null;
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => columns.some((c) => c.id === id))
      : null;
  } catch {
    return null; // Corrupt: the defaults apply.
  }
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
  // The saved choice is read as an external store: null on the server and
  // during hydration (so both render the defaults), the stored string after.
  const saved = useSyncExternalStore(
    subscribe,
    () => readSaved(storageKey),
    () => null,
  );
  // This visit's choice, for when storage refuses the write.
  const [override, setOverride] = useState<readonly string[] | null>(null);
  const hidden = useMemo(
    () => override ?? parseSaved(saved, columns) ?? columns.filter((c) => c.defaultHidden).map((c) => c.id),
    [override, saved, columns],
  );

  const toggle = (id: string, visible: boolean): void => {
    const next = visible ? hidden.filter((h) => h !== id) : [...hidden, id];
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
      notify();
    } catch {
      // Not persisted; still applied for this visit.
      setOverride(next);
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
