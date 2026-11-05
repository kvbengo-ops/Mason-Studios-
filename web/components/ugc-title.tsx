"use client";

// The project's name, edited where it is read.
//
// Every clip project is created as "New project" — no dialog, no field to
// fill in before you can start. That is the right trade at creation time:
// making someone name a thing before they have made it is a stop at the
// wrong moment, and the PDF this route was built from names itself on its
// first line, not before it exists.
//
// The cost of that trade is ten rows all called "New project", so renaming
// has to be reachable from here rather than only from Settings.
//
// CLICK THE TITLE, no pencil on hover. A hover-revealed control does not
// exist on touch, and misses keyboard users entirely unless it is also shown
// on :focus — which is the half everyone forgets. Since the common case is
// "this still needs a name", the title itself is the control. It can be,
// because on this page the title is a heading rather than a link; in the
// projects table it IS a link, and renaming there belongs in the Actions
// menu instead.
//
// The write is saveTitle -> updateProject, which already exists and already
// carries requireProject. A title feeds no prompt, no render and no cost, so
// it never locks — see settings-title-form.tsx for why that is its own
// action rather than part of a bundle that does lock.

import { useRef, useState, type JSX } from "react";
import { saveTitle } from "@/actions/settings";
import { useAsyncAction } from "@/components/use-async-action";
import { Spinner } from "@/components/spinner";
import { MAX_TITLE_LENGTH } from "@/lib/title-guard";
import { toast } from "sonner";

export function UgcTitle({
  projectId,
  title,
  readOnly = false,
}: {
  projectId: string;
  title: string;
  /**
   * True when the viewer is an admin looking at someone else's project.
   * renameProject refuses them server-side either way (it goes through
   * requireProject); this is what stops the page offering a control that
   * would only fail.
   */
  readOnly?: boolean;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  // useAsyncAction, not useTransition: a pending transition blocks <Link>
  // navigation, and this page's whole spine is links (the scene strip, the
  // version rail). See the hook's own doc comment.
  const { pending, run } = useAsyncAction();

  // Re-synced when the server sends a different title — a rename from the
  // Settings page, or another tab.
  const [syncedTo, setSyncedTo] = useState(title);
  if (title !== syncedTo) {
    setSyncedTo(title);
    if (!editing) setValue(title);
  }

  function commit(): void {
    const next = value.trim();
    setEditing(false);
    if (next === title) return;
    if (!next) {
      // Empty is a cancel, not a rename to nothing. updateProject would
      // refuse it anyway; refusing here means no toast for a slip.
      setValue(title);
      return;
    }
    run(async () => {
      try {
        // saveTitle takes FormData because every other caller is a <form>.
        // Built by hand here rather than changing its signature: it already
        // owns the title validation (requireTitle), and a second entry point
        // that skipped that is how two rules about the same field appear.
        const formData = new FormData();
        formData.set("title", next);
        const result = await saveTitle(projectId, formData);
        if (result?.error) {
          toast.error(result.error);
          setValue(title);
        }
      } catch {
        toast.error("Failed to rename the project.");
        setValue(title);
      }
    });
  }

  if (!editing) {
    // Plain text, no affordance: a dotted underline that says "rename me" is
    // a promise, and this viewer cannot keep it.
    if (readOnly) {
      return <h1 className="text-xl font-semibold tracking-tight">{title}</h1>;
    }

    return (
      <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
        <button
          type="button"
          onClick={() => {
            setEditing(true);
            // Focus after the input exists, and select the whole thing: the
            // default name is the one people replace rather than append to.
            requestAnimationFrame(() => inputRef.current?.select());
          }}
          className="rounded-sm decoration-dotted underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          title="Rename"
        >
          {title}
        </button>
        {pending ? <Spinner className="text-muted-foreground" /> : null}
      </h1>
    );
  }

  return (
    <h1 className="text-xl font-semibold tracking-tight">
      <label className="sr-only" htmlFor="ugc-title">
        Project name
      </label>
      <input
        id="ugc-title"
        ref={inputRef}
        value={value}
        maxLength={MAX_TITLE_LENGTH}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") {
            setValue(title);
            setEditing(false);
          }
        }}
        // Sized and styled as the heading it replaces, so committing does not
        // shift the page.
        className="w-full max-w-md rounded-sm border-b bg-transparent text-xl font-semibold tracking-tight outline-none focus:border-foreground"
      />
    </h1>
  );
}
