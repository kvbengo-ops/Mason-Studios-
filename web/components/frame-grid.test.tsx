// @vitest-environment jsdom
//
// The reported symptom, verbatim: "the operator still has to refresh the
// browser to see a frame's new status." It was true, and the cause was not
// that nothing revalidated — generateFrames does, once, at the very end of
// the whole batch. Each frame's asset row is written the moment THAT frame
// lands, so a three-scene batch spent a minute showing nothing and then
// changed everything at once. Refreshing on a timer while a generate is open
// is what turns that into three frames arriving one at a time.
//
// The second half is the rail: a batch outlives the operator's patience for
// standing on this screen, and the scene rows are the only thing that
// follows them to another one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JSX } from "react";
import { FrameGrid, type FrameGridScene } from "./frame-grid";
import { ProjectRail, RailBusyProvider } from "@/components/project-rail";
import { generateFrames, updateScenePromptAndRegenerate } from "@/actions/frames";
import type { RailModel } from "@/lib/project-rail-types";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/p1/frames",
  useRouter: () => ({ refresh }),
}));
vi.mock("@/actions/frames", () => ({
  generateFrames: vi.fn(),
  updateScenePromptAndRegenerate: vi.fn(),
}));
vi.mock("@/actions/brief", () => ({ updateScenePrompt: vi.fn(), addScene: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const SCENES: FrameGridScene[] = [
  {
    id: "scene-1",
    idx: 0,
    video_prompt: "A woman lifts the cup",
    is_talking_head: true,
    status: "draft",
    imageUrl: null,
    originalImageUrl: null,
  },
  {
    id: "scene-2",
    idx: 1,
    video_prompt: "The cup on the counter",
    is_talking_head: false,
    status: "draft",
    imageUrl: null,
    originalImageUrl: null,
  },
];

const RAIL: RailModel = {
  projectId: "proj-1",
  readOnly: false,
  projectTitle: "Kinoko Coffee",
  projectSubtitle: "2 scenes",
  backHref: "/projects",
  groups: [
    {
      id: "scenes",
      label: "Scenes",
      entries: [
        { id: "scene-1", label: "1 · A-roll", status: "idle", href: "/projects/p1/scenes/1" },
        { id: "scene-2", label: "2 · B-roll", status: "idle", href: "/projects/p1/scenes/2" },
      ],
    },
  ],
};

function renderGrid(): void {
  render(
    <RailBusyProvider>
      <FrameGrid projectId="p1" initialScenes={SCENES} refFrameCostUsd={0.02} />
      <ProjectRail model={RAIL} />
    </RailBusyProvider>,
  );
}

/** Rings inside the rail only — the cards draw their own while generating. */
function railSpinners(): number {
  return screen.getByLabelText("Project navigation").querySelectorAll("svg.animate-spin").length;
}

beforeEach(() => {
  refresh.mockClear();
  vi.mocked(generateFrames).mockReset();
  vi.mocked(updateScenePromptAndRegenerate).mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("FrameGrid — keeping itself current while frames are generating", () => {
  it("re-asks the server on a timer while a batch is open, so frames appear as they land", async () => {
    vi.useFakeTimers();
    let settle: () => void = () => {};
    vi.mocked(generateFrames).mockReturnValue(
      new Promise((resolve) => {
        settle = () => resolve({ succeeded: ["scene-1", "scene-2"], failed: [] });
      }),
    );

    renderGrid();
    // Idle: nothing is polled at all. Without this the assertion below
    // passes on a component that refreshes forever.
    act(() => void vi.advanceTimersByTime(30_000));
    expect(refresh).not.toHaveBeenCalled();

    // fireEvent, not userEvent: userEvent's own internal delays have to be
    // hand-fed the fake clock, and getting that wrong hangs the test rather
    // than failing it. A click is all this needs.
    fireEvent.click(screen.getByRole("button", { name: /generate all frames/i }));
    await act(async () => {});

    act(() => void vi.advanceTimersByTime(12_000));
    expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(2);

    await act(async () => {
      settle();
    });
    const duringBatch = refresh.mock.calls.length;

    // And it stops. A screen that keeps re-rendering the route after the
    // work is done is the same bug pointed the other way.
    act(() => void vi.advanceTimersByTime(30_000));
    expect(refresh.mock.calls.length).toBe(duringBatch);
  });

  it("spins each generating scene's own rail row, and clears them when the batch settles", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => {};
    vi.mocked(generateFrames).mockReturnValue(
      new Promise((resolve) => {
        settle = () => resolve({ succeeded: ["scene-1", "scene-2"], failed: [] });
      }),
    );

    renderGrid();
    expect(railSpinners()).toBe(0);

    await user.click(screen.getByRole("button", { name: /generate all frames/i }));
    // Both scenes, not one: generateFrames takes the whole missing set, and
    // a rail that lit only the first would say the rest were not started.
    await waitFor(() => expect(railSpinners()).toBe(2));

    await act(async () => {
      settle();
    });
    await waitFor(() => expect(railSpinners()).toBe(0));
  });

  it("spins only the one scene a single Regenerate press is paying for", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => {};
    vi.mocked(updateScenePromptAndRegenerate).mockReturnValue(
      new Promise((resolve) => {
        settle = () => resolve(undefined);
      }),
    );

    renderGrid();
    const regenButtons = screen.getAllByRole("button", { name: /regenerate frame/i });
    await user.click(regenButtons[0]!);

    await waitFor(() => expect(railSpinners()).toBe(1));

    await act(async () => {
      settle();
    });
    await waitFor(() => expect(railSpinners()).toBe(0));
  });
});

describe("FrameGrid — the batch button", () => {
  it("keeps its price while the batch runs and draws the ring beside it", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => {};
    vi.mocked(generateFrames).mockReturnValue(
      new Promise((resolve) => {
        settle = () => resolve({ succeeded: [], failed: [] });
      }),
    );

    renderGrid();
    const button = screen.getByRole("button", { name: /generate all frames/i });
    // Two missing scenes at $0.02.
    expect(button.textContent).toContain("$0.04");

    await user.click(button);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    expect(button.textContent).toContain("$0.04");
    expect(button.querySelector("svg.animate-spin")).not.toBeNull();

    await act(async () => {
      settle();
    });
  });
});

// Kept out of the describes above: this is a type-level reminder that the
// grid renders nothing interactive for a read-only viewer.
function _readOnlyStillCompiles(): JSX.Element {
  return <FrameGrid projectId="p1" initialScenes={SCENES} refFrameCostUsd={0.02} readOnly />;
}
void _readOnlyStillCompiles;

// A placeholder is not an accessible name, and on this screen it is gone the
// moment there is text — which there always is. Named per card, not per
// screen: three fields all called "Video prompt" are as good as unnamed to
// anyone moving through them by keyboard.
describe("FrameGrid — a call that outlives the screen that started it", () => {
  it("keeps the rail lit and the card's paid button shut after a remount", async () => {
    // Same defect scene-workbench.tsx had. `scene.pending` is optimistic
    // state, so a grid that unmounts and remounts mid-generation comes back
    // with an idle-looking card and a live Regenerate button on a frame
    // that is still being generated — a second $0.02 for the same work.
    const user = userEvent.setup();
    let settle: () => void = () => {};
    vi.mocked(updateScenePromptAndRegenerate).mockReturnValue(
      new Promise((resolve) => {
        settle = () => resolve(undefined);
      }),
    );

    const { rerender } = render(
      <RailBusyProvider>
        <FrameGrid projectId="p1" initialScenes={SCENES} refFrameCostUsd={0.02} />
        <ProjectRail model={RAIL} />
      </RailBusyProvider>,
    );

    const buttons = screen.getAllByRole("button", { name: /regenerate frame/i });
    await user.click(buttons[0]!);
    await waitFor(() => expect(railSpinners()).toBe(1));

    // Away, and back — a brand new grid.
    rerender(
      <RailBusyProvider>
        <ProjectRail model={RAIL} />
      </RailBusyProvider>,
    );
    expect(railSpinners()).toBe(1);

    rerender(
      <RailBusyProvider>
        <FrameGrid projectId="p1" initialScenes={SCENES} refFrameCostUsd={0.02} />
        <ProjectRail model={RAIL} />
      </RailBusyProvider>,
    );

    const after = screen.getAllByRole("button", { name: /regenerate frame/i });
    expect((after[0] as HTMLButtonElement).disabled).toBe(true);
    // The card that was NOT generating is untouched — the store is keyed per
    // scene, and one busy frame must not freeze the whole grid.
    expect((after[1] as HTMLButtonElement).disabled).toBe(false);

    await user.click(after[0]!);
    expect(vi.mocked(updateScenePromptAndRegenerate)).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle();
    });
    await waitFor(() => expect(railSpinners()).toBe(0));
  });
});

