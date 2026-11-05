// Tune the sequence compiler's prompt against the REAL Claude API, without
// touching kie and without spending a cent on images.
//
//   cd web
//   ANTHROPIC_API_KEY=sk-... bun --conditions react-server scripts/try-image-sequence.ts "make me 5 images of a man walking towards the street"
//
// --conditions react-server IS REQUIRED and is not a detail. lib/claude.ts
// starts with `import "server-only"`, whose default export throws on sight
// ("This module cannot be imported from a Client Component module"). That
// package ships a `react-server` export condition resolving to a no-op, which
// is what Next sets for a Server Component and what this flag reproduces.
// Without it the script dies before it reaches Claude.
//
// WHY THIS IS A SCRIPT AND NOT A MOCK FLAG.
//
// lib/mode.ts collapsed MOCK_CLAUDE/MOCK_FAL_IMAGE/MOCK_FAL_VIDEO into one
// process-wide MODE after a real incident, and its header names the exact
// pattern that caused it: per-vendor flags that let one process mock Claude
// while paying for real frames. Adding "real Claude, mocked kie" back as a flag
// would reintroduce what was deleted.
//
// It is also unnecessary. Prompt tuning only needs compileImageSequence, and
// nothing in that function's call path can reach kie — there is no image call
// to mock, because none exists here. So this runs MODE=production (the switch
// that makes the Claude call real) in a process whose ONLY vendor call is that
// one, rather than teaching the app a new way to disagree with itself.
//
// SET THE KEY ON THE COMMAND LINE, not in web/.env.local. A key left in the env
// file is read by the running app too, and `bun run db:env` blanks it precisely
// so local development cannot spend. Inline here, the app process stays fully
// mocked while this one script talks to Anthropic.
//
// Cost: one Haiku call per run. Cents, against $0.02 per image if you tuned the
// prompt by generating instead.

process.env.MODE = "production";

const request = process.argv.slice(2).join(" ").trim();
if (!request) {
  console.error('usage: bun scripts/try-image-sequence.ts "<your request>"');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Pass it inline; do not put it in .env.local.");
  process.exit(1);
}

// Imported AFTER MODE is set: lib/mode.ts reads it once per process.
const { compileImageSequence, MAX_SEQUENCE_BEATS } = await import("../lib/claude");

console.log(`\nrequest: ${request}`);
console.log(`model:   ${process.env.CLAUDE_MODEL ?? "(default compiler model)"}`);
console.log(`cap:     ${MAX_SEQUENCE_BEATS} beats\n`);

const started = Date.now();
const sequence = await compileImageSequence({ request });
const elapsedMs = Date.now() - started;

console.log(`${sequence.beats.length} beats in ${(elapsedMs / 1000).toFixed(1)}s\n`);
sequence.beats.forEach((beat, index) => {
  console.log(`--- beat ${index + 1} of ${sequence.beats.length} ---`);
  console.log(beat.prompt);
  console.log();
});

// The two failures worth catching by eye, called out rather than left to be
// noticed: a beat that leans on its neighbour cannot be generated on its own,
// and a dropped @tag silently loses the reference it stood for.
const backReferences = sequence.beats
  .map((beat, index) => ({
    index,
    hit: /\b(the same|as before|previous|continuing|he now|she now)\b/i.exec(beat.prompt)?.[0],
  }))
  .filter((row) => row.hit);
if (backReferences.length > 0) {
  console.log("⚠ back-references (each beat must stand alone):");
  for (const row of backReferences) console.log(`   beat ${row.index + 1}: "${row.hit}"`);
  console.log();
}

const asked = [...request.matchAll(/@([A-Za-z0-9][A-Za-z0-9_-]{0,63})/g)].map((m) => m[1]!);
if (asked.length > 0) {
  const carried = new Set(
    sequence.beats.flatMap((beat) =>
      [...beat.prompt.matchAll(/@([A-Za-z0-9][A-Za-z0-9_-]{0,63})/g)].map((m) => m[1]!),
    ),
  );
  const dropped = asked.filter((tag) => !carried.has(tag));
  console.log(
    dropped.length === 0
      ? `✓ all @tags carried through: ${asked.map((t) => "@" + t).join(", ")}`
      : `⚠ @tags dropped: ${dropped.map((t) => "@" + t).join(", ")}`,
  );
}

// tsc treats a script with no import/export as a non-module, where top-level
// await is an error. The dynamic import above does not count.
export {};
