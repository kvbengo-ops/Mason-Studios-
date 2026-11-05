import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
const bootstrapSource = readFileSync(
  new URL("../components/theme-bootstrap.tsx", import.meta.url),
  "utf8",
);

describe("root layout theme bootstrap", () => {
  it("keeps the script out of the root layout's client-rendered tree", () => {
    expect(source).toContain('import { ThemeBootstrap } from "@/components/theme-bootstrap"');
    expect(source).toContain("<ThemeBootstrap script={buildThemeScript()} />");
    expect(source).not.toMatch(/<script\b/);
  });

  it("inserts the bootstrap through server-only HTML and renders nothing on the client", () => {
    expect(bootstrapSource).toContain('import { useServerInsertedHTML } from "next/navigation"');
    expect(bootstrapSource).toContain("useServerInsertedHTML(");
    expect(bootstrapSource).toContain("return null");
  });
});
