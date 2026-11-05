"use client";

// The projects table's per-row "…" menu (app/(app)/projects/page.tsx via
// components/projects-table.tsx), replacing what used to be two inline
// buttons (Duplicate, Delete) in the last cell. Splitting this out of
// ProjectsTable keeps each row's open/pending state (the dropdown, the
// delete confirmation, the in-flight duplicate) scoped to that one row
// instead of one big Map keyed by project id living in the table.
import { useState, useTransition } from "react";
import { Spinner } from "@/components/spinner";
import type { JSX } from "react";
import { Download, MoreHorizontal } from "lucide-react";
import { unstable_rethrow } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DeleteProjectDialog } from "@/components/delete-project-dialog";
import { RenameProjectDialog } from "@/components/rename-project-dialog";
import { duplicateProject } from "@/actions/project";

export function ProjectRowActions({
  projectId,
  projectTitle,
  canDelete,
}: {
  projectId: string;
  projectTitle: string;
  /** Write policies are owner-only on every table (0002_rls.sql) — an admin
   * can read every project (projects_select) but cannot delete OR rename
   * rows they don't own; deleteProject's and renameProject's shared
   * requireProject check would 404 on anyone else's row. The caller
   * (ProjectsTable) computes this the same way the old inline-button
   * version did (`project.user_id === user.id`); when false, the Rename and
   * Delete items are both left out of the menu entirely rather than
   * rendered disabled — a disabled item still names an action the viewer
   * cannot take, and (per this same table's checkbox column) offering a
   * control that implies a permission the viewer doesn't have is exactly
   * what this page avoids. Duplicate has no such restriction: it reads the
   * source project through the RLS-respecting client (which lets an admin
   * read any project) and always writes the copy under the CURRENT user's
   * id (see duplicateProject's own doc comment in actions/project.ts) — so
   * it's offered unconditionally. */
  canDelete: boolean;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleDuplicate(): void {
    startTransition(async () => {
      try {
        // Same shape as DeleteProjectDialog's handleDelete: duplicateProject
        // always either throws (a real failure) or redirect()s to the new
        // project on success — it never returns an ActionResult — so a
        // thrown, non-redirect error is the only thing left to catch and
        // toast here.
        await duplicateProject(projectId);
      } catch (error) {
        unstable_rethrow(error);
        toast.error(error instanceof Error ? error.message : "Failed to duplicate project.");
      }
    });
  }

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          {/* aria-label, not just the icon: MoreHorizontal alone has no
              accessible name, and "Actions for X" (rather than a bare
              "Actions") is what lets a screen-reader user tell which row's
              menu they're about to open without first navigating to the
              row's title cell. */}
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={`Actions for ${projectTitle}`}
            disabled={isPending}
          >
            <MoreHorizontal aria-hidden className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canDelete ? (
            <DropdownMenuItem
              disabled={isPending}
              onSelect={(event) => {
                // Same reason Delete below preventDefaults: keep the menu's
                // own close animation from fighting RenameProjectDialog
                // opening (it's rendered as a sibling of this menu, not
                // nested in it — see that component's own header comment
                // for why nesting would tear it down before it ever opened).
                event.preventDefault();
                setRenameOpen(true);
              }}
            >
              Rename
            </DropdownMenuItem>
          ) : null}
          {canDelete ? (
            <DropdownMenuItem asChild>
              <a href={`/api/projects/${projectId}/archive?scope=project`}>
                <Download aria-hidden="true" className="size-4" />
                Download project ZIP
              </a>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            disabled={isPending}
            onSelect={(event) => {
              // Radix closes the menu on select by default, which is fine
              // here (there's no follow-up UI Duplicate needs the menu open
              // for) — preventDefault only stops Radix's own focus-return
              // side effect from racing the redirect this action performs
              // on success.
              event.preventDefault();
              handleDuplicate();
            }}
          >
            {/* A menu item is not a Button, so PendingButton can't be used
                here — but the in-flight treatment has to be the same ring
                every other control in the app draws, never a swapped
                label. Duplicate copies every scene row, so it is not
                instant. */}
            {isPending ? <Spinner /> : null}
            Duplicate
          </DropdownMenuItem>
          {canDelete ? (
            <DropdownMenuItem
              variant="destructive"
              onSelect={(event) => {
                // Keep the menu's own close animation from fighting the
                // dialog opening — same reasoning account-menu.tsx's request/
                // cancel-allowance items use for their own onSelect.
                event.preventDefault();
                setDeleteOpen(true);
              }}
            >
              Delete
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Both rendered as a SIBLING of DropdownMenu, not nested inside its
          Content — see DeleteProjectDialog's own header comment for why
          nesting either would have Radix tear it down before it ever
          opened. Only mounted when canDelete, matching the menu items
          above: there is no `renameOpen`/`deleteOpen` to ever flip true for
          a row this viewer isn't allowed to rename or delete. */}
      {canDelete ? (
        <RenameProjectDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          projectId={projectId}
          projectTitle={projectTitle}
        />
      ) : null}
      {canDelete ? (
        <DeleteProjectDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          projectId={projectId}
          projectTitle={projectTitle}
        />
      ) : null}
    </>
  );
}
