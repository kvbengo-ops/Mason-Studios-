/**
 * Files an issue on the repo this app is built from.
 *
 * SERVER ONLY. The token is a fine-grained PAT with `Issues: write` on one
 * repository and nothing else, and it never leaves the server — a token in
 * the browser is a token anyone with devtools can lift and use to write to
 * the repo under our name.
 *
 * Failures are RETURNED, not thrown. The caller is a Server Action behind a
 * dialog an operator is looking at, and the whole point of the feature is
 * that a report never silently evaporates: a refusal has to reach the screen
 * with the text still in the box.
 */

const GITHUB_API = "https://api.github.com";

/** Where the issues go. `owner/repo`, from the environment so a fork is one variable. */
export function issueRepo(): string {
  return process.env.GITHUB_ISSUE_REPO ?? "";
}

function issueToken(): string {
  return process.env.GITHUB_ISSUE_TOKEN ?? "";
}

/** Whether the feature is configured at all — checked before the button is offered. */
export function issueReportingConfigured(): boolean {
  return issueToken().length > 0 && issueRepo().includes("/");
}

export interface CreatedIssue {
  number: number;
  url: string;
}

export type CreateIssueResult = CreatedIssue | { error: string };

/**
 * Creates the issue and hands back its number and URL.
 *
 * `labels` is deliberately a fixed pair rather than anything the operator
 * chooses: a label an editor can set is a label nobody trusts for triage,
 * and "which part of the app" is a question the body already answers with
 * the route it was reported from.
 */
export async function createIssue(args: {
  title: string;
  body: string;
}): Promise<CreateIssueResult> {
  if (!issueReportingConfigured()) {
    return { error: "Reporting is not configured on this deployment." };
  }

  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}/repos/${issueRepo()}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issueToken()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: args.title,
        body: args.body,
        labels: ["from-app", "needs-triage"],
      }),
    });
  } catch (err) {
    // A DNS failure, a dropped connection, GitHub being down. Named as the
    // network rather than as the operator's mistake, because it is not one.
    return {
      error: `Could not reach GitHub: ${err instanceof Error ? err.message : "network error"}`,
    };
  }

  if (!response.ok) {
    // GitHub's own message is worth surfacing: "Bad credentials" and
    // "Issues are disabled for this repo" need different people to fix them,
    // and a generic "could not file" tells neither of them anything.
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) detail = `${detail} — ${body.message}`;
    } catch {
      // A non-JSON error body (a proxy page, a rate-limit HTML) is still a
      // failure; the status alone is what we can honestly say about it.
    }
    return { error: `GitHub refused the report (${detail}).` };
  }

  const created = (await response.json()) as { number?: number; html_url?: string };
  if (typeof created.number !== "number" || typeof created.html_url !== "string") {
    return { error: "GitHub accepted the report but did not say where it went." };
  }
  return { number: created.number, url: created.html_url };
}
