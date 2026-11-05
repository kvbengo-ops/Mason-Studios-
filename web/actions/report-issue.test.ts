import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// THE VERSION IS READ, NOT WRITTEN DOWN. These assertions used to name "0082"
// on both sides, which made the suite fail on the next migration anybody
// wrote — it went red on Kyle's Image Generator branch for a reason that had
// nothing to do with his change, which is a guard training people to ignore
// it. What is worth pinning is that the two numbers AGREE, and that a
// disagreement is called drift.
import { EXPECTED_DB_VERSION } from "@/lib/version";

// The guard, the database and GitHub are all mocked: what is under test here
// is the ORDER of the decisions and what each one says, which is where this
// action can go wrong in ways nobody notices.
interface IssueArgs {
  title: string;
  body: string;
}
const createIssue = vi.fn<(args: IssueArgs) => Promise<unknown>>();
const issueReportingConfigured = vi.fn(() => true);
vi.mock("@/lib/github-issues", () => ({
  createIssue: (args: IssueArgs) => createIssue(args),
  issueReportingConfigured: () => issueReportingConfigured(),
}));

vi.mock("@/actions/guard", () => ({
  requireUser: async () => ({
    user: { id: "user-1", email: "jen@example.test" },
    profile: { username: "jen", role: "editor" },
  }),
}));

vi.mock("@/lib/db-version", () => ({
  readAppliedSchemaVersion: async () => appliedVersion,
}));

let appliedVersion: string | null = EXPECTED_DB_VERSION;
let recentRows: { body_hash: string; created_at: string; issue_url: string | null }[] = [];
let recentError: { message: string } | null = null;
interface ReportRow {
  user_id: string;
  title: string;
  body_hash: string;
  issue_number: number | null;
  issue_url: string | null;
}
const insert = vi.fn<(row: ReportRow) => Promise<{ error: null }>>(async () => ({ error: null }));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          gte: () => ({
            order: async () => ({ data: recentRows, error: recentError }),
          }),
        }),
      }),
      insert,
    }),
  }),
}));

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const GOOD = {
  title: "Generate does nothing",
  description: "I picked a voice tag and pressed Generate. Nothing happened.",
  route: "/ugc/proj-1",
};

describe("submitIssue", () => {
  beforeEach(() => {
    recentRows = [];
    recentError = null;
    appliedVersion = EXPECTED_DB_VERSION;
    issueReportingConfigured.mockReturnValue(true);
    createIssue.mockResolvedValue({ number: 7, url: "https://github.com/acme/app/issues/7" });
  });

  afterEach(() => vi.clearAllMocks());

  it("attaches who, where, which build and which schema", async () => {
    const { submitIssue } = await import("./report-issue");

    const result = await submitIssue(form(GOOD));

    expect(result).toEqual({ issueNumber: 7, issueUrl: "https://github.com/acme/app/issues/7" });
    const body = createIssue.mock.calls[0]![0].body;
    // The reporter's own words come FIRST — the context is a footer, not a
    // preamble someone has to scroll past.
    expect(body.startsWith(GOOD.description)).toBe(true);
    expect(body).toContain("jen (jen@example.test)");
    expect(body).toContain("/ugc/proj-1");
    expect(body).toContain("| Build |");
    expect(body).toContain(`| Schema | ${EXPECTED_DB_VERSION} |`);
  });

  it("says DRIFT in the report when the database is behind the code", async () => {
    // A database behind the code is the shape of a deploy that landed ahead
    // of its migration — a bug report's answer rather than another question.
    // Any version that is not the expected one will do; the point is the
    // mismatch, not the number.
    appliedVersion = "0001";
    const { submitIssue } = await import("./report-issue");

    await submitIssue(form(GOOD));

    expect(createIssue.mock.calls[0]![0].body).toContain(
      `${EXPECTED_DB_VERSION} expected, 0001 applied — DRIFT`,
    );
  });

  it("refuses a description too short to act on, without calling GitHub", async () => {
    const { submitIssue } = await import("./report-issue");

    const result = await submitIssue(form({ ...GOOD, description: "broken" }));

    expect(result.error).toMatch(/more detail/i);
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("checks configuration before spending one of the three", async () => {
    // A misconfigured deployment must not burn somebody's hourly allowance
    // on reports that were never going anywhere.
    issueReportingConfigured.mockReturnValue(false);
    const { submitIssue } = await import("./report-issue");

    const result = await submitIssue(form(GOOD));

    expect(result.error).toMatch(/not set up on this deployment/i);
    expect(insert).not.toHaveBeenCalled();
  });

  it("hands back the existing link when the same report arrives twice", async () => {
    const { submitIssue } = await import("./report-issue");
    await submitIssue(form(GOOD));
    const hash = insert.mock.calls[0]![0].body_hash;

    recentRows = [
      { body_hash: hash, created_at: new Date().toISOString(), issue_url: "https://x/1" },
    ];
    createIssue.mockClear();

    const result = await submitIssue(form(GOOD));

    expect(result.error).toMatch(/already sent/i);
    expect(result.issueUrl).toBe("https://x/1");
    expect(createIssue, "a duplicate must not reach GitHub").not.toHaveBeenCalled();
  });

  it("stops at three in an hour", async () => {
    const now = new Date().toISOString();
    recentRows = [
      { body_hash: "a", created_at: now, issue_url: null },
      { body_hash: "b", created_at: now, issue_url: null },
      { body_hash: "c", created_at: now, issue_url: null },
    ];
    const { submitIssue } = await import("./report-issue");

    const result = await submitIssue(form(GOOD));

    expect(result.error).toMatch(/3 reports this hour/);
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("lets the report through when the rate-limit read itself fails", async () => {
    // FAILING OPEN on purpose: an unreadable table is not evidence of a
    // flood, and refusing a bug report because the database hiccuped is the
    // app losing the only channel it has for being told it is broken.
    recentError = { message: "connection reset" };
    const { submitIssue } = await import("./report-issue");

    const result = await submitIssue(form(GOOD));

    expect(result.issueNumber).toBe(7);
  });

  it("records the attempt even when GitHub refuses, and says why", async () => {
    // A row with no issue_number is how we find out the token expired
    // without waiting for someone to mention it.
    createIssue.mockResolvedValue({ error: "GitHub refused the report (HTTP 401)." });
    const { submitIssue } = await import("./report-issue");

    const result = await submitIssue(form(GOOD));

    expect(result.error).toMatch(/HTTP 401/);
    expect(insert.mock.calls[0]![0]).toMatchObject({ issue_number: null, issue_url: null });
  });
});
