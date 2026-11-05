"use client";

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

// `required` is the one shared way this app tells an operator a field is
// mandatory — see docs on why: most fields across these forms are optional,
// so marking the few required ones is quieter than marking everything else,
// and "Required" as real text (not just an asterisk) doesn't assume the
// operator already knows the convention. It's plain text inside the
// <label>, so it's part of the accessible name for free — no separate
// aria-label to keep in sync, and nothing here depends on colour to read.
function Label({
  className,
  required,
  children,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root> & { required?: boolean }): React.JSX.Element {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
      {required ? (
        <span className="text-xs font-normal text-muted-foreground">(required)</span>
      ) : null}
    </LabelPrimitive.Root>
  );
}

export { Label };
