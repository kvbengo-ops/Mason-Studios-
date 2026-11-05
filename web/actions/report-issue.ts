"use server";

// The in-app "Report a problem" dialog (components/report-issue-dialog.tsx).
//
// WHAT MAKES THIS WORTH HAVING is not the title and the description — it is
// everything attached to them that the reporter would never think to type.
// "It didn't work" filed with the account, the route, the build sha and the
// schema version is a report someone can act on; the same sentence on its
// own is a conversation that starts with four questions.
//
// Anyone signed in can file. The people who see the bugs are the operators,
// and a report button only admins can press is a report button nobody
// presses. What that opens — one bad afternoon becoming forty identical
// issues — is closed by the rate limit below rather than by narrowing who
// may speak.

import { createHash } from "node:crypto";
import { requireUser } from "@/actions/guard";
import { createAdminClient } from "@/lib/supabase/server";
import { createIssue, issueReportingConfigured } from "@/lib/github-issues";
import { readAppliedSchemaVersion } from "@/lib/db-version";
import { BUILD_SHA, EXPECTED_DB_VERSION } from "@/lib/version";
import { resolveStagedUploads, uploadIssueImage as uploadIssueImageToStorage } from "@/lib/storage";

/** Room for a sentence, not a paragraph — the description is where detail goes. */
const MAX_TITLE = 120;
const MAX_DESCRIPTION = 4000;
/** Enough that a report is a report and not a stray keypress. */
const MIN_DESCRIPTION = 10;

/**
 * How many reports one person may file in an hour, and how long an identical
 * one is treated as the same report.
 *
 * Three is above what anyone files in good faith and far below what a stuck
 * render loop produces. The duplicate window is separate and much shorter:
 * pressing submit twice is an accident, while the same report a day later is
 * a legitimate "this is still happening".
 */
const MAX_REPORTS_PER_HOUR = 3;
const DUPLICATE_WINDOW_MINUTES = 10;

export interface ReportIssueResult {
  error?: string;
  issueUrl?: string;
  issueNumber?: number;
}

export async function submitIssue(formData: FormData): Promise<ReportIssueResult> {
  const { user, profile } = await requireUser();

  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  // THE ONE THING THE CLIENT HAS TO SEND. A Server Action has no idea which
  // route called it, so the page has to say — and being client-supplied it is
  // treated as a label on a report, never as a claim anything branches on.
  //
  // Everything else in the footer is read HERE rather than accepted from the
  // dialog: the build and the schema version are facts about the server, and
  // a report is worth least exactly when the sender is the thing that is
  // broken.
  const route = String(formData.get("route") ?? "").trim();

  if (!title) return { error: "Give it a title — one line describing what went wrong." };
  if (title.length > MAX_TITLE) {
    return { error: `That title is ${title.length} characters; the limit is ${MAX_TITLE}.` };
  }
  if (description.length < MIN_DESCRIPTION) {
    return {
      error:
        "Add a little more detail — what you did, what you expected, and what happened instead.",
    };
  }
  if (description.length > MAX_DESCRIPTION) {
    return {
      error: `That description is ${description.length} characters; the limit is ${MAX_DESCRIPTION}.`,
    };
  }

  // CHECKED BEFORE THE RATE LIMIT, so a misconfigured deployment does not
  // spend somebody's three-an-hour on reports that were never going anywhere.
  if (!issueReportingConfigured()) {
    return {
      error:
        "Reporting is not set up on this deployment yet — tell the team directly for now.",
    };
  }

  const admin = createAdminClient();
  const bodyHash = createHash("sha256").update(`${title}\n${description}`).digest("hex");

  const sinceHour = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: recent, error: recentError } = await admin
    .from("issue_reports")
    .select("body_hash, created_at, issue_url")
    .eq("user_id", user.id)
    .gte("created_at", sinceHour)
    .order("created_at", { ascending: false });

  // FAILING OPEN, deliberately. This read exists to stop a flood, and an
  // unreadable table is not evidence of one — refusing a bug report because
  // the database hiccuped is the app losing the only channel it has for
  // being told it is broken.
  if (recentError) {
    console.error("submitIssue: could not read recent reports, letting this one through", recentError);
  }

  const rows = recent ?? [];
  const duplicateSince = Date.now() - DUPLICATE_WINDOW_MINUTES * 60 * 1000;
  const duplicate = rows.find(
    (r) => r.body_hash === bodyHash && new Date(r.created_at).getTime() > duplicateSince,
  );
  if (duplicate) {
    return {
      error: "You already sent this one a moment ago.",
      // Handing back the link turns "you already sent this" from a refusal
      // into an answer: it is the thing they would ask for next.
      issueUrl: duplicate.issue_url ?? undefined,
    };
  }
  if (rows.length >= MAX_REPORTS_PER_HOUR) {
    return {
      error: `That is ${MAX_REPORTS_PER_HOUR} reports this hour, which is the limit. Add anything else to the ones you already sent.`,
    };
  }

  // The version the DATABASE is actually on, not only the one the code
  // expects. When those two disagree the difference is usually the bug, and
  // it is the first thing anyone reading the report would go and check.
  const appliedDbVersion = await readAppliedSchemaVersion();

  const issue = await createIssue({
    title,
    body: reportBody({
      description,
      route,
      email: user.email ?? "unknown",
      username: profile.username,
      role: profile.role,
      appliedDbVersion,
    }),
  });

  // Recorded whether or not GitHub took it: a row with no issue_number is an
  // attempt that failed, and being able to count those is how we find out
  // the token expired without waiting for someone to mention it.
  const { error: writeError } = await admin.from("issue_reports").insert({
    user_id: user.id,
    title,
    body_hash: bodyHash,
    issue_number: "error" in issue ? null : issue.number,
    issue_url: "error" in issue ? null : issue.url,
  });
  if (writeError) {
    console.error("submitIssue: could not record the report", writeError);
  }

  if ("error" in issue) return { error: issue.error };
  return { issueNumber: issue.number, issueUrl: issue.url };
}

