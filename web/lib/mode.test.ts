import { afterEach, describe, expect, it, vi } from "vitest";
import { isDev, isProd, mode } from "./mode";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("mode", () => {
  it("defaults to development when MODE is unset", () => {
    expect(mode()).toBe("development");
    expect(isDev()).toBe(true);
    expect(isProd()).toBe(false);
  });

  it("is production only for the exact string 'production'", () => {
    vi.stubEnv("MODE", "production");
    expect(mode()).toBe("production");
    expect(isDev()).toBe(false);
    expect(isProd()).toBe(true);
  });

  // The unsafe direction is landing on "production" by accident; the safe
  // one is staying mocked. Garbage must fall the safe way — see this file's
  // header comment on lib/mode.ts.
  it("falls back to development for anything other than exactly 'production'", () => {
    for (const junk of ["Production", "PRODUCTION", "prod", "1", ""]) {
      vi.stubEnv("MODE", junk);
      expect(mode()).toBe("development");
    }
  });
});
