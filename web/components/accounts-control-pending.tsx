"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useState, useTransition } from "react";
import type { ComponentProps, JSX, MouseEvent, ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Accounts Control navigates by query string on one route, so loading.tsx never
 * shows and the old view sits there until the new one arrives. A link names the
 * region it replaces; that region shows its skeleton while the navigation runs.
 */
type Region = "view" | "account" | "runs";

const PendingContext = createContext<{
  pending: Region | null;
  go: (href: string, region: Region) => void;
}>({ pending: null, go: () => undefined });

export function PendingNavProvider({ children }: { children: ReactNode }): JSX.Element {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [region, setRegion] = useState<Region | null>(null);
  function go(href: string, next: Region): void {
    setRegion(next);
    startTransition(() => router.push(href, { scroll: false }));
  }
  return (
    <PendingContext value={{ pending: isPending ? region : null, go }}>{children}</PendingContext>
  );
}

/** A Link that shows `region`'s skeleton until the new page lands. */
export function PendingLink({
  region,
  href,
  onClick,
  ...props
}: Omit<ComponentProps<typeof Link>, "href"> & { href: string; region: Region }): JSX.Element {
  const { go } = useContext(PendingContext);
  function handleClick(event: MouseEvent<HTMLAnchorElement>): void {
    onClick?.(event);
    // A new tab or window is the browser's business, not a pending swap.
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    go(href, region);
  }
  return <Link href={href} onClick={handleClick} {...props} />;
}

/** `children`, or `fallback` while a navigation into `region` is pending. */
export function PendingRegion({
  region,
  fallback,
  children,
}: {
  region: Region;
  fallback: ReactNode;
  children: ReactNode;
}): ReactNode {
  const { pending } = useContext(PendingContext);
  return pending === region ? fallback : children;
}

/** The Runs view's account filter: each choice is a URL, built on the server. */
export function RunsUserFilter({
  value,
  options,
}: {
  value: string;
  options: readonly { value: string; label: string; href: string }[];
}): JSX.Element {
  const { go } = useContext(PendingContext);
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const option = options.find((entry) => entry.value === next);
        if (option) go(option.href, "runs");
      }}
    >
      <SelectTrigger size="sm" aria-label="Filter runs by account" className="w-64 max-w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