/**
 * The issue body: what they wrote, then what we know.
 *
 * The context goes UNDER the description rather than above it, so the first
 * thing a reader sees is the person's own words. It is a table because the
 * alternative is six lines of prose nobody reads to the end.
 */
function reportBody(args: {
  description: string;
  route: string;
  email: string;
  username: string;
  role: string;
  appliedDbVersion: string | null;
}): string {
  // BOTH SCHEMA NUMBERS, and said plainly when they differ. "code 0082 ·
  // db 0081" is the shape of a deploy that landed ahead of its migration,
  // which is a bug report's answer rather than another question.
  const schema =
    args.appliedDbVersion === null
      ? `${EXPECTED_DB_VERSION} expected, database unreadable`
      : args.appliedDbVersion === EXPECTED_DB_VERSION
        ? args.appliedDbVersion
        : `${EXPECTED_DB_VERSION} expected, ${args.appliedDbVersion} applied — DRIFT`;

  return [
    args.description,
    "",
    "---",
    "",
    "| | |",
    "|---|---|",
    `| Reported by | ${args.username} (${args.email}) |`,
    `| Role | ${args.role} |`,
    `| Page | ${args.route || "—"} |`,
    `| Build | \`${BUILD_SHA}\` |`,
    `| Schema | ${schema} |`,
    "",
    "_Filed from the in-app Report a problem dialog._",
  ].join("\n");
}

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_PER_HOUR = 10;

// ponytail: in-memory, so it resets on every deploy/instance and doesn't
// coordinate across instances. Fine for "stop a runaway paste loop"; move to
// a table like issue_reports if it's ever actually abused.
const imageUploadTimestamps = new Map<string, number[]>();

function isRateLimited(userId: string): boolean {
  const since = Date.now() - 60 * 60 * 1000;
  const recent = (imageUploadTimestamps.get(userId) ?? []).filter((t) => t > since);
  // A refused attempt is not counted, so hammering paste cannot extend the lockout.
  if (recent.length >= MAX_IMAGES_PER_HOUR) return true;
  recent.push(Date.now());
  imageUploadTimestamps.set(userId, recent);
  return false;
}

export async function uploadIssueImage(formData: FormData): Promise<{ path?: string; error?: string }> {
  const { user } = await requireUser();
  await resolveStagedUploads(formData, user.id);

  const file = formData.get("image");
  if (!(file instanceof File)) {
    return { error: "No image received." };
  }
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    return { error: "Only PNG, JPEG, GIF, or WebP images are supported." };
  }
  if (file.size === 0) {
    return { error: "That image is empty." };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return { error: "Images are limited to 5MB." };
  }
  if (isRateLimited(user.id)) {
    return { error: "Too many images pasted this hour — try again later." };
  }

  try {
    const filename = await uploadIssueImageToStorage({ file });
    return { path: `/api/issue-image/${filename}` };
  } catch (err) {
    console.error("uploadIssueImage: upload failed", err);
    return { error: "Could not upload that image — try again." };
  }
}
