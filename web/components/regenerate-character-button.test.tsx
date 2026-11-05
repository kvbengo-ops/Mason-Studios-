// @vitest-environment jsdom
//
// This control had no test at all, and it is one of the two paid image calls
// on the Setup screens — the other being Product's "Regenerate Combined". Two
// things about it are load-bearing and neither was pinned:
//
//   1. The price is written INTO the label ("Regenerate ($0.04)"). The button
//      must keep saying it while the call runs, because that is exactly when
//      the operator is waiting to find out what they agreed to spend. It used
//      to swap the whole label for "Regenerating…".
//   2. The call is multi-second and the operator is free to walk to another
//      Setup screen while it runs, at which point this card is gone and the
//      rail is the only thing left that can say the work is still going.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JSX } from "react";
import { RegenerateCharacterButton } from "./regenerate-character-button";
import { ProjectRail, RailBusyProvider } from "@/components/project-rail";
import { RAIL_ENTRY_CHARACTER } from "@/lib/project-rail";
import type { RailModel } from "@/lib/project-rail-types";
import type { ActionResult } from "@/lib/action-result";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/1/character",
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/actions/brief", () => ({ addScene: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

afterEach(cleanup);

const RAIL: RailModel = {
  projectId: "proj-1",
  readOnly: false,
  projectTitle: "Kinoko Coffee",
  projectSubtitle: "2 scenes",
  backHref: "/projects",
  groups: [
    {
      id: "setup",
      label: "Setup",
      entries: [
        {
          id: RAIL_ENTRY_CHARACTER,
          label: "Character",
          status: "done",
          href: "/projects/1/character",
        },
      ],
    },
  ],
};

function withRail(node: JSX.Element): JSX.Element {
  return (
    <RailBusyProvider>
      {node}
      <ProjectRail model={RAIL} />
    </RailBusyProvider>
  );
}

/** The rail row's own ring, scoped away from any ring inside the button. */
function railSpinning(): boolean {
  const rail = screen.getByLabelText("Project navigation");
  return rail.querySelector("svg.animate-spin") !== null;
}

describe("RegenerateCharacterButton", () => {
  it("keeps the price on the label while the call runs, and shows the ring beside it", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => {};
    const action = vi.fn(
      () =>
        new Promise<ActionResult>((resolve) => {
          settle = () => resolve(undefined);
        }),
    );

    render(
      withRail(
        <RegenerateCharacterButton
          action={action}
          disabled={false}
          costLabel="$0.04"
          libraryCharacterName={null}
        />,
      ),
    );

    const button = screen.getByRole("button", { name: /regenerate/i });
    expect(button.textContent).toContain("$0.04");

    await user.click(button);

    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    // Both at once: the number the operator is committing to, and the ring
    // that says it is happening.
    expect(button.textContent).toContain("$0.04");
    expect(button.querySelector("svg.animate-spin")).not.toBeNull();

    // The disable is the real double-charge guard, not the ring.
    await user.click(button);
    expect(action).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle();
    });
  });

  it("spins the Character row in the rail for as long as the call runs", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => {};
    const action = vi.fn(
      () =>
        new Promise<ActionResult>((resolve) => {
          settle = () => resolve(undefined);
        }),
    );

    render(
      withRail(
        <RegenerateCharacterButton
          action={action}
          disabled={false}
          costLabel="$0.04"
          libraryCharacterName={null}
        />,
      ),
    );
    expect(railSpinning()).toBe(false);

    await user.click(screen.getByRole("button", { name: /regenerate/i }));
    await waitFor(() => expect(railSpinning()).toBe(true));

    await act(async () => {
      settle();
    });
    await waitFor(() => expect(railSpinning()).toBe(false));
  });

  it("draws the ring on the confirmation's Replace button too, for a photo picked from the library", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => {};
    const action = vi.fn(
      () =>
        new Promise<ActionResult>((resolve) => {
          settle = () => resolve(undefined);
        }),
    );

    render(
      withRail(
        <RegenerateCharacterButton
          action={action}
          disabled={false}
          costLabel="$0.04"
          libraryCharacterName="Mika"
        />,
      ),
    );

    // The destructive gate: a library photo is replaced, not refreshed.
    await user.click(screen.getByRole("button", { name: /replace mika/i }));
    const dialog = screen.getByRole("dialog");
    const replace = within(dialog).getByRole("button", { name: /^replace$/i });

    await user.click(replace);
    await waitFor(() => expect((replace as HTMLButtonElement).disabled).toBe(true));
    expect(replace.querySelector("svg.animate-spin")).not.toBeNull();
    expect(railSpinning()).toBe(true);

    await act(async () => {
      settle();
    });
  });
});
