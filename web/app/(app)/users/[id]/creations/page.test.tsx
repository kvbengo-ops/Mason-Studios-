// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import AdminUserCreationsPage from "./page";
import { createClient } from "@/lib/supabase/server";
import {
  loadEditorDeleted,
  loadEditorImageRuns,
  loadEditorImages,
} from "@/lib/admin-creations";
import type { ProfileRole } from "@/types/db";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/admin-creations", () => ({
  loadEditorImages: vi.fn(),
  loadEditorImageRuns: vi.fn(),
  loadEditorVideos: vi.fn(),
  loadEditorDeleted: vi.fn(),
}));

class FakeNotFoundError extends Error {
  digest = "NEXT_NOT_FOUND";
}

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new FakeNotFoundError("NEXT_NOT_FOUND");
  }),
}));

interface FakeProfile {
  id: string;
  email: string;
  username: string;
  role: ProfileRole;
  status: "active" | "pending" | "rejected" | "deactivated";
}

function fakeSupabaseForPage(caller: FakeProfile, target: FakeProfile | null) {
  const byId = new Map<string, FakeProfile>();
  byId.set(caller.id, caller);
  if (target) byId.set(target.id, target);

  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: caller.id, email: caller.email } },
      })),
    },
    from: vi.fn((table: string) => {
      if (table !== "profiles") {
        throw new Error(`Unexpected table "${table}" in page test`);
      }
      let queriedId = "";
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn((col: string, val: string) => {
          if (col === "id") queriedId = val;
          return builder;
        }),
        single: vi.fn(async () => {
          const row = byId.get(queriedId) ?? null;
          return { data: row, error: row ? null : { message: "not found" } };
        }),
        maybeSingle: vi.fn(async () => {
          const row = byId.get(queriedId) ?? null;
          return { data: row, error: null };
        }),
      };
      return builder;
    }),
  };
}

const ADMIN_CALLER: FakeProfile = {
  id: "admin-1",
  email: "admin@example.com",
  username: "admin_user",
  role: "admin",
  status: "active",
};

const EDITOR_TARGET: FakeProfile = {
  id: "editor-1",
  email: "editor@example.com",
  username: "maya_editor",
  role: "editor",
  status: "active",
};

const TRUSTED_CALLER: FakeProfile = {
  id: "trusted-1",
  email: "trusted@example.com",
  username: "trusted_user",
  role: "trusted_editor",
  status: "active",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AdminUserCreationsPage", () => {
  it("refuses a plain editor caller via requireAdmin", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabaseForPage(EDITOR_TARGET, EDITOR_TARGET) as never,
    );

    await expect(
      AdminUserCreationsPage({
        params: Promise.resolve({ id: EDITOR_TARGET.id }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow(/not an admin/i);
  });

  it("refuses a trusted_editor caller via requireAdmin", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabaseForPage(TRUSTED_CALLER, EDITOR_TARGET) as never,
    );

    await expect(
      AdminUserCreationsPage({
        params: Promise.resolve({ id: EDITOR_TARGET.id }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow(/not an admin/i);
  });

  it("calls notFound() when the target account is an admin rather than an editor tier", async () => {
    const otherAdmin: FakeProfile = {
      id: "admin-2",
      email: "admin2@example.com",
      username: "second_admin",
      role: "admin",
      status: "active",
    };
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabaseForPage(ADMIN_CALLER, otherAdmin) as never,
    );

    await expect(
      AdminUserCreationsPage({
        params: Promise.resolve({ id: otherAdmin.id }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow(FakeNotFoundError);
  });

  it("renders the editor's header, Read-only badge, and images tab for an admin", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabaseForPage(ADMIN_CALLER, EDITOR_TARGET) as never,
    );
    vi.mocked(loadEditorImages).mockResolvedValue({
      images: [
        {
          assetId: "img-1",
          createdAt: "2026-10-30T10:00:00Z",
          url: "https://signed.example/img-1.png",
          prompt: "Golden hour bottle",
          modelLabel: "Nano Banana",
          costUsd: 0.04,
        },
      ],
      nextCursor: null,
    });
    vi.mocked(loadEditorImageRuns).mockResolvedValue([]);

    const element = await AdminUserCreationsPage({
      params: Promise.resolve({ id: EDITOR_TARGET.id }),
      searchParams: Promise.resolve({}),
    });
    render(element);

    expect(screen.getByText("maya_editor")).toBeTruthy();
    expect(screen.getByText("editor@example.com")).toBeTruthy();
    expect(screen.getByText("Read-only")).toBeTruthy();
    expect(screen.getByText("Golden hour bottle")).toBeTruthy();
    expect(loadEditorImages).toHaveBeenCalledWith(EDITOR_TARGET.id, null);
    expect(loadEditorImageRuns).toHaveBeenCalledWith(EDITOR_TARGET.id);
    expect(
      screen.queryByRole("button", {
        name: /delete|restore|iterate|reuse|generate|download/i,
      }),
    ).toBeNull();
  });

  it("loads deleted scenes, takes, and binned images when ?tab=deleted", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabaseForPage(ADMIN_CALLER, EDITOR_TARGET) as never,
    );
    vi.mocked(loadEditorDeleted).mockResolvedValue({
      scenes: [
        {
          sceneId: "scene-1",
          projectId: "proj-1",
          idx: 1,
          prompt: "Deleted scene prompt",
          modelLabel: "Seedance 2.5",
          deletedAt: "2026-10-30T12:00:00Z",
          purged: true,
          versionCount: 1,
          thumbnail: { kind: "placeholder" },
        },
      ],
      versions: [
        {
          versionId: "ver-1",
          sceneId: "scene-1",
          projectId: "proj-1",
          n: 2,
          prompt: "Deleted take prompt",
          modelLabel: "Seedance 2.5",
          deletedAt: "2026-10-30T12:10:00Z",
          purged: false,
          thumbnail: { kind: "placeholder" },
        },
      ],
      images: [
        {
          assetId: "img-bin-1",
          createdAt: "2026-10-30T09:00:00Z",
          deletedAt: "2026-10-30T12:20:00Z",
          prompt: "Binned image prompt",
          modelLabel: "Nano Banana",
          costUsd: 0.04,
          thumbnail: { kind: "image", url: "https://signed.example/binned.png" },
        },
      ],
    });

    const element = await AdminUserCreationsPage({
      params: Promise.resolve({ id: EDITOR_TARGET.id }),
      searchParams: Promise.resolve({ tab: "deleted" }),
    });
    render(element);

    expect(loadEditorDeleted).toHaveBeenCalledWith(EDITOR_TARGET.id);
    expect(screen.getByText("Deleted scene prompt")).toBeTruthy();
    expect(screen.getByText("Deleted take prompt")).toBeTruthy();
    expect(screen.getByText("Binned image prompt")).toBeTruthy();
    expect(screen.getByText("Purged")).toBeTruthy();
  });
});
