import { describe, expect, it } from "vitest";
import {
  isAcceptedScriptFile,
  isAcceptedScriptFileSize,
  looksLikeUnsplitParagraph,
  MAX_SCRIPT_FILE_BYTES,
  parseTwoColumnScript,
  scriptRowsHaveVisualIdea,
  scriptTextFromRows,
} from "./script-columns";

describe("parseTwoColumnScript", () => {
  it("single-column paste (every existing project) parses one row per line, visualIdea null throughout", () => {
    // This is the backward-compatibility bar the task is explicit about:
    // every project that exists today has never seen a delimiter, and must
    // keep parsing exactly like this.
    const rows = parseTwoColumnScript(
      "Ever feel like your mornings are a race against the clock?\n" +
        "One scoop, cold water, done.\n" +
        "Your first order ships free this week.",
    );
    expect(rows).toEqual([
      { script: "Ever feel like your mornings are a race against the clock?", visualIdea: null },
      { script: "One scoop, cold water, done.", visualIdea: null },
      { script: "Your first order ships free this week.", visualIdea: null },
    ]);
    expect(scriptRowsHaveVisualIdea(rows)).toBe(false);
  });

  it("splits a tab-separated paste — what a spreadsheet copy actually produces", () => {
    const rows = parseTwoColumnScript(
      "Ever feel like mornings are a race?\tLocked wide shot, zero zoom.\n" +
        "One scoop, cold water, done.\tOverhead close-up on the scoop.",
    );
    expect(rows).toEqual([
      { script: "Ever feel like mornings are a race?", visualIdea: "Locked wide shot, zero zoom." },
      { script: "One scoop, cold water, done.", visualIdea: "Overhead close-up on the scoop." },
    ]);
    expect(scriptRowsHaveVisualIdea(rows)).toBe(true);
  });

  it("splits a pipe-separated paste — the hand-typeable delimiter", () => {
    const rows = parseTwoColumnScript("Meet Seranova. | Medium shot, warm light, static tripod.");
    expect(rows).toEqual([
      { script: "Meet Seranova.", visualIdea: "Medium shot, warm light, static tripod." },
    ]);
  });

  it("a ragged paste mixes one-column and two-column lines line by line", () => {
    const rows = parseTwoColumnScript(
      "Meet Seranova.\tLocked wide shot.\n" +
        "No visual note on this one.\n" +
        "Your first order ships free.\tClose-up on the jar.",
    );
    expect(rows).toEqual([
      { script: "Meet Seranova.", visualIdea: "Locked wide shot." },
      { script: "No visual note on this one.", visualIdea: null },
      { script: "Your first order ships free.", visualIdea: "Close-up on the jar." },
    ]);
  });

  it("a blank line is dropped, not returned as an empty row", () => {
    const rows = parseTwoColumnScript("First line.\n\n\nSecond line.");
    expect(rows).toEqual([
      { script: "First line.", visualIdea: null },
      { script: "Second line.", visualIdea: null },
    ]);
  });

  it("a line that is only whitespace is treated the same as a blank line", () => {
    const rows = parseTwoColumnScript("First line.\n   \t  \nSecond line.");
    expect(rows).toHaveLength(2);
  });

  it("a visual idea with no script line is kept as a visual-only beat, not dropped", () => {
    const rows = parseTwoColumnScript(
      "Meet Seranova.\tLocked wide shot.\n" + "\tCutaway to the product label, macro focus.",
    );
    expect(rows[1]).toEqual({
      script: "",
      visualIdea: "Cutaway to the product label, macro focus.",
    });
  });

  it("a delimiter with nothing after it collapses to visualIdea: null, not an empty string", () => {
    // A spreadsheet's trailing empty cell in the Visual Idea column still
    // includes the tab when a full row range is copied.
    const rows = parseTwoColumnScript("Meet Seranova.\t");
    expect(rows).toEqual([{ script: "Meet Seranova.", visualIdea: null }]);
  });

  it("trims trailing and leading whitespace on both cells", () => {
    const rows = parseTwoColumnScript("  Meet Seranova.   \t   Locked wide shot.   ");
    expect(rows).toEqual([{ script: "Meet Seranova.", visualIdea: "Locked wide shot." }]);
  });

  it("normalizes CRLF line endings from a Windows-authored .txt upload", () => {
    const rows = parseTwoColumnScript("Meet Seranova.\tLocked wide shot.\r\nShips free.\r\n");
    expect(rows).toEqual([
      { script: "Meet Seranova.", visualIdea: "Locked wide shot." },
      { script: "Ships free.", visualIdea: null },
    ]);
  });

  it("normalizes a lone CR (old Mac line endings) the same way", () => {
    const rows = parseTwoColumnScript("First line.\rSecond line.");
    expect(rows).toEqual([
      { script: "First line.", visualIdea: null },
      { script: "Second line.", visualIdea: null },
    ]);
  });

  it("splits on the FIRST delimiter only — a visual idea containing a tab or pipe doesn't fragment", () => {
    const rows = parseTwoColumnScript("Meet Seranova.\tWide shot | then push in, then a tab\ttoo.");
    expect(rows).toEqual([
      { script: "Meet Seranova.", visualIdea: "Wide shot | then push in, then a tab\ttoo." },
    ]);
  });

  it("empty input returns an empty array", () => {
    expect(parseTwoColumnScript("")).toEqual([]);
    expect(parseTwoColumnScript("   \n  \n")).toEqual([]);
  });

  it("documents the pipe-collision trade-off: a single-column line with a literal pipe misparses", () => {
    // Known, accepted limitation — see this module's header comment. A
    // script that legitimately uses "|" as punctuation in dialogue will
    // split on it exactly like a two-column paste would. The preview panel
    // in character-setup-form.tsx is the backstop: this kind of misparse is
    // visible immediately as a script column that stops mid-sentence next
    // to a "visual idea" that's actually the rest of the line.
    const rows = parseTwoColumnScript("Time flies | doesn't it?");
    expect(rows).toEqual([{ script: "Time flies", visualIdea: "doesn't it?" }]);
  });
});

