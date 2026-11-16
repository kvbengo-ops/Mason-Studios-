import type { JSX } from "react";

/** The images attached to an allowance request, each opening full size in a new tab. */
export function RequestAttachments({ urls }: { urls: readonly string[] }): JSX.Element | null {
  if (urls.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2">
      {urls.map((url, index) => (
        <li key={url}>
          <a href={url} target="_blank" rel="noreferrer" className="block">
            {/* eslint-disable-next-line @next/next/no-img-element -- signed URL, not a static asset */}
            <img
              src={url}
              alt={`Attached image ${index + 1}`}
              className="h-24 w-24 rounded-md border border-border object-cover"
            />
          </a>
        </li>
      ))}
    </ul>
  );
}
