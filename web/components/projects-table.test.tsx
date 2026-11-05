// @vitest-environment jsdom
//
// Covers the /projects table and its per-row "…" menu.
// "@/actions/project" is mocked for the
// same reason scene-table.test.tsx mocks "@/actions/brief": the real module
// pulls in Supabase/next/headers machinery that throws outside a request.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectsTable } from "./projects-table";
import type { ProjectTableRow } from "./projects-table";
import { deleteProject, duplicateProject } from "@/actions/project";
import { DEFAULT_SORT } from "@/lib/projects-url";

vi.mock("@/actions/project", () => ({
  duplicateProject: vi.fn(async () => undefined),
  deleteProject: vi.fn(async () => undefined),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Radix's DropdownMenu drives its trigger through the Pointer Events
// capture API, which jsdom doesn't implement — opening a row's "…" menu
// throws before any assertion runs without these stubs. Same fix as
// scene-table.test.tsx's identical block; nothing below asserts on capture.
for (const method of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"] as const) {
  if (!(method in Element.prototype)) {
    Object.defineProperty(Element.prototype, method, { value: () => false, writable: true });
  }
}
if (!("scrollIntoView" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "scrollIntoView", { value: () => {}, writable: true });
}

afterEach(() => {
  cleanup();
  vi.mocked(duplicateProject).mockReset();
  vi.mocked(duplicateProject).mockResolvedValue(undefined);
  vi.mocked(deleteProject).mockReset();
  vi.mocked(deleteProject).mockResolvedValue(undefined);
});

function row(overrides: Partial<ProjectTableRow> = {}): ProjectTableRow {
  return {
    id: "project-1",
    title: "NeuroBlast Q4",
    ownerEmail: "owner@yopmail.com",
    sceneCount: 3,
    costLabel: "246 cr",
    canDelete: true,
    thumbnailUrl: null,
    readySceneCount: 1,
    updatedAtLabel: "Aug 22, 2026, 3:45 PM",
    costSecondaryLabel: null,
    kind: "scripted",
    ...overrides,
  };
}

function renderTable(
  projects: ProjectTableRow[],
  showOwnerColumn = false,
): ReturnType<typeof render> {
  return render(
    <ProjectsTable
      projects={projects}
      showOwnerColumn={showOwnerColumn}
      sort={DEFAULT_SORT}
      q=""
      pageSize={20}
      ownerFilter={showOwnerColumn ? "everyone" : "mine"}
    />,
  );
}

it("does not render selection checkboxes or bulk actions", () => {
  renderTable([row({ id: "p1", title: "Alpha" })]);

  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete selected" })).toBeNull();
});

describe("ProjectsTable — sort headers carry the active filters forward", () => {
  it("a sort-header click's href includes the active status/owner filter, not just sort/q/size", () => {
    render(
      <ProjectsTable
        projects={[row({ id: "p1" })]}
        showOwnerColumn={false}
        sort={DEFAULT_SORT}
        q="neuro"
        pageSize={20}
        statusFilter="framed"
        ownerFilter="everyone"
      />,
    );

    const titleHeaderLink = screen.getByRole("link", { name: /Project/ });
    const href = titleHeaderLink.getAttribute("href") ?? "";
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("status")).toBe("framed");
    expect(params.get("owner")).toBe("everyone");
    expect(params.get("q")).toBe("neuro");
  });

  // Negative control: omitting the filters (the old call signature, still
  // used by every other test in this file) must NOT leave status/owner in
  // the href — proves the assertion above is reading real filter state,
  // not a hardcoded string every sort link happens to contain.
  it("negative control — no status/owner param at all when neither filter is active", () => {
    render(
      <ProjectsTable
        projects={[row({ id: "p1" })]}
        showOwnerColumn={false}
        sort={DEFAULT_SORT}
        q=""
        pageSize={20}
      />,
    );

    const titleHeaderLink = screen.getByRole("link", { name: /Project/ });
    const href = titleHeaderLink.getAttribute("href") ?? "";
    expect(href).not.toContain("status=");
    expect(href).not.toContain("owner=");
  });
});

describe("ProjectsTable — Owner column truncation", () => {
  it("keeps the full owner email reachable via title= once the cell truncates it visually", () => {
    renderTable(
      [
        row({
          id: "p1",
          title: "Alpha",
          ownerEmail: "a.very.long.owner.address.for.this.team@example-company.com",
        }),
      ],
      true,
    );

    const cell = screen
      .getByText("a.very.long.owner.address.for.this.team@example-company.com")
      .closest("td");
    expect(cell?.getAttribute("title")).toBe(
      "a.very.long.owner.address.for.this.team@example-company.com",
    );
  });

  // Negative control: a row with no owner email at all must NOT carry a
  // stale/placeholder title — proves the assertion above reads the real
  // per-row email, not a hardcoded attribute every Owner cell gets.
  it("negative control — no owner email means no title attribute, not an empty or placeholder one", () => {
    renderTable([row({ id: "p1", title: "Alpha", ownerEmail: null })], true);

    const cell = screen.getByText("—").closest("td");
    expect(cell?.hasAttribute("title")).toBe(false);
  });
});

describe("ProjectsTable — thumbnail-first themed rows", () => {
  it("renders the thumbnail, progress ratio, updated label, and credits without a redundant Open action", () => {
    renderTable([
      row({
        thumbnailUrl: "https://example.test/project.jpg",
        readySceneCount: 2,
        sceneCount: 3,
        costSecondaryLabel: "$1.23",
      }),
    ]);

    expect(document.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.test/project.jpg",
    );
    expect(screen.getByLabelText("Progress: 2 of 3 scenes")).toBeTruthy();
    expect(screen.getByText("2/3")).toBeTruthy();
    expect(screen.getByText("Aug 22, 2026, 3:45 PM")).toBeTruthy();
    expect(screen.getByText("246 cr")).toBeTruthy();
    expect(screen.getByText("$1.23")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open" })).toBeNull();
  });

  it("uses the themed placeholder when a thumbnail is absent and falls back after an image error", () => {
    renderTable([row({ thumbnailUrl: "https://example.test/broken.jpg", title: "Alpha" })]);

    const image = document.querySelector("img");
    expect(image).not.toBeNull();
    fireEvent.error(image as HTMLImageElement);
    expect(document.querySelector("[data-project-thumbnail-placeholder]")).toBeTruthy();
  });

  it("hides Owner in the Mine view while retaining it for Everyone", () => {
    const { rerender } = render(
      <ProjectsTable projects={[row()]} showOwnerColumn sort={DEFAULT_SORT} q="" pageSize={20} />,
    );
    expect(screen.queryByRole("columnheader", { name: /Owner/ })).toBeNull();

    rerender(
      <ProjectsTable
        projects={[row()]}
        showOwnerColumn
        ownerFilter="everyone"
        sort={DEFAULT_SORT}
        q=""
        pageSize={20}
      />,
    );
    expect(screen.getByRole("columnheader", { name: /Owner/ })).toBeTruthy();
  });
});

// 0064_project_kind.sql / 0067_project_directory_kind.sql: the title link
// used to be hard-coded to one route for every row (either always
// /projects/<id>, or — the regression this guards — always /ugc/<id>).
// Both are wrong for half of any workspace that has both project kinds in
// it, so this asserts the branch itself, not just one side of it.
describe("ProjectsTable — title link routes on kind", () => {
  it("opens the clip console for a clip project", () => {
    renderTable([row({ id: "p1", title: "Clip project", kind: "clip" })]);

    const link = screen.getByRole("link", { name: "Clip project" });
    expect(link.getAttribute("href")).toBe("/ugc/p1");
  });

  it("opens the wizard overview for a scripted project", () => {
    renderTable([row({ id: "p1", title: "Scripted project", kind: "scripted" })]);

    const link = screen.getByRole("link", { name: "Scripted project" });
    expect(link.getAttribute("href")).toBe("/projects/p1");
  });
});

describe("ProjectsTable — per-row actions menu", () => {
  it("offers Duplicate and Delete for a deletable row", async () => {
    const user = userEvent.setup();
    renderTable([row({ id: "p1", title: "Alpha" })]);

    await user.click(screen.getByRole("button", { name: "Actions for Alpha" }));

    expect(screen.getByRole("menuitem", { name: "Duplicate" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
  });

  it("omits Delete from the menu for a row the viewer doesn't own", async () => {
    const user = userEvent.setup();
    renderTable([row({ id: "p1", title: "Alpha", canDelete: false })]);

    await user.click(screen.getByRole("button", { name: "Actions for Alpha" }));

    expect(screen.getByRole("menuitem", { name: "Duplicate" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
  });
});
