import Link from "next/link";
import { notFound } from "next/navigation";
import type { JSX } from "react";
import { requireAdmin } from "@/actions/guard";
import {
  AdminCreationsGrid,
  type AdminCreationsTab,
} from "@/components/admin-creations-grid";
import { RoleBadge } from "@/components/role-badge";
import { Badge } from "@/components/ui/badge";
import { requiresAccountApproval } from "@/lib/account-approval";
import {
  loadEditorDeleted,
  loadEditorImageRuns,
  loadEditorImages,
  loadEditorVideos,
} from "@/lib/admin-creations";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import type { ProfileRole } from "@/types/db";

interface EditorProfileRow {
  id: string;
  email: string;
  username: string;
  role: ProfileRole;
}

function parseTab(raw: string | string[] | undefined): AdminCreationsTab {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === "videos" || value === "deleted") return value;
  return "images";
}

function tabHref(userId: string, tab: AdminCreationsTab): string {
  return tab === "images"
    ? `/users/${userId}/creations`
    : `/users/${userId}/creations?tab=${tab}`;
}

const TABS: readonly { id: AdminCreationsTab; label: string }[] = [
  { id: "images", label: "Images" },
  { id: "videos", label: "Videos" },
  { id: "deleted", label: "Deleted" },
];

export default async function AdminUserCreationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}): Promise<JSX.Element> {
  await requireAdmin();

  const [{ id }, resolvedSearchParams] = await Promise.all([params, searchParams]);
  const tab = parseTab(resolvedSearchParams.tab);

  const supabase = await createClient();
  const { data: profileData, error: profileError } = await supabase
    .from("profiles")
    .select("id, email, username, role")
    .eq("id", id)
    .maybeSingle();

  if (profileError) {
    throw new Error(`Failed to load editor profile: ${profileError.message}`);
  }

  const editor = profileData as EditorProfileRow | null;
  if (!editor || !requiresAccountApproval(editor.role)) {
    notFound();
  }

  let grid: JSX.Element;
  if (tab === "images") {
    const [imagePage, imageRuns] = await Promise.all([
      loadEditorImages(editor.id, null),
      loadEditorImageRuns(editor.id),
    ]);
    grid = <AdminCreationsGrid tab="images" images={imagePage.images} imageRuns={imageRuns} />;
  } else if (tab === "videos") {
    const { clips, runs } = await loadEditorVideos(editor.id);
    grid = <AdminCreationsGrid tab="videos" clips={clips} videoRuns={runs} />;
  } else {
    const deleted = await loadEditorDeleted(editor.id);
    grid = <AdminCreationsGrid tab="deleted" deleted={deleted} />;
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/users"
              className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Users
            </Link>
            <span className="text-sm text-muted-foreground">/</span>
            <h1 className="text-2xl font-medium text-foreground">{editor.username}</h1>
            <RoleBadge role={editor.role} />
            <Badge variant="secondary">Read-only</Badge>
          </div>
          <p className="text-sm text-muted-foreground">{editor.email}</p>
        </div>

        <nav
          aria-label="Creation categories"
          className="flex shrink-0 gap-1 rounded-xl border border-border bg-muted/40 p-1"
        >
          {TABS.map((entry) => {
            const active = tab === entry.id;
            return (
              <Link
                key={entry.id}
                href={tabHref(editor.id, entry.id)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-9 items-center rounded-lg px-4 text-sm font-medium transition-colors",
                  active
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {entry.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {grid}
    </div>
  );
}