describe("scriptRowsHaveVisualIdea", () => {
  it("is false for an all-null-visualIdea parse (single-column input)", () => {
    expect(
      scriptRowsHaveVisualIdea(parseTwoColumnScript("Just a plain script.\nAnother line.")),
    ).toBe(false);
  });

  it("is true the moment any row carries a visual idea, even one out of many", () => {
    const rows = parseTwoColumnScript("Line one.\nLine two.\tOne visual note.\nLine three.");
    expect(scriptRowsHaveVisualIdea(rows)).toBe(true);
  });

  it("is false for an empty row set", () => {
    expect(scriptRowsHaveVisualIdea([])).toBe(false);
  });
});

describe("scriptTextFromRows", () => {
  it("rebuilds a plain single-column script from the .script cells, one per line", () => {
    const rows = parseTwoColumnScript(
      "Meet Seranova.\tLocked wide shot.\nShips free this week.\tClose-up on the jar.",
    );
    expect(scriptTextFromRows(rows)).toBe("Meet Seranova.\nShips free this week.");
  });

  it("skips a visual-only row's empty script cell rather than emitting a blank line", () => {
    const rows = parseTwoColumnScript(
      "Meet Seranova.\tLocked wide shot.\n\tCutaway to the label.\nShips free.",
    );
    expect(scriptTextFromRows(rows)).toBe("Meet Seranova.\nShips free.");
  });

  it("round-trips a single-column parse back to (whitespace-normalized) plain text", () => {
    const original = "Line one.\nLine two.\nLine three.";
    expect(scriptTextFromRows(parseTwoColumnScript(original))).toBe(original);
  });
});

describe("isAcceptedScriptFile", () => {
  it("accepts a text/plain MIME type", () => {
    expect(isAcceptedScriptFile({ type: "text/plain", name: "script" })).toBe(true);
  });

  it("accepts a .txt filename even with a blank/generic MIME type", () => {
    // Same fallback reasoning as lib/file-type.ts's isAcceptedReferenceImage
    // — some OS file pickers hand the browser a blank or
    // application/octet-stream MIME type instead of sniffing it.
    expect(isAcceptedScriptFile({ type: "", name: "NEUROBLAST - SMN17.txt" })).toBe(true);
    expect(isAcceptedScriptFile({ type: "application/octet-stream", name: "script.TXT" })).toBe(
      true,
    );
  });

  it("rejects a non-script file", () => {
    expect(isAcceptedScriptFile({ type: "application/pdf", name: "script.pdf" })).toBe(false);
    expect(isAcceptedScriptFile({ type: "image/png", name: "photo.png" })).toBe(false);
  });
});

