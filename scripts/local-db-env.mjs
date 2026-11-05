// Point the host-run web app and worker at the running Docker Supabase stack.
// No hosted credentials are read from Supabase; `status` is local-only.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
  constants,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const status = spawnSync(
  process.execPath,
  ["x", "--no-install", "supabase", "status", "-o", "json"],
  {
    cwd: root,
    encoding: "utf8",
  },
);
if (status.error || status.status !== 0) {
  console.error(
    "Local Supabase is unavailable. Start Docker Desktop, then run `bun run db:start`.",
  );
  process.exit(1);
}

const local = JSON.parse(status.stdout);
for (const key of ["API_URL", "DB_URL", "ANON_KEY", "SERVICE_ROLE_KEY"]) {
  if (typeof local[key] !== "string" || !local[key]) {
    throw new Error(`Local Supabase status is missing ${key}.`);
  }
}
for (const [key, port, protocol] of [
  ["API_URL", "54321", "http:"],
  ["DB_URL", "54322", "postgresql:"],
]) {
  const url = new URL(local[key]);
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.port !== port ||
    url.protocol !== protocol
  ) {
    throw new Error(
      `Refusing non-local or unexpected ${key}; check supabase/config.toml.`,
    );
  }
}

const databaseURL = new URL(local.DB_URL);
databaseURL.searchParams.set("sslmode", "disable");
const common = {
  MODE: "development",
  SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY,
  ANTHROPIC_API_KEY: "",
  KIE_API_KEY: "",
  KIE_WEBHOOK_SECRET: "",
  AUDIO_ENABLED: "1",
  ASSEMBLE_ENABLED: "0",
};
const settings = [
  [
    "web",
    {
      ...common,
      NEXT_PUBLIC_SUPABASE_URL: local.API_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: local.ANON_KEY,
      NEXT_PUBLIC_APP_URL: "http://localhost:9000",
      SIGNUP_ALLOWED_DOMAINS: "",
    },
  ],
  [
    "worker",
    {
      ...common,
      DATABASE_URL: databaseURL.toString(),
      SUPABASE_URL: local.API_URL,
      APP_BASE_URL: "http://127.0.0.1:8080",
      PORT: "8080",
    },
  ],
];

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
for (const [service, values] of settings) {
  const target = join(root, service, ".env.local");
  const exists = existsSync(target);
  const original = readFileSync(
    exists ? target : join(root, service, ".env.example"),
    "utf8",
  );
  const seen = new Set();
  const lines = original
    .replace(/^\uFEFF/, "")
    .trimEnd()
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(
        /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/,
      );
      if (!match || !Object.hasOwn(values, match[1])) return [line];
      const key = match[1];
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        `${key}=${values[key] === "" ? "" : JSON.stringify(values[key])}`,
      ];
    });
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) {
      lines.push(`${key}=${value === "" ? "" : JSON.stringify(value)}`);
    }
  }
  const updated = `${lines.join("\n")}\n`;
  if (exists && original === updated) {
    console.log(`${service}/.env.local already points at local Supabase.`);
    continue;
  }
  if (exists) {
    const backup = `${target}.before-local-${stamp}.bak`;
    copyFileSync(target, backup, constants.COPYFILE_EXCL);
    console.log(
      `Backed up ${service}/.env.local to ${service}/${backup.split(/[\\/]/).pop()}`,
    );
  }
  writeFileSync(target, updated, { mode: 0o600 });
  console.log(
    `Configured ${service}/.env.local for local Supabase with MODE=development.`,
  );
}
console.log(
  "Restart the web app and worker to use these settings. Shell environment variables still take precedence.",
);
