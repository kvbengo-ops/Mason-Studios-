import { describe, expect, it } from "vitest";
import { EMPTY_SCRIPT_MESSAGE, requireScript } from "./script-guard";

describe("requireScript", () => {
  it("accepts a non-empty script and trims it", () => {
    expect(requireScript("  Hello there.  ")).toEqual({ script: "Hello there." });
  });

  it("refuses a missing value", () => {
    expect(requireScript(null)).toEqual({ error: EMPTY_SCRIPT_MESSAGE });
  });

  it("refuses an empty string", () => {
    expect(requireScript("")).toEqual({ error: EMPTY_SCRIPT_MESSAGE });
  });

  it("refuses a whitespace-only string", () => {
    expect(requireScript("   \n\t  ")).toEqual({ error: EMPTY_SCRIPT_MESSAGE });
  });

  it("refuses a non-string FormData value (e.g. a File)", () => {
    expect(requireScript(new File(["x"], "script.txt"))).toEqual({ error: EMPTY_SCRIPT_MESSAGE });
  });
});