describe("FrameGrid — what a generating card shows", () => {
  it("skeletons the frame and takes the spinner off the button", async () => {
    const user = userEvent.setup();
    vi.mocked(updateScenePromptAndRegenerate).mockReturnValue(new Promise(() => {}));

    render(
      <RailBusyProvider>
        <FrameGrid projectId="p1" initialScenes={SCENES} refFrameCostUsd={0.02} />
        <ProjectRail model={RAIL} />
      </RailBusyProvider>,
    );

    const buttons = screen.getAllByRole("button", { name: /regenerate frame/i });
    await user.click(buttons[0]!);

    await waitFor(() => expect(screen.getByLabelText("Generating frame for scene 1")).toBeTruthy());
    // One signal, not two — see the skeleton's own comment.
    const running = screen.getAllByRole("button", { name: /regenerate frame/i })[0]!;
    expect(running.querySelector("svg.animate-spin")).toBeNull();
    expect((running as HTMLButtonElement).disabled).toBe(true);
    // And only that card: the other scene is untouched.
    expect(screen.queryByLabelText("Generating frame for scene 2")).toBeNull();
  });
});

describe("FrameGrid — the batch and a single press together", () => {
  it("refuses the batch while a frame it would cover is already generating", async () => {
    // A scene that has never had a frame stays `missing` while its own
    // Regenerate is in flight — imageUrl is null until the new one lands —
    // so the batch would ask the server to generate it a second time.
    const user = userEvent.setup();
    vi.mocked(updateScenePromptAndRegenerate).mockReturnValue(new Promise(() => {}));

    render(
      <RailBusyProvider>
        <FrameGrid
          projectId="p1"
          initialScenes={SCENES.map((scene) => ({ ...scene, imageUrl: null }))}
          refFrameCostUsd={0.02}
        />
        <ProjectRail model={RAIL} />
      </RailBusyProvider>,
    );

    const batch = screen.getByRole("button", { name: /Generate all frames/i });
    expect(batch.hasAttribute("disabled")).toBe(false);

    await user.click(screen.getAllByRole("button", { name: /regenerate frame/i })[0]!);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Generate all frames/i }).hasAttribute("disabled"),
      ).toBe(true),
    );
    expect(vi.mocked(generateFrames)).not.toHaveBeenCalled();
  });
});

describe("FrameGrid — the prompt fields are named", () => {
  it("names each scene's prompt field by its scene number", () => {
    renderGrid();

    expect(screen.getByRole("textbox", { name: "Video prompt for scene 1" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Video prompt for scene 2" })).toBeTruthy();
  });
});
