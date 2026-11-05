import { afterEach, describe, expect, it, vi } from "vitest";
import { saveCharacter, saveProduct, saveScript } from "./setup";
import { requireProject } from "@/actions/guard";
import { createAdminClient } from "@/lib/supabase/server";

// The property these three actions exist to have, and the one a single
// saveCharacterSetup could not: each writes ONLY its own columns. So every
// test here asserts on the exact update payload, not merely that a write
// happened — "it saved" would pass just as well against an action that also
// blanked the script.
vi.mock("@/actions/guard", () => ({
  requireProject: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

/** Captures the object handed to .update() so a test can inspect the payload. */
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
});

describe("saveCharacter", () => {
  it("writes the description and nothing that belongs to another screen", async () => {
    givenProject({ status: "draft", character_desc: "old" });
    const { client, payloads } = captureUpdate();
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await saveCharacter("p1", form({ description: "  a fuller description  " }));

    const payload = payloads[0]!;
    expect(payload.character_desc).toBe("a fuller description");
    // The columns this action must never touch. A single shared action wrote
    // all of these on every save, which is exactly why splitting the page
    // without splitting the action would have wiped them.
    expect(payload).not.toHaveProperty("script_raw");
    expect(payload).not.toHaveProperty("product_name");
    expect(payload).not.toHaveProperty("product_appearance");
    expect(payload).not.toHaveProperty("title");
  });

  it("clears the library label and stamps the edit only when the value really changed", async () => {
    givenProject({ status: "draft", character_desc: "old" });
    const { client, payloads } = captureUpdate();
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await saveCharacter("p1", form({ description: "new" }));

    expect(payloads[0]!.source_character_id).toBeNull();
    expect(payloads[0]!.character_desc_edited_at).toBeTruthy();
  });

  it("leaves an accurate library label alone when the text is re-saved unchanged", async () => {
    givenProject({ status: "draft", character_desc: "same" });
    const { client, payloads } = captureUpdate();
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await saveCharacter("p1", form({ description: "same" }));

    // Not "is null" — absent. Writing null would blank real provenance, and
    // stamping edited_at would raise a staleness warning against a portrait
    // that still matches its description.
    expect(payloads[0]!).not.toHaveProperty("source_character_id");
    expect(payloads[0]!).not.toHaveProperty("character_desc_edited_at");
  });

  it("stores an emptied description as null, not an empty string", async () => {
    givenProject({ status: "draft", character_desc: "old" });
    const { client, payloads } = captureUpdate();
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await saveCharacter("p1", form({ description: "   " }));

    expect(payloads[0]!.character_desc).toBeNull();
  });

  it("refuses a delivered project without writing anything", async () => {
    givenProject({ status: "delivered", character_desc: "old" });
    const { client, payloads } = captureUpdate();
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const result = await saveCharacter("p1", form({ description: "new" }));

    expect(result).toEqual({ error: expect.stringContaining("delivered") });
    expect(payloads).toHaveLength(0);
  });
});

describe("saveProduct", () => {
  it("writes both product fields and no others", async () => {
    givenProject({ status: "draft", product_appearance: "old" });
    const { client, payloads } = captureUpdate();
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await saveProduct("p1", form({ product_name: "Kinoko", product_appearance: "lime green" }));

    const payload = payloads[0]!;
    expect(payload.product_name).toBe("Kinoko");
    expect(payload.product_appearance).toBe("lime green");
    expect(payload).not.toHaveProperty("character_desc");
    expect(payload).not.toHaveProperty("script_raw");
  });

  it("stamps the appearance edit only on a real change", async () => {
    givenProject({ status: "draft", product_appearance: "same" });
    const { client, payloads } = captureUpdate();
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await saveProduct("p1", form({ product_name: "n", product_appearance: "same" }));

    expect(payloads[0]!).not.toHaveProperty("product_appearance_edited_at");
  });

  it("refuses a delivered project without writing anything", async () => {
    givenProject({ status: "delivered", product_appearance: "old" });
    const { client, payloads } = captureUpdate();
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const result = await saveProduct("p1", form({ product_name: "n", product_appearance: "x" }));

    expect(result).toEqual({ error: expect.stringContaining("delivered") });
    expect(payloads).toHaveLength(0);
  });
});

describe("saveScript", () => {
  it("writes the script and nothing else", async () => {
    givenProject({ status: "draft" });
    const { client, payloads } = captureUpdate();
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await saveScript("p1", form({ script_raw: "Two cups of regular coffee." }));

    const payload = payloads[0]!;
    expect(payload.script_raw).toBe("Two cups of regular coffee.");
    expect(payload).not.toHaveProperty("character_desc");
    expect(payload).not.toHaveProperty("product_name");
  });

  it("refuses an empty script through the same guard createProject uses", async () => {
    givenProject({ status: "draft" });
    const { client, payloads } = captureUpdate();
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const result = await saveScript("p1", form({ script_raw: "   " }));

    expect(result).toHaveProperty("error");
    expect(payloads).toHaveLength(0);
  });

  it("refuses a delivered project without writing anything", async () => {
    givenProject({ status: "delivered" });
    const { client, payloads } = captureUpdate();
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const result = await saveScript("p1", form({ script_raw: "a real script" }));

    expect(result).toEqual({ error: expect.stringContaining("delivered") });
    expect(payloads).toHaveLength(0);
  });
});
