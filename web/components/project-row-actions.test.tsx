// @vitest-environment jsdom
//
// Covers the owner-only project actions and RenameProjectDialog wiring. The
// dialog's own submit/error/no-op behaviour is exercised in
// rename-project-dialog.test.tsx — this file only has to prove the menu
// wires the two together: the item exists above Duplicate, it's absent for
// a row the viewer doesn't own (same as Delete), and selecting it opens an
// input seeded with the project's title.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectRowActions } from "./project-row-actions";
import { duplicateProject } from "@/actions/project";

vi.mock("@/actions/project", () => ({
  duplicateProject: vi.fn(),
  renameProject: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.mocked(duplicateProject).mockReset();
});

describe("ProjectRowActions", () => {
  it("lists Rename above Duplicate, and Delete, for a row the viewer owns", async () => {
    const user = userEvent.setup();
    render(<ProjectRowActions projectId="project-1" projectTitle="NeuroBlast Q4" canDelete />);

    await user.click(screen.getByRole("button", { name: /actions for neuroblast q4/i }));

    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(items.indexOf("Rename")).toBeGreaterThanOrEqual(0);
    expect(items.indexOf("Rename")).toBeLessThan(items.indexOf("Duplicate"));
    expect(items).toContain("Delete");
    expect(items).toContain("Download project ZIP");
    expect(
      screen.getByRole("menuitem", { name: /download project zip/i }).getAttribute("href"),
    ).toBe("/api/projects/project-1/archive?scope=project");
  });

  it("hides Rename (along with Delete) for a row the viewer doesn't own, same gate as canDelete", async () => {
    const user = userEvent.setup();
    render(
      <ProjectRowActions projectId="project-1" projectTitle="NeuroBlast Q4" canDelete={false} />,
    );

    await user.click(screen.getByRole("button", { name: /actions for neuroblast q4/i }));

    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /download project zip/i })).toBeNull();
  });

  it("selecting Rename opens a dialog with an input prefilled with the current title", async () => {
    const user = userEvent.setup();
    render(<ProjectRowActions projectId="project-1" projectTitle="NeuroBlast Q4" canDelete />);

    await user.click(screen.getByRole("button", { name: /actions for neuroblast q4/i }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));

    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByRole("textbox", { name: /project title/i });
    expect((input as HTMLInputElement).value).toBe("NeuroBlast Q4");
  });
});
