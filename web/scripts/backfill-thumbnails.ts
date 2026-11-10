// One-off: writes the pre-sized display copies (lib/storage.ts, IMAGE_SIZE_WIDTHS)
// for every image already in the media bucket from before uploads made them.
//
//   cd web
//   bun scripts/backfill-thumbnails.ts --dry-run   # list what it would write
//   bun scripts/backfill-thumbnails.ts             # write it
//   bun scripts/backfill-thumbnails.ts --concurrency=1 --pause-ms=1500   # gently
//
// Gently is the safe default on a busy project: every image is a download and
// two uploads, and at 4 at a time it stalled production on 2026-11-10.
//
// Bun loads web/.env.local by itself: NEXT_PUBLIC_SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY. That file points at PRODUCTION Supabase.
//
// Idempotent: an original whose copies already exist is skipped, so a run that
// dies halfway is finished by running it again. Never deletes or overwrites an
// original; it only uploads `<key>.thumb.webp` / `<key>.medium.webp`.

import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

// ponytail: copied from lib/storage.ts, which is server-only and can't be
// imported here. Change both together.
const BUCKET = "media";
const SIZES = { thumb: 400, medium: 1280 } as const;
const WEBP_QUALITY = 80;
const IMAGE_KEY = /\.(png|jpe?g|webp|gif)$/i;
const RESIZED_KEY = /\.(thumb|medium)\.webp$/;
// Transient uploads and bug-report screenshots are never shown as thumbnails.
const SKIP_PREFIXES = ["staging/", "issue-reports/"];
const PAGE = 1000;

const dryRun = process.argv.includes("--dry-run");
const flag = (name: string, fallback: number): number => {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a whole number`);
  return value;
};
const CONCURRENCY = Math.max(1, flag("concurrency", 1));
const PAUSE_MS = flag("pause-ms", 1500);
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (web/.env.local).");
  process.exit(1);
}
const storage = createClient(url, serviceKey, { auth: { persistSession: false } }).storage.from(
  BUCKET,
);

/** Every object key under `prefix`, walking folders (Storage lists one level at a time). */
async function listAll(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await storage.list(prefix, { limit: PAGE, offset });
    if (error) throw new Error(`list ${prefix || "/"}: ${error.message}`);
    for (const entry of data) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (SKIP_PREFIXES.some((skip) => `${path}/`.startsWith(skip))) continue;
      // A folder has no id.
      if (entry.id === null) keys.push(...(await listAll(path)));
      else keys.push(path);
    }
    if (data.length < PAGE) return keys;
  }
}

async function backfill(key: string, missing: (keyof typeof SIZES)[]): Promise<void> {
  const { data, error } = await storage.download(key);
  if (error || !data) throw new Error(`download: ${error?.message ?? "no data"}`);
  const input = Buffer.from(await data.arrayBuffer());
  for (const size of missing) {
    const output = await sharp(input)
      .rotate()
      .resize({ width: SIZES[size], withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
    const { error: upErr } = await storage.upload(`${key}.${size}.webp`, output, {
      contentType: "image/webp",
      cacheControl: "31536000",
      upsert: true,
    });
    if (upErr) throw new Error(`upload ${size}: ${upErr.message}`);
  }
}

const all = await listAll("");
const existing = new Set(all);
const work = all
  .filter((key) => IMAGE_KEY.test(key) && !RESIZED_KEY.test(key))
  .map((key) => ({
    key,
    missing: (Object.keys(SIZES) as (keyof typeof SIZES)[]).filter(
      (size) => !existing.has(`${key}.${size}.webp`),
    ),
  }))
  .filter((item) => item.missing.length > 0);

console.log(
  `${all.length} objects listed; ${work.length} images need copies${dryRun ? " (dry run, nothing written)" : ""}.`,
);

let done = 0;
let failed = 0;
const queue = [...work];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const n = ++done;
      if (dryRun) {
        console.log(`[${n}/${work.length}] would write ${item.missing.join("+")} for ${item.key}`);
        continue;
      }
      try {
        await backfill(item.key, item.missing);
        console.log(`[${n}/${work.length}] ${item.missing.join("+")} ${item.key}`);
        if (PAUSE_MS > 0) await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
      } catch (err) {
        failed++;
        console.error(`[${n}/${work.length}] FAILED ${item.key}: ${(err as Error).message}`);
      }
    }
  }),
);

console.log(
  dryRun
    ? `Dry run: ${work.length} would be written.`
    : `Done: ${work.length - failed} written, ${failed} failed.`,
);
process.exit(failed > 0 ? 1 : 0);
