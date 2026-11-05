import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIssue, issueReportingConfigured, issueRepo } from "@/lib/github-issues";

const REPO = "acme/app";

describe("createIssue", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_ISSUE_TOKEN", "ghp_fake");
    vi.stubEnv("GITHUB_ISSUE_REPO", REPO);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("posts to the configured repo and hands back where the issue went", async () => {
    // Typed with the two arguments the code actually passes, so reading
    // them back below needs no cast — a cast here would hide the day the
    // call shape changes.
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ number: 42, html_url: "https://github.com/acme/app/issues/42" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createIssue({ title: "Generate does nothing", body: "It just sits." });

    expect(result).toEqual({ number: 42, url: "https://github.com/acme/app/issues/42" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://api.github.com/repos/${REPO}/issues`);
    // The labels are ours, not the reporter's: a label an editor can set is
    // a label nobody trusts for triage.
    expect(JSON.parse(String(init.body))).toMatchObject({
      title: "Generate does nothing",
      labels: ["from-app", "needs-triage"],
    });
  });

  it("surfaces GitHub's own words when it refuses", async () => {
    // "Bad credentials" and "Issues are disabled for this repo" need
    // different people to fix them, and a generic "could not file" tells
    // neither of them anything.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({ message: "Bad credentials" }),
      })),
    );

    const result = await createIssue({ title: "x", body: "y" });

    expect(result).toEqual({ error: "GitHub refused the report (HTTP 401 — Bad credentials)." });
  });

  it("survives an error body that is not JSON", async () => {
    // A proxy page or a rate-limit HTML is still a failure; the status alone
    // is what can honestly be said about it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error("not json");
        },
      })),
    );

    const result = await createIssue({ title: "x", body: "y" });

    expect(result).toEqual({ error: "GitHub refused the report (HTTP 502)." });
  });

  it("names the network as the network when the request never lands", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND api.github.com");
      }),
    );

    const result = await createIssue({ title: "x", body: "y" });

    expect(result).toEqual({
      error: "Could not reach GitHub: getaddrinfo ENOTFOUND api.github.com",
    });
  });

  it("refuses to claim success when the response says nothing useful", async () => {
    // A 200 with no number is not an issue anyone can go and read.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));

    const result = await createIssue({ title: "x", body: "y" });

    expect(result).toEqual({
      error: "GitHub accepted the report but did not say where it went.",
    });
  });

  it("does not call GitHub at all when it is not configured", async () => {
    vi.stubEnv("GITHUB_ISSUE_TOKEN", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await createIssue({ title: "x", body: "y" });

    expect(result).toEqual({ error: "Reporting is not configured on this deployment." });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("issueReportingConfigured", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("needs both a token and an owner/repo", () => {
    vi.stubEnv("GITHUB_ISSUE_TOKEN", "ghp_fake");
    vi.stubEnv("GITHUB_ISSUE_REPO", REPO);
    expect(issueReportingConfigured()).toBe(true);
    expect(issueRepo()).toBe(REPO);

    vi.stubEnv("GITHUB_ISSUE_REPO", "app");
    expect(issueReportingConfigured(), "a repo with no owner is not a repo").toBe(false);

    vi.stubEnv("GITHUB_ISSUE_REPO", REPO);
    vi.stubEnv("GITHUB_ISSUE_TOKEN", "");
    expect(issueReportingConfigured()).toBe(false);
  });
});
