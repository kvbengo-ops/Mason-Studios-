#!/usr/bin/env node
// Phase 0 CLI — `make compile SCRIPT=ad.txt`.
//
// Reads a raw ad script, loads the seeded system prompt straight out of
// supabase/migrations/0003_seed_template.sql (there is no database in
// Phase 0), calls the prompt compiler, and prints a human-readable brief so
// an operator can judge viability before any money is spent on Phase 1.
//
// See docs/roadmap.md § "Phase 0 — Prompt compiler, CLI only".

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileBrief } from "../lib/claude";
import type { Brief } from "../lib/claude";
import { estimateCost } from "../lib/estimate";
import { DEFAULT_RENDER_SETTINGS, isAudioEnabled } from "../lib/models";
import { isDev } from "../lib/mode";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
} as const;

function color(text: string, code: string): string {
  if (process.env.NO_COLOR) return text;
  return `${code}${text}${ANSI.reset}`;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_SQL_PATH = resolve(HERE, "../../supabase/migrations/0003_seed_template.sql");

function extractTemplateBody(sqlPath: string): string {
  const sql = readFileSync(sqlPath, "utf-8");
  const match = sql.match(/\$body\$([\s\S]*?)\$body\$/);
  const body = match?.[1];
  if (!body) {
    throw new Error(
      `Could not find a $body$...$body$ dollar-quoted section in ${sqlPath}. ` +
        "Has the seed migration's format changed?",
    );
  }
  return body.trim();
}

function truncate(text: string, maxLen: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 1)}…`;
}

function padEnd(text: string, width: number): string {
  if (text.length >= width) return text;
  return text + " ".repeat(width - text.length);
}

const COL_WIDTHS = {
  idx: 3,
  duration: 5,
  roll: 6,
  scriptLine: 46,
  videoPrompt: 60,
} as const;

function renderScenesTable(brief: Brief): string {
  const headerRow = [
    padEnd("#", COL_WIDTHS.idx),
    padEnd("Dur", COL_WIDTHS.duration),
    padEnd("Roll", COL_WIDTHS.roll),
    padEnd("Script line", COL_WIDTHS.scriptLine),
    padEnd("Video prompt", COL_WIDTHS.videoPrompt),
  ].join(" ");

  const totalWidth =
    COL_WIDTHS.idx +
    COL_WIDTHS.duration +
    COL_WIDTHS.roll +
    COL_WIDTHS.scriptLine +
    COL_WIDTHS.videoPrompt +
    4;

  const lines: string[] = [color(headerRow, ANSI.bold), color("-".repeat(totalWidth), ANSI.dim)];

  brief.scenes.forEach((scene, idx) => {
    const rollLabel = scene.is_talking_head ? "A-roll" : "B-roll";
    const rollColored = color(
      padEnd(rollLabel, COL_WIDTHS.roll),
      scene.is_talking_head ? ANSI.magenta : ANSI.cyan,
    );
    const row = [
      padEnd(String(idx + 1), COL_WIDTHS.idx),
      padEnd(`${scene.duration_s}s`, COL_WIDTHS.duration),
      rollColored,
      padEnd(truncate(scene.script_line, COL_WIDTHS.scriptLine - 1), COL_WIDTHS.scriptLine),
      truncate(scene.video_prompt, COL_WIDTHS.videoPrompt - 1),
    ].join(" ");
    lines.push(row);
  });

  return lines.join("\n");
}

function renderCostSummary(brief: Brief): string {
  const audioEnabled = isAudioEnabled();
  const cost = estimateCost(brief, audioEnabled, DEFAULT_RENDER_SETTINGS);
  const breakdown = audioEnabled
    ? `  ${color(String(cost.talkingHeadCount), ANSI.magenta)} talking-head + ${color(String(cost.silentCount), ANSI.cyan)} silent scenes`
    : `  ${color("AUDIO_ENABLED=0", ANSI.yellow)} — all ${cost.talkingHeadCount + cost.silentCount} scenes render silent`;
  const lines = [
    color("Cost summary", ANSI.bold),
    breakdown,
    `  ${cost.seconds}s total runtime`,
    `  Estimated cost: ${color(`$${cost.totalUsd.toFixed(2)}`, ANSI.green)}`,
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  const scriptPathArg = process.argv[2];
  if (!scriptPathArg) {
    console.error(color("usage: pnpm tsx scripts/compile.ts <path/to/script.txt>", ANSI.red));
    process.exitCode = 1;
    return;
  }

  const scriptPath = resolve(process.cwd(), scriptPathArg);
  let script: string;
  try {
    script = readFileSync(scriptPath, "utf-8");
  } catch (err) {
    console.error(color(`Could not read script file: ${scriptPath}`, ANSI.red));
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  let templateBody: string;
  try {
    templateBody = extractTemplateBody(TEMPLATE_SQL_PATH);
  } catch (err) {
    console.error(color("Failed to load prompt template.", ANSI.red));
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  console.log(color(`Compiling ${scriptPathArg}...`, ANSI.dim));
  if (isDev()) {
    console.log(
      color("MODE=development — using deterministic fixture brief, no API call made.", ANSI.yellow),
    );
  }

  let brief: Brief;
  try {
    brief = await compileBrief({ script, templateBody });
  } catch (err) {
    console.error(color("Compile failed validation.", ANSI.red));
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  console.log();
  console.log(color("Character", ANSI.bold));
  console.log(`  ${brief.character}`);
  console.log();
  console.log(renderScenesTable(brief));
  console.log();
  console.log(renderCostSummary(brief));

  const outPath = join(dirname(scriptPath), "prompts.json");
  writeFileSync(outPath, JSON.stringify(brief, null, 2), "utf-8");
  console.log();
  console.log(color(`Wrote raw JSON to ${outPath}`, ANSI.dim));
}

main().catch((err: unknown) => {
  console.error(color("Unexpected error.", ANSI.red));
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
