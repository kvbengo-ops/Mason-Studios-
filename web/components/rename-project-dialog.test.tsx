// @vitest-environment jsdom
//
// renameProject returns an ActionResult rather than throwing/redirecting
// (see actions/project.ts's own doc comment on why title validation and
// ownership refusals come back as data, not a throw), so this dialog's
// error handling is simpler than DeleteProjectDialog's own — there's no
// notFound()/redirect() digest-sniffing to do here, just an `.error`
// branch and a catch for a genuine thrown failure. These tests pin: a
// successful rename closes the dialog, a returned error toasts and keeps
// it open, the input is prefilled with (and selects) the current title
// whenever the dialog opens, and Confirm disables the instant it's
// pressed so a second click can't fire a second rename.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { RenameProjectDialog } from "./rename-project-dialog";
import { renameProject } from "@/actions/project";

vi.mock("@/actions/project", () => ({
  renameProject: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.mocked(renameProject).mockReset();
  vi.mocked(toast.error).mockReset();
});

describe("RenameProjectDialog", () => {
  it("prefills the input with the current title and selects it", () => {
    render(
      <RenameProjectDialog
        open
        onOpenChange={vi.fn()}
        projectId="project-1"
        projectTitle="NeuroBlast Q4"
      />,
    );

    const input = screen.getByRole("textbox", { name: /project title/i }) as HTMLInputElement;
    expect(input.value).toBe("NeuroBlast Q4");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("NeuroBlast Q4".length);
  });

  it("calls renameProject and closes the dialog on a successful rename", async () => {
    const user = userEvent.setup();
    vi.mocked(renameProject).mockResolvedValue(undefined);
    const onOpenChange = vi.fn();

    render(
      <RenameProjectDialog
        open
        onOpenChange={onOpenChange}
        projectId="project-1"
        projectTitle="NeuroBlast Q4"
      />,
    );

    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByRole("textbox", { name: /project title/i });
    await user.clear(input);
    await user.type(input, "Q4 Refresh");
    await user.click(within(dialog).getByRole("button", { name: /^rename$/i }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(renameProject).toHaveBeenCalledWith("project-1", "Q4 Refresh");
  });

  it("toasts a returned error and keeps the dialog open, instead of silently doing nothing", async () => {
    const user = userEvent.setup();
    vi.mocked(renameProject).mockResolvedValue({ error: "Title is required." });
    const onOpenChange = vi.fn();

    render(
      <RenameProjectDialog
        open
        onOpenChange={onOpenChange}
        projectId="project-1"
        projectTitle="NeuroBlast Q4"
      />,
    );

    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByRole("textbox", { name: /project title/i });
    await user.clear(input);
    await user.click(within(dialog).getByRole("button", { name: /^rename$/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Title is required."));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("disables Confirm the instant it's pressed, and a second press before the first settles fires no second call", async () => {
    const user = userEvent.setup();
    let resolveRename: (value: undefined) => void = () => {};
    vi.mocked(renameProject).mockReturnValue(
      new Promise((resolve) => {
        resolveRename = resolve;
      }),
    );

    render(
      <RenameProjectDialog
        open
        onOpenChange={vi.fn()}
        projectId="project-1"
        projectTitle="NeuroBlast Q4"
      />,
    );

    const dialog = screen.getByRole("dialog");
    const confirmButton = within(dialog).getByRole("button", { name: /^rename$/i });

    await user.click(confirmButton);
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
    expect(confirmButton.querySelector("svg.animate-spin")).not.toBeNull();

    await user.click(confirmButton);
    expect(renameProject).toHaveBeenCalledTimes(1);

    resolveRename(undefined);
    await waitFor(() => expect((confirmButton as HTMLButtonElement).disabled).toBe(false));
  });

  it("submits on Enter without a surrounding form", async () => {
    const user = userEvent.setup();
    vi.mocked(renameProject).mockResolvedValue(undefined);
    const onOpenChange = vi.fn();

    render(
      <RenameProjectDialog
        open
        onOpenChange={onOpenChange}
        projectId="project-1"
        projectTitle="NeuroBlast Q4"
      />,
    );

    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByRole("textbox", { name: /project title/i });
    await user.clear(input);
    await user.type(input, "Renamed via Enter{Enter}");

    await waitFor(() =>
      expect(renameProject).toHaveBeenCalledWith("project-1", "Renamed via Enter"),
    );
  });

  it("Cancel calls onOpenChange(false) instead of owning its own open state", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <RenameProjectDialog
        open
        onOpenChange={onOpenChange}
        projectId="project-1"
        projectTitle="NeuroBlast Q4"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
