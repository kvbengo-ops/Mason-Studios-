// @vitest-environment jsdom
//
// Gate 1's Character card, which is the last thing an operator reads before
// approving a brief and letting render money start.
//
// It used to show the reference photo ONLY when there was no typed
// description — so the normal project (describe the character, then generate
// a photo from that description) showed one line of text and nothing else.
// "an athletic woman" was the entire card. The face is the thing that has to
// stay consistent across every clip, and it was the one thing this gate
// could not show.
//
// Rendering the page function directly (it is an async Server Component, so
// it returns an element to render) rather than testing a extracted helper:
// the defect was in the CONDITION around the query, and a helper would have
// been extracted with the same condition already decided.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import BriefPage from "./page";

const project = {
  id: "p1",
  title: "Kinoko Coffee",
  character_desc: "an athletic woman",
  character_desc_edited_at: null as string | null,
  render_settings: null,
  status: "draft",
};

const requireProjectReadable = vi.fn();
vi.mock("@/actions/guard", () => ({
  requireProjectReadable: (id: string) => requireProjectReadable(id),
}));
vi.mock("@/actions/brief", () => ({
  approveBrief: vi.fn(),
  updateScenePrompt: vi.fn(),
  applyScenePrompt: vi.fn(),
  splitScene: vi.fn(),
  unfreezeScene: vi.fn(),
  addScene: vi.fn(),
  deleteScene: vi.fn(),
  setSceneRoll: vi.fn(),
  setSceneDuration: vi.fn(),
  reorderScenes: vi.fn(),
}));
vi.mock("@/lib/db-aggregates", () => ({
  getProjectSpend: vi.fn(async () => ({ totalUsd: 0, bySceneId: {} })),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/p1/brief",
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  redirect: vi.fn(),
}));

const signedUrl = vi.fn(async () => "https://signed.example/character.png");
vi.mock("@/lib/storage", () => ({ signedUrl: () => signedUrl() }));

/** The character_ref row this project has, or null for a project with none. */
let characterAssetRow: { storage_key: string; created_at: string } | null = null;
let sceneRows: unknown[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from(table: string) {
      if (table === "assets") {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({ data: characterAssetRow, error: null }),
        };
        return chain;
      }
      const scenesChain = {
        select: () => scenesChain,
        eq: () => scenesChain,
        order: async () => ({ data: sceneRows, error: null }),
      };
      return scenesChain;
    },
  }),
}));

beforeEach(() => {
  characterAssetRow = {
    storage_key: "projects/p1/character_ref.png",
    created_at: "2026-08-01T00:00:00Z",
  };
  sceneRows = [];
  project.character_desc = "an athletic woman";
  project.character_desc_edited_at = null;
  requireProjectReadable.mockResolvedValue({ project, isOwner: true });
  signedUrl.mockClear();
});

afterEach(cleanup);

async function renderPage(): Promise<void> {
  render(await BriefPage({ params: Promise.resolve({ id: "p1" }) }));
}

describe("Gate 1 — the Character card", () => {
  it("shows the reference photo AND the description, not one or the other", async () => {
    await renderPage();

    expect(screen.getByText("an athletic woman")).toBeTruthy();
    const img = screen.getByAltText("Character reference") as HTMLImageElement;
    expect(img.src).toContain("signed.example");
  });

  it("still shows the photo for a project whose reference came from an upload with no description", async () => {
    project.character_desc = null as unknown as string;
    await renderPage();

    expect(screen.getByAltText("Character reference")).toBeTruthy();
    expect(screen.getByText(/uploaded photo \(no typed description\)/i)).toBeTruthy();
  });

  it("says nothing is set only when there is genuinely neither", async () => {
    project.character_desc = null as unknown as string;
    characterAssetRow = null;
    await renderPage();

    expect(screen.getByText("No character description set.")).toBeTruthy();
    expect(screen.queryByAltText("Character reference")).toBeNull();
  });

  it("warns when the description was edited after the photo was made", async () => {
    project.character_desc_edited_at = "2026-08-02T00:00:00Z";
    await renderPage();

    expect(screen.getByText(/generated before the description was last edited/i)).toBeTruthy();
  });

  it("stays quiet when the photo is newer than the last description edit", async () => {
    project.character_desc_edited_at = "2026-07-01T00:00:00Z";
    await renderPage();

    expect(screen.queryByText(/generated before the description was last edited/i)).toBeNull();
  });
});
