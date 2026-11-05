// @vitest-environment jsdom
//
// Script page — field isolation and Save wiring. Mirrors character-setup-
// form.test.tsx's own coverage for the Character page's split-off field.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ScriptSetupForm,
  ScriptDraftProvider,
  ScriptField,
  CompileAction,
  CompilePendingLabel,
  UnlocksForecast,
  SaveButton,
  forecastRollSplit,
  frameCostLabel,
} from "./script-setup-form";
import type { ActionResult } from "@/lib/action-result";
import { ProjectRail, RailBusyProvider } from "@/components/project-rail";
import type { RailModel } from "@/lib/project-rail-types";

// ProjectRail is rendered below to prove the compile reaches the rail, and
// it reads the router for the current-row highlight and its refresh loop.
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/1/script",
  useRouter: () => ({ refresh: vi.fn() }),
  unstable_rethrow: (e: unknown) => {
    throw e;
  },
}));

afterEach(() => {
  cleanup();
});

function renderScriptField(): ReturnType<typeof render> {
  return render(
    <ScriptSetupForm action={async () => undefined} fallbackErrorMessage="failed">
      <ScriptDraftProvider initialValue="">
        <ScriptField initialValue="" locked={false} initialIncludeVisualIdea={true} />
      </ScriptDraftProvider>
    </ScriptSetupForm>,
  );
}

describe("Script page — field isolation", () => {
  it("renders the script field, and no field from another split page", () => {
    renderScriptField();

    expect(screen.getByLabelText(/^script\b/i)).toBeTruthy();
    // Character page field.
    expect(screen.queryByLabelText(/describe your character/i)).toBeNull();
    // Product page fields.
    expect(screen.queryByLabelText(/^product name$/i)).toBeNull();
    expect(screen.queryByLabelText(/product appearance/i)).toBeNull();
  });
});

describe("Script page — Save posts through the script form", () => {
  it("submits script_raw to the bound action when Save is clicked", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async (_formData: FormData): Promise<ActionResult> => undefined);

    render(
      <ScriptSetupForm action={action} fallbackErrorMessage="failed">
        <ScriptDraftProvider initialValue="">
          <ScriptField initialValue="" locked={false} initialIncludeVisualIdea={true} />
          <SaveButton locked={false} />
        </ScriptDraftProvider>
      </ScriptSetupForm>,
    );

    await user.type(screen.getByLabelText(/^script\b/i), "Okay, I need to talk about this.");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(action).toHaveBeenCalledTimes(1);
    const submitted = action.mock.calls[0]?.[0] as FormData;
    expect(submitted.get("script_raw")).toBe("Okay, I need to talk about this.");
  });
});

function renderCompileAction({
  action,
  saveAction,
  initialValue = "",
}: {
  action: (formData: FormData) => Promise<ActionResult | void>;
  saveAction: (formData: FormData) => Promise<ActionResult | void>;
  initialValue?: string;
}): ReturnType<typeof render> {
  return render(
    <ScriptSetupForm action={async () => undefined} fallbackErrorMessage="failed">
      <ScriptDraftProvider initialValue={initialValue}>
        <ScriptField initialValue={initialValue} locked={false} initialIncludeVisualIdea={true} />
        <CompileAction
          action={action}
          saveAction={saveAction}
          label="Compile script"
          dirtyLabel="Save & compile"
          pendingLabel="Compiling…"
          fallbackErrorMessage="failed"
          projectId="project-1"
          initialCompilerModel="claude-sonnet-5"
        />
      </ScriptDraftProvider>
    </ScriptSetupForm>,
  );
}

