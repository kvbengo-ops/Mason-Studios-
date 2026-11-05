// @vitest-environment jsdom
//
// Covers the /projects list's owner filter row (app/(app)/projects/page.tsx
// via this component). The status pills it also used to hold were removed
// along with the table's Status column. The interesting behavior here is
// entirely about WHICH controls render for WHOM — the
// owner filter is admin-only (0002_rls.sql's projects_select already scopes
// a non-admin to their own rows, so the control would be a no-op that
// implies otherwise) — and that every link this component builds carries
// the filter state through `buildHref`, the same contract every other
// /projects control (search, sort, pager, size) already follows.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ProjectFilters } from "./project-filters";

afterEach(() => {
  cleanup();
});

function noopBuildHref(status: string | null, owner: string): string {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (owner !== "mine") params.set("owner", owner);
  const qs = params.toString();
  return qs ? `/projects?${qs}` : "/projects";
}

describe("ProjectFilters — the status pills are gone", () => {
  // Removed with the table's Status column: the six-state vocabulary these
  // filtered on (Draft/Briefed/Framed/Rendering/Complete/Delivered) belongs to
  // the scripted brief-to-cut pipeline, and a /ugc clip project passing
  // through it reads as a stage it was never in. This is the assertion that
  // stops them being reintroduced by a merge that does not know that.
  it("renders no status pill, not even All", () => {
    render(
      <ProjectFilters ownerFilter="mine" showOwnerFilter={false} buildHref={noopBuildHref} />,
    );

    for (const gone of ["All", "Draft", "Briefed", "Framed", "Rendering", "Complete", "Delivered"]) {
      expect(screen.queryByRole("link", { name: gone }), `${gone} pill came back`).toBeNull();
    }
  });

  // A bookmarked ?status= still narrows the list on arrival, and with no pill
  // on screen nothing would say so. The owner toggle drops it on the first
  // click rather than carrying it forward invisibly.
  it("does not carry a lingering status filter into the owner links", () => {
    render(
      <ProjectFilters
        statusFilter="framed"
        ownerFilter="mine"
        showOwnerFilter
        buildHref={noopBuildHref}
      />,
    );

    expect(screen.getByRole("link", { name: "Everyone" }).getAttribute("href")).toBe(
      "/projects?owner=everyone",
    );
  });
});

describe("ProjectFilters — owner filter (admin-only)", () => {
  it("does not render Mine/Everyone at all when showOwnerFilter is false", () => {
    render(
      <ProjectFilters
        statusFilter={null}
        ownerFilter="mine"
        showOwnerFilter={false}
        buildHref={noopBuildHref}
      />,
    );

    expect(screen.queryByRole("group", { name: "Filter by owner" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Everyone" })).toBeNull();
  });

  it("renders Mine/Everyone when showOwnerFilter is true", () => {
    render(
      <ProjectFilters
        statusFilter={null}
        ownerFilter="mine"
        showOwnerFilter={true}
        buildHref={noopBuildHref}
      />,
    );

    expect(screen.getByRole("link", { name: "Mine" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Everyone" })).toBeTruthy();
  });

  // Negative control for the "does not render" assertion above: prove the
  // query actually finds the control when it's supposed to be there, so the
  // `false` case isn't just a query that never matches anything.
  it("negative control — the same query that finds nothing for a non-admin finds Everyone for an admin", () => {
    const { rerender } = render(
      <ProjectFilters
        statusFilter={null}
        ownerFilter="mine"
        showOwnerFilter={false}
        buildHref={noopBuildHref}
      />,
    );
    expect(screen.queryByRole("link", { name: "Everyone" })).toBeNull();

    rerender(
      <ProjectFilters
        statusFilter={null}
        ownerFilter="mine"
        showOwnerFilter={true}
        buildHref={noopBuildHref}
      />,
    );
    expect(screen.queryByRole("link", { name: "Everyone" })).not.toBeNull();
  });
});
