import { describe, expect, it } from "vitest";
import { saveGeneratedImageAsElement } from "./generated-image-element";

const ASSET = "9f3c1e02-aaaa-bbbb-cccc-123456789abc";

/** The two calls the helper makes: a name check on elements, then an insert. */
function fakeAdmin(taken: string[], insertError?: { code: string; message: string }) {
  const inserted: Record<string, unknown>[] = [];
  let checked = "";
  const admin = {
    from() {
      const builder: Record<string, unknown> = {
        select: () => builder,
        is: () => builder,
        ilike: (_col: string, pattern: string) => {
          checked = pattern.replaceAll(String.fromCharCode(92), "");
          return builder;
        },
        limit: () => builder,
        eq: () => builder,
        insert: (row: Record<string, unknown>) => {
          inserted.push(row);
          return Promise.resolve({ error: insertError ?? null });
        },
        then: (resolve: (v: { data: unknown[] }) => unknown) =>
          resolve({ data: taken.includes(checked) ? [{ id: "x" }] : [] }),
      };
      return builder;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { admin: admin as any, inserted };
}

describe("saveGeneratedImageAsElement", () => {
  it("files the image as a private element pointing at the generated asset", async () => {
    const { admin, inserted } = fakeAdmin([]);
    const name = await saveGeneratedImageAsElement(admin, "user-1", ASSET);

    expect(name).toBe("img_9f3c1e");
    expect(inserted).toEqual([
      {
        user_id: "user-1",
        asset_id: ASSET,
        name: "img_9f3c1e",
        category: "image",
        is_shared: false,
      },
    ]);
  });

  it("uses a longer tag when the short one is taken", async () => {
    const { admin, inserted } = fakeAdmin(["img_9f3c1e"]);
    expect(await saveGeneratedImageAsElement(admin, "user-1", ASSET)).toBe("img_9f3c1e02aa");
    expect(inserted).toHaveLength(1);
  });

  it("surfaces an insert failure that is not a name clash", async () => {
    const { admin } = fakeAdmin([], { code: "42501", message: "denied" });
    await expect(saveGeneratedImageAsElement(admin, "user-1", ASSET)).rejects.toThrow(/denied/);
  });
});