describe("isAcceptedScriptFileSize", () => {
  it("accepts a file under the cap", () => {
    expect(isAcceptedScriptFileSize({ size: 2048 })).toBe(true);
  });

  it("accepts a file exactly at the cap", () => {
    expect(isAcceptedScriptFileSize({ size: MAX_SCRIPT_FILE_BYTES })).toBe(true);
  });

  it("rejects a file over the cap", () => {
    expect(isAcceptedScriptFileSize({ size: MAX_SCRIPT_FILE_BYTES + 1 })).toBe(false);
  });
});

describe("looksLikeUnsplitParagraph", () => {
  // The two signals are ANDed, so each gets a test that isolates it: a long
  // single sentence (length passes, sentence count fails) and a short
  // multi-sentence line (sentence count passes, length fails). Without
  // both, either half could be deleted and the suite would stay green.

  it("flags a whole ad pasted onto one line", () => {
    const rows = parseTwoColumnScript(
      "Okay I need to talk about this serum. Three weeks in and my skin is completely " +
        "different. I was so skeptical at first because everything promises this. But " +
        "honestly, look at me. I am never going back to anything else.",
    );

    expect(rows).toHaveLength(1);
    expect(looksLikeUnsplitParagraph(rows)).toBe(true);
  });

  it("leaves a genuinely short one-line script alone", () => {
    // The most common legitimate single row. Flagging this would train the
    // operator to ignore the warning, which costs more than never showing it.
    expect(looksLikeUnsplitParagraph(parseTwoColumnScript("Buy it. Seriously. Just go."))).toBe(
      false,
    );
  });

  it("leaves one long unbroken sentence alone", () => {
    // The terminating period is load-bearing, not punctuation tidiness.
    // Without it this string has ZERO sentence terminators and clears the
    // floor no matter what the floor is set to — so the test would pass
    // against correct code while proving nothing, which is what it did
    // until a control caught it. With the period it has exactly one, and
    // dropping the floor to 1 makes this test fail as it should.
    const oneSentence =
      "I have been reaching for this every single morning before I even think about " +
      "leaving the house because it is genuinely the only thing that has ever made a " +
      "difference to how my skin looks under real daylight in the middle of winter.";

    expect(oneSentence.length).toBeGreaterThan(180);
    expect(looksLikeUnsplitParagraph(parseTwoColumnScript(oneSentence))).toBe(false);
  });

  it("leaves a long two-sentence line alone, one short of the floor", () => {
    // Pins the boundary itself: raising the floor to 2 must flag this, so
    // the exact value of UNSPLIT_MIN_SENTENCES is under test rather than
    // merely "some floor exists".
    const twoSentences =
      "I have been reaching for this every single morning before I even leave the house. " +
      "It is genuinely the only thing that has ever made a difference to how my skin " +
      "looks under real daylight in the middle of winter.";

    expect(twoSentences.length).toBeGreaterThan(180);
    expect(looksLikeUnsplitParagraph(parseTwoColumnScript(twoSentences))).toBe(false);
  });

  it("never flags a script that already has line breaks", () => {
    // Scoped to a single row on purpose — a ragged multi-row mis-paste is
    // not reliably distinguishable from a dense but deliberate script.
    const rows = parseTwoColumnScript(
      "Okay I need to talk about this serum. Three weeks in and my skin is different.\n" +
        "I was so skeptical at first. Everything promises this. But look at me now.\n" +
        "I am never going back to anything else. Not after this. Truly never.",
    );

    expect(rows.length).toBeGreaterThan(1);
    expect(looksLikeUnsplitParagraph(rows)).toBe(false);
  });

  it("handles an empty script", () => {
    expect(looksLikeUnsplitParagraph(parseTwoColumnScript(""))).toBe(false);
  });

  it("measures the script column only, not a long visual idea beside it", () => {
    // A two-column row whose SCRIPT is one short beat is not a mis-paste,
    // however much shot direction sits next to it.
    const rows = parseTwoColumnScript(
      "Look at this.\tSlow push in on the bottle. Morning light through the window. " +
        "She turns it over in her hands. Holds it up. Then a beat of silence before she speaks.",
    );

    expect(rows).toHaveLength(1);
    expect(looksLikeUnsplitParagraph(rows)).toBe(false);
  });
});
