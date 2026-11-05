import { describe, expect, it } from "vitest";
import {
  buildProjectsHref,
  DEFAULT_OWNER_FILTER,
  DEFAULT_SORT,
  SORT_COLUMN_TO_DB,
  parseOwnerFilter,
  parseStatusFilter,
} from "./projects-url";
import { DEFAULT_PAGE_SIZE } from "@/lib/pagination";

it("sorts the redesigned directory by real project activity by default", () => {
  expect(DEFAULT_SORT).toEqual({ column: "updated", direction: "desc" });
  expect(SORT_COLUMN_TO_DB.updated).toBe("updated_at");
  // Old shared URLs remain parseable because `created` stays allowlisted.
  expect(SORT_COLUMN_TO_DB.created).toBe("created_at");
});

describe("parseStatusFilter", () => {
  it("parses a real ProjectStatus value", () => {
    expect(parseStatusFilter("framed")).toBe("framed");
  });

  it("falls back to null (no filter) for a missing/unknown/stale value", () => {
    expect(parseStatusFilter(undefined)).toBeNull();
    expect(parseStatusFilter("")).toBeNull();
    expect(parseStatusFilter("drop_table")).toBeNull();
  });

  it("takes the first value of a repeated query key, matching parseSort/parsePage", () => {
    expect(parseStatusFilter(["rendering", "framed"])).toBe("rendering");
  });
});

describe("parseOwnerFilter", () => {
  it("parses 'everyone' explicitly", () => {
    expect(parseOwnerFilter("everyone")).toBe("everyone");
  });

  it("falls back to DEFAULT_OWNER_FILTER ('mine') for anything else, including a missing value", () => {
    expect(parseOwnerFilter(undefined)).toBe(DEFAULT_OWNER_FILTER);
    expect(parseOwnerFilter("mine")).toBe(DEFAULT_OWNER_FILTER);
    expect(parseOwnerFilter("literally-anyone")).toBe(DEFAULT_OWNER_FILTER);
  });
});

describe("buildProjectsHref — status/owner filters", () => {
  it("omits both params for the default (no status filter, 'mine')", () => {
    expect(buildProjectsHref("", 1, DEFAULT_SORT, DEFAULT_PAGE_SIZE, null, "mine")).toBe(
      "/projects",
    );
  });

  it("adds ?status= when a status filter is active", () => {
    expect(buildProjectsHref("", 1, DEFAULT_SORT, DEFAULT_PAGE_SIZE, "framed", "mine")).toBe(
      "/projects?status=framed",
    );
  });

  it("adds ?owner=everyone only when it differs from the default", () => {
    expect(buildProjectsHref("", 1, DEFAULT_SORT, DEFAULT_PAGE_SIZE, null, "everyone")).toBe(
      "/projects?owner=everyone",
    );
  });

  it("carries q/page/sort/size/status/owner together, same as every other param", () => {
    const href = buildProjectsHref(
      "neuro",
      2,
      { column: "cost", direction: "asc" },
      50,
      "rendering",
      "everyone",
    );
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("q")).toBe("neuro");
    expect(params.get("page")).toBe("2");
    expect(params.get("sort")).toBe("cost");
    expect(params.get("dir")).toBe("asc");
    expect(params.get("size")).toBe("50");
    expect(params.get("status")).toBe("rendering");
    expect(params.get("owner")).toBe("everyone");
  });

  // Negative control: prove the "omitted when default" assertion above can
  // actually fail — a filter that IS active must show up in the href, not
  // be silently dropped the way the default is.
  it("negative control — an active status filter is NOT omitted", () => {
    const href = buildProjectsHref("", 1, DEFAULT_SORT, DEFAULT_PAGE_SIZE, "delivered", "mine");
    expect(href).not.toBe("/projects");
    expect(href).toContain("status=delivered");
  });
});