describe("Script page — one action from typing to compiling", () => {
  it("saves the typed script BEFORE compiling, so the brief is never compiled from stale text", async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    const saveAction = vi.fn(async (formData: FormData): Promise<ActionResult> => {
      order.push(`save:${String(formData.get("script_raw"))}`);
      return undefined;
    });
    const action = vi.fn(async (): Promise<ActionResult> => {
      order.push("compile");
      return undefined;
    });

    renderCompileAction({ action, saveAction });

    await user.type(screen.getByLabelText(/^script\b/i), "Two cups and my hands would shake.");
    await user.click(screen.getByRole("button", { name: /save & compile/i }));

    expect(order).toEqual(["save:Two cups and my hands would shake.", "compile"]);
  });

  it("does not compile when the pre-compile save fails — it would spend on the old script", async () => {
    const user = userEvent.setup();
    const saveAction = vi.fn(async (): Promise<ActionResult> => ({
      error: "Script cannot be empty.",
    }));
    const action = vi.fn(async (): Promise<ActionResult> => undefined);

    renderCompileAction({ action, saveAction });

    await user.type(screen.getByLabelText(/^script\b/i), "Two cups.");
    await user.click(screen.getByRole("button", { name: /save & compile/i }));

    expect(saveAction).toHaveBeenCalledTimes(1);
    expect(action).not.toHaveBeenCalled();
  });

  it("skips the save when nothing was typed — a clean form compiles what is already stored", async () => {
    const user = userEvent.setup();
    const saveAction = vi.fn(async (): Promise<ActionResult> => undefined);
    const action = vi.fn(async (): Promise<ActionResult> => undefined);

    renderCompileAction({ action, saveAction, initialValue: "Already saved." });

    await user.click(screen.getByRole("button", { name: /compile script/i }));

    expect(saveAction).not.toHaveBeenCalled();
    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe("Script page — the compile button carries its money", () => {
  it("names the compiler model and its price on the button itself", () => {
    renderCompileAction({
      action: async () => undefined,
      saveAction: async () => undefined,
      initialValue: "Already saved.",
    });

    const button = screen.getByRole("button", { name: /compile script/i });
    expect(button.textContent).toContain("Claude Sonnet 5");
    expect(button.textContent).toContain("$0.12");
  });
});

describe("Script page — the running compile shows elapsed time", () => {
  // Real timers here: advancing fake ones clears React's form-action pending
  // state, which unmounts the pending label before it can be read. This half
  // proves the clock is WIRED to the in-flight button; the CompilePendingLabel
  // block below proves it actually counts.
  it("puts a clock on the button the moment the compile goes in flight", async () => {
    let release: (() => void) | undefined;
    const action = vi.fn(
      (): Promise<void> =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    renderCompileAction({
      action,
      saveAction: async () => undefined,
      initialValue: "Already saved.",
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /compile script/i }));
    });

    // A spinner alone is what gets a paid action clicked twice — the running
    // button has to say how long it has been running, and still say what it
    // costs.
    const button = document.querySelector('button[type="submit"]');
    expect(button?.textContent).toContain("0:00");
    expect(button?.textContent).toContain("Claude Sonnet 5 · $0.12");
    expect(button?.hasAttribute("disabled")).toBe(true);

    release?.();
  });
});

describe("CompilePendingLabel", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts the seconds up while it stays mounted", async () => {
    vi.useFakeTimers();

    render(<CompilePendingLabel label="Compiling…" amount="Claude Sonnet 5 · $0.12" />);
    expect(screen.getByText("0:00")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(14_000);
    });
    expect(screen.getByText("0:14")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });
    expect(screen.getByText("1:15")).toBeTruthy();
  });
});

describe("forecastRollSplit", () => {
  it("counts a spoken line as A-roll and a visual-only beat as B-roll", () => {
    expect(
      forecastRollSplit([
        { script: "Two cups and my hands would shake.", visualIdea: null },
        { script: "", visualIdea: "Cutaway to the pouch on the counter" },
        { script: "This one, I just feel awake.", visualIdea: "Bathroom mirror" },
      ]),
    ).toEqual({ aRoll: 2, bRoll: 1 });
  });

  it("treats a whitespace-only script cell as a visual-only beat, not a spoken line", () => {
    expect(forecastRollSplit([{ script: "   ", visualIdea: "Product hero shot" }])).toEqual({
      aRoll: 0,
      bRoll: 1,
    });
  });
});

describe("frameCostLabel", () => {
  it("rounds a frame price UP to the cent — a quote may overstate, never understate", () => {
    // fal's REF_FRAME_COST_USD. $0.03 would be a lie in the cheap direction.
    expect(frameCostLabel(0.0398)).toBe("$0.04");
  });

  it("leaves an exact figure alone despite IEEE754 noise", () => {
    // kie's KIE_REF_FRAME_COST_USD: 0.02 * 100 is 2.0000000000000004.
    expect(frameCostLabel(0.02)).toBe("$0.02");
  });
});

describe("Script page — what the compile unlocks", () => {
  it("forecasts the A-roll/B-roll split and the per-frame price from the lines on screen", () => {
    render(
      <ScriptDraftProvider
        initialValue={"Two cups and my hands would shake.\n|Cutaway to the pouch\nI feel awake."}
      >
        <UnlocksForecast frameCostUsd={0.0398} />
      </ScriptDraftProvider>,
    );

    expect(screen.getByText("A-roll").parentElement?.textContent).toBe("A-roll~2");
    expect(screen.getByText("B-roll").parentElement?.textContent).toBe("B-roll~1");
    expect(screen.getAllByText(/frame · \$0\.04/)).toHaveLength(2);
  });

  it("shows nothing at all when there is no script to forecast from", () => {
    const { container } = render(
      <ScriptDraftProvider initialValue="">
        <UnlocksForecast frameCostUsd={0.0398} />
      </ScriptDraftProvider>,
    );

    expect(container.textContent).toBe("");
  });
});

// The rail ring was wired to the wrong flag: it followed the sub-second
// compiler-model save and stayed still through the ten-to-thirty-second
// compile — backwards, and a false "running" claim whenever someone merely
// changed the model. CompilePendingLabel is what React mounts while the
// compile form is pending, so its lifetime is the call's, and that is where
// the rail is reported from.
describe("the compile lights the Script row in the rail", () => {
  const model: RailModel = {
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
          { id: "setup-script", label: "Script", status: "idle", href: "/projects/1/script" },
        ],
      },
    ],
  };

  function spinning(): boolean {
    return document.querySelector("svg.animate-spin") !== null;
  }

  it("spins while the pending label is mounted", () => {
    render(
      <RailBusyProvider>
        <CompilePendingLabel label="Compiling…" amount="$0.12" />
        <ProjectRail model={model} />
      </RailBusyProvider>,
    );

    expect(spinning()).toBe(true);
  });

  it("leaves the row alone when nothing is compiling", () => {
    render(
      <RailBusyProvider>
        <ProjectRail model={model} />
      </RailBusyProvider>,
    );

    expect(spinning()).toBe(false);
  });
});
