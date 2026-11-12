// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/actions/account", () => ({
  setAccountRole: vi.fn(async () => undefined),
  demoteAdmin: vi.fn(async () => undefined),
}));

import { demoteAdmin, setAccountRole } from "@/actions/account";
import { ChangeRoleDialog, roleChoices } from "./change-role-dialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup(role: "editor" | "admin", overrides: { onPromoteToAdmin?: () => void } = {}) {
  const onOpenChange = vi.fn();
  const onPromoteToAdmin = overrides.onPromoteToAdmin ?? vi.fn();
  render(
    <ChangeRoleDialog
      userId="u-1"
      email="a@example.com"
      role={role}
      open
      onOpenChange={onOpenChange}
      onPromoteToAdmin={onPromoteToAdmin}
    />,
  );
  return { onOpenChange, onPromoteToAdmin };
}

describe("roleChoices", () => {
  it("lists every assignable role and Admin for an editor-tier row", () => {
    expect(roleChoices("editor")).toEqual([
      "editor",
      "trusted_editor",
      "hybrid_editor",
      "ai_animator",
      "admin",
    ]);
  });

  it("lists only the two demotions for an admin row", () => {
    expect(roleChoices("admin")).toEqual(["trusted_editor", "editor"]);
  });
});

describe("ChangeRoleDialog", () => {
  it("marks the current role and does not let it be picked", () => {
    setup("editor");
    const current = screen.getByRole("radio", { name: /^Newly onboarded/ }) as HTMLInputElement;
    expect(current.disabled).toBe(true);
    expect(screen.getByText("Current")).toBeTruthy();
  });

  it("keeps the button off until a role is picked", async () => {
    setup("editor");
    const button = screen.getByRole("button", { name: "Change role" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await userEvent.click(screen.getByRole("radio", { name: /AI Animator/ }));
    expect(button.disabled).toBe(false);
  });

  it("sets the picked role and closes", async () => {
    const { onOpenChange } = setup("editor");
    await userEvent.click(screen.getByRole("radio", { name: /Trusted editor/ }));
    await userEvent.click(screen.getByRole("button", { name: "Change role" }));
    expect(setAccountRole).toHaveBeenCalledWith("u-1", "trusted_editor");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("hands Admin to the promote confirmation without calling any role action", async () => {
    const { onOpenChange, onPromoteToAdmin } = setup("editor");
    await userEvent.click(screen.getByRole("radio", { name: /^Admin/ }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onPromoteToAdmin).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(setAccountRole).not.toHaveBeenCalled();
  });

  it("demotes an admin through demoteAdmin", async () => {
    setup("admin");
    await userEvent.click(screen.getByRole("radio", { name: /Trusted editor/ }));
    await userEvent.click(screen.getByRole("button", { name: "Change role" }));
    expect(demoteAdmin).toHaveBeenCalledWith("u-1", "trusted_editor");
    expect(setAccountRole).not.toHaveBeenCalled();
  });

  it("shows a lost-race error and stays open", async () => {
    vi.mocked(setAccountRole).mockResolvedValueOnce({ error: "Someone else changed this role." });
    const { onOpenChange } = setup("editor");
    await userEvent.click(screen.getByRole("radio", { name: /Hybrid Editor/ }));
    await userEvent.click(screen.getByRole("button", { name: "Change role" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Someone else changed this role.");
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
