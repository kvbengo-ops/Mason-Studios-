import { afterEach, describe, expect, it, vi } from "vitest";
import { saveTitle, saveDirection } from "./settings";
import { requireProject } from "@/actions/guard";
import { createAdminClient } from "@/lib/supabase/server";
import { updateProject } from "@/actions/project";

vi.mock("@/actions/guard", () => ({
  requireProject: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(),
}));

vi.mock("@/actions/project", () => ({
  updateProject: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

function captureUpdate(): {
  client: { from: ReturnType<typeof vi.fn> };
  payloads: Record<string, unknown>[];
} {
  const payloads: Record<string, unknown>[] = [];
  const builder = {
    update: vi.fn((payload: Record<string, unknown>) => {
      payloads.push(payload);
      return builder;
    }),
    eq: vi.fn(() => Promise.resolve({ error: null })),
  };
  return { client: { from: vi.fn(() => builder) }, payloads };
}

function givenProject(project: Record<string, unknown>): void {
  vi.mocked(requireProject).mockResolvedValue({ project } as never);
}

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

afterEach(() => {
  vi.mocked(requireProject).mockReset();
  vi.mocked(createAdminClient).mockReset();
  vi.mocked(updateProject).mockReset();
});

describe("saveTitle", () => {
  it("delegates a validated title to updateProject", async () => {
    vi.mocked(updateProject).mockResolvedValue(undefined);

    await saveTitle("p1", form({ title: "  New Name  " }));

    expect(updateProject).toHaveBeenCalledWith("p1", { title: "New Name" });
  });

  it("refuses an empty title without ever calling updateProject", async () => {
    const result = await saveTitle("p1", form({ title: "   " }));

    expect(result).toHaveProperty("error");
    expect(updateProject).not.toHaveBeenCalled();
  });
});

describe("saveDirection", () => {
  it("writes the direction and caption columns, and nothing that belongs to another screen", async () => {
    givenProject({ status: "draft" });
    const { client, payloads } = captureUpdate();
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await saveDirection(
      "p1",
      form({
        shooting_mode: "static",
        camera_movement: "on",
        visual_idea: "static wide shot",
        voice_profile: "warm",
        pronunciation_guide: "",
        ugc_style: "auto",
        include_visual_idea: "on",
        caption_box_color: "#730BF9",
        caption_text_color: "#FFFFFF",
      }),
    );

    const payload = payloads[0]!;
    expect(payload.shooting_mode).toBe("static");
    expect(payload.visual_idea).toBe("static wide shot");
    expect(payload.caption_box_color).toBe("#730BF9");
    // Columns Character/Product/Script each own — a shared action wrote all
    // of these once (the removed saveCharacterSetup); this one must not.
    expect(payload).not.toHaveProperty("character_desc");
    expect(payload).not.toHaveProperty("product_name");
    expect(payload).not.toHaveProperty("product_appearance");
    expect(payload).not.toHaveProperty("script_raw");
    expect(payload).not.toHaveProperty("title");
  });

  it("refuses to write once the project is delivered", async () => {
    givenProject({ status: "delivered" });

    const result = await saveDirection("p1", form({ shooting_mode: "static" }));

    expect(result).toHaveProperty("error");
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
