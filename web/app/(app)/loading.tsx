import type { JSX } from "react";
import { Loader2 } from "lucide-react";

// Shared fallback for navigation between authenticated pages. The app shell
// stays visible while only the page content waits for its Server Component.
export default function Loading(): JSX.Element {
  return (
    <div
      className="flex min-h-[calc(100svh-4rem)] items-center justify-center p-6 text-primary"
      role="status"
      aria-live="polite"
      aria-label="Loading page"
    >
      <Loader2 className="size-6 animate-spin" aria-hidden="true" />
    </div>
  );
}
