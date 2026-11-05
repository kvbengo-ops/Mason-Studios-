// Drift guard: DIALOGUE_APPEND_TEMPLATE in ugc-prompt-preview.ts is a
// hand-copied twin of the Go format string worker/internal/loop/dispatch.go's
// promptForScene uses to append a spoken line:
//
//   base = fmt.Sprintf(`%s Dialogue, spoken aloud on camera: "%s"`, base, *scene.ScriptLine)
//
// Nothing type-checks the two against each other — one is a Go format
// verb, the other a TS split() target — so a wording change on either side
// (a punctuation tweak, a rephrase) would silently make the /ugc prompt
// preview lie about what ships. This test parses the Go literal as text,
// the same way models-drift.test.ts (web/lib/kie/rates-drift.test.ts, its
// current name) parses worker/internal/kie/models.go, and asserts it
// actually found the string it was looking for so a refactor that breaks
// the regex fails loudly instead of comparing nothing.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DIALOGUE_APPEND_TEMPLATE, appendDialogue } from "./ugc-prompt-preview";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const GO_DISPATCH_FILE = `${WEB_ROOT}/../worker/internal/loop/dispatch.go`;

/** Pulls the backtick literal out of `base = fmt.Sprintf(\`...\`, base, *scene.ScriptLine)`. */
function extractGoDialogueTemplate(source: string): string | undefined {
  const match = /base = fmt\.Sprintf\(`([^`]+)`,\s*base,\s*\*scene\.ScriptLine\)/.exec(source);
  return match?.[1];
}

describe("web/lib/ugc-prompt-preview.ts vs worker/internal/loop/dispatch.go's promptForScene", () => {
  const goSource = readFileSync(GO_DISPATCH_FILE, "utf8");
  const goTemplate = extractGoDialogueTemplate(goSource);

  it("found the dialogue-append literal in dispatch.go", () => {
    // Fails loudly rather than letting every assertion below pass over
    // `undefined === undefined` the moment the Go source is reshaped enough
    // to break the regex above.
    expect(goTemplate, "could not find promptForScene's fmt.Sprintf dialogue literal in dispatch.go").toBeDefined();
    expect(goTemplate).toContain("Dialogue, spoken aloud on camera:");
  });

  it("DIALOGUE_APPEND_TEMPLATE matches the Go literal character for character", () => {
    expect(DIALOGUE_APPEND_TEMPLATE).toBe(goTemplate);
  });

  it("appendDialogue formats the same way Go's fmt.Sprintf(template, base, scriptLine) would", () => {
    expect(appendDialogue("A hand pours coffee.", 'Try the new blend, it changes everything.')).toBe(
      'A hand pours coffee. Dialogue, spoken aloud on camera: "Try the new blend, it changes everything."',
    );
  });

  it("stays correct even when base or scriptLine themselves contain the literal text \"%s\"", () => {
    // The reason appendDialogue splits the TEMPLATE instead of doing two
    // sequential String.replace("%s", ...) calls: a second .replace on
    // already-substituted text would find "%s" inside `base` first if the
    // operator's own prompt happened to contain it.
    expect(appendDialogue("Say %s twice", "ok")).toBe(
      'Say %s twice Dialogue, spoken aloud on camera: "ok"',
    );
  });
});
