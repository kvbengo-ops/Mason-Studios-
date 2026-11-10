// @vitest-environment jsdom
//
// jsdom, not the suite default (see vitest.config.ts) — StatusIcon renders
// lucide icons which need a real DOM. Same reasoning as status-icon itself.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useTransition, type JSX } from "react";
import userEvent from "@testing-library/user-event";
import {
  ProjectRail,
  RailBusyProvider,
  RailBusyWhileSubmitting,
  useRailBusyWhile,
} from "./project-rail";
import { addScene } from "@/actions/brief";
import type { RailModel } from "@/lib/project-rail-types";

// usePathname is what tells the rail which entry is current — the layout that
// builds the model is a Server Component and has no pathname to stamp on.
// Driven directly here rather than by mounting a router.
let mockPathname = "/projects/1";
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ refresh }),
}));

// The rail's add-scene row calls the real server action, which pulls in the
// whole Supabase server stack — same mock components/scene-table.test.tsx uses
// for the same reason.
vi.mock("@/actions/brief", () => ({ addScene: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

beforeEach(() => {
  refresh.mockClear();
  vi.mocked(addScene).mockReset();
  vi.mocked(addScene).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  mockPathname = "/projects/1";
});

const MODEL: RailModel = {
  projectId: "proj-1",
  readOnly: false,
  projectTitle: "Test Project",
  projectSubtitle: "2 scenes · 12s · $4.17",
  backHref: "/projects",
  groups: [
    {
      id: "setup",
      label: "Setup",
      count: "1/2",
      entries: [
        {
          id: "character",
          label: "Character",
          status: "done",
          href: "/projects/123/character",
          active: false,
        },
        {
          id: "brief",
          label: "Brief",
          status: "idle",
          href: "/projects/123/brief",
          count: "2/3",
          active: true,
        },
      ],
    },
    {
      id: "scenes",
      label: "Scenes",
      entries: [
        {
          id: "scene-1",
          label: "Scene 1",
          status: "running",
          href: "/projects/123/scenes/1",
          count: "1/2",
        },
        {
          id: "scene-2",
          label: "Scene 2",
          status: "failed",
          href: "/projects/123/scenes/2",
        },
        {
          id: "scene-3",
          label: "Scene 3",
          status: "locked",
          href: null,
          lockedReason: "Finish Scene 2 first",
        },
      ],
    },
  ],
};

describe("ProjectRail", () => {
  describe("structure and labels", () => {
    it("renders every group label from the model", () => {
      render(<ProjectRail model={MODEL} />);

      // Test that group labels exist as headings
      for (const group of MODEL.groups) {
        // Group labels should be h3 elements
        const headings = screen.getAllByText(group.label);
        expect(headings.some((h) => h.tagName === "H3")).toBe(true);
      }
    });

    it("renders group counts next to labels when present", () => {
      render(<ProjectRail model={MODEL} />);

      // Setup group has count "1/2"
      const counts = screen.getAllByText("1/2");
      expect(counts.length).toBeGreaterThan(0);

      // Scenes group has no count, so counts appear for entries and setup label
      const allCounts = screen.getAllByText(/^\d+\/\d+$/);
      // Should have: Setup's 1/2, Brief's 2/3, Scene 1's 1/2
      expect(allCounts.length).toBeGreaterThanOrEqual(3);
    });

    it("renders every entry label from the model", () => {
      render(<ProjectRail model={MODEL} />);

      for (const group of MODEL.groups) {
        for (const entry of group.entries) {
          // For locked entries, the label is the lockedReason
          const expectedText =
            entry.status === "locked" ? (entry.lockedReason ?? "locked") : entry.label;
          expect(screen.getByText(expectedText)).toBeTruthy();
        }
      }
    });

    it("renders entry counts right-aligned when present", () => {
      render(<ProjectRail model={MODEL} />);

      // "Brief" entry has count "2/3"
      const briefLabel = screen.getByText("Brief");
      const briefRow = briefLabel.closest("a")!;
      expect(within(briefRow).getByText("2/3")).toBeTruthy();

      // "Scene 1" entry has count "1/2"
      const sceneLabel = screen.getByText("Scene 1");
      const sceneRow = sceneLabel.closest("a")!;
      expect(within(sceneRow).getByText("1/2")).toBeTruthy();

      // "Character" entry has no count
      const charLabel = screen.getByText("Character");
      const charRow = charLabel.closest("a")!;
      const charCounts = within(charRow).queryAllByText(/^\d+\/\d+$/);
      expect(charCounts).toHaveLength(0);
    });

    it("renders the back link using model.backHref", () => {
      render(<ProjectRail model={MODEL} />);

      const backLink = screen.getByRole("link", { name: "← Studio" });
      expect(backLink.getAttribute("href")).toBe("/projects");
    });

    it("renders project title and subtitle", () => {
      render(<ProjectRail model={MODEL} />);

      expect(screen.getByText("Test Project")).toBeTruthy();
      expect(screen.getByText("2 scenes · 12s · $4.17")).toBeTruthy();
    });
  });

  describe("entry links", () => {
    it("renders entry with non-null href as a link", () => {
      render(<ProjectRail model={MODEL} />);

      const characterLink = screen.getByRole("link", { name: /Character/i });
      expect(characterLink.getAttribute("href")).toBe("/projects/123/character");
    });

    it("renders entry with null href as plain text, not a link", () => {
      render(<ProjectRail model={MODEL} />);

      // Scene 3 is locked with null href
      const scene3Text = screen.getByText("Finish Scene 2 first");
      const scene3Row = scene3Text.closest("div");
      expect(scene3Row).toBeTruthy();

      // Verify it's not wrapped in a link
      const link = scene3Row!.closest("a");
      expect(link).toBeFalsy();
    });

    it("renders no link to /projects/123/scenes/3 for locked scene", () => {
      render(<ProjectRail model={MODEL} />);

      const sceneLinks = screen
        .getAllByRole("link")
        .filter((link) => link.getAttribute("href") === "/projects/123/scenes/3");
      expect(sceneLinks).toHaveLength(0);
    });
  });

  describe("locked entries", () => {
    it("is one row whose text IS the reason, with no label line above it", () => {
      render(<ProjectRail model={MODEL} />);

      // The reason REPLACES the label. Rendering both stacked them, so every
      // locked group was two lines tall to carry one fact — and the label it
      // repeated ("Scenes") was already the group heading directly above.
      // The width problem that first drove the label back in is solved on the
      // other side now, by keeping the sentence short enough to fit
      // (lib/project-rail.ts's SCRIPT_NOT_COMPILED_REASON).
      expect(screen.getByText("Finish Scene 2 first")).toBeTruthy();
      expect(screen.queryByText("Scene 3")).toBeNull();
    });

    it("falls back to the label for a locked row with no reason of its own", () => {
      // Cut, locked by the same gate the Scenes row above it already named.
      // It keeps its own name rather than echoing the sentence.
      const model: RailModel = {
        ...MODEL,
        groups: [
          {
            id: "cut",
            label: "Cut",
            dimmed: true,
            entries: [{ id: "cut-locked", label: "Final video", status: "locked", href: null }],
          },
        ],
      };

      render(<ProjectRail model={model} />);

      expect(screen.getByText("Final video")).toBeTruthy();
    });

    it("renders locked entries in muted style", () => {
      render(<ProjectRail model={MODEL} />);

      const lockedText = screen.getByText("Finish Scene 2 first");
      // The muted token, not the full class string: this used to pin every
      // spacing utility on the row, so a padding change failed a test about
      // colour. Assert the thing the test is named for.
      const lockedRow = lockedText.closest("div[class*='text-muted-foreground']");
      expect(lockedRow).toBeTruthy();
    });
  });

  describe("active entry", () => {
    it("renders active entry with aria-current page attribute", () => {
      render(<ProjectRail model={MODEL} />);

      // "Brief" entry has active: true
      const briefLink = screen.getByRole("link", { name: /Brief/i });
      expect(briefLink.getAttribute("aria-current")).toBe("page");
    });

    it("renders inactive entry without aria-current attribute", () => {
      render(<ProjectRail model={MODEL} />);

      // "Character" entry has active: false
      const charLink = screen.getByRole("link", { name: /Character/i });
      expect(charLink.getAttribute("aria-current")).toBeNull();
    });

    // The current row was a solid amber bar (bg-primary). It is a raised card
    // now — the treatment the design this rail was built from uses, and the
    // one that lets the green status disc keep its own colour instead of
    // fighting an amber field behind it.
    it("renders the current entry as a raised card, not a filled bar", () => {
      render(<ProjectRail model={MODEL} />);

      // "Brief" entry is active
      const briefLink = screen.getByRole("link", { name: /Brief/i });
      expect(briefLink.className).toContain("bg-card");
      expect(briefLink.className).toContain("shadow-sm");
    });

    it("renders inactive entry with muted foreground styling", () => {
      render(<ProjectRail model={MODEL} />);

      // "Character" entry is not active
      const charLink = screen.getByRole("link", { name: /Character/i });
      expect(charLink.className).toContain("text-muted-foreground");
    });
  });

  describe("dimmed groups", () => {
    it("renders dimmed group with reduced opacity", () => {
      const setupGroup = MODEL.groups[0]!;
      const dimmedModel: RailModel = {
        ...MODEL,
        groups: [
          {
            id: setupGroup.id,
            label: setupGroup.label,
            entries: setupGroup.entries,
            count: setupGroup.count,
            dimmed: true,
          },
        ],
      };

      render(<ProjectRail model={dimmedModel} />);

      const setupLabel = screen.getByText("Setup");
      const groupDiv = setupLabel.closest("div")!.parentElement;
      expect(groupDiv?.className).toContain("opacity-60");
    });

    it("still renders dimmed group content", () => {
      const setupGroup = MODEL.groups[0]!;
      const dimmedModel: RailModel = {
        ...MODEL,
        groups: [
          {
            id: setupGroup.id,
            label: setupGroup.label,
            entries: setupGroup.entries,
            count: setupGroup.count,
            dimmed: true,
          },
        ],
      };

      render(<ProjectRail model={dimmedModel} />);

      // Content should still be present, just dimmed
      expect(screen.getByText("Character")).toBeTruthy();
      expect(screen.getByText("Brief")).toBeTruthy();
    });
  });

  describe("navigation and accessibility", () => {
    it("renders nav element with accessible label", () => {
      render(<ProjectRail model={MODEL} />);

      const nav = screen.getByRole("navigation", { name: "Project navigation" });
      expect(nav).toBeTruthy();
    });

    it("renders all linked entries as navigation links", () => {
      render(<ProjectRail model={MODEL} />);

      const reachableEntries = MODEL.groups.flatMap((g) => g.entries.filter((e) => e.href));

      expect(screen.getAllByRole("link").length).toBeGreaterThanOrEqual(
        reachableEntries.length + 1, // +1 for back link
      );
    });
  });

  describe("edge cases", () => {
    it("handles empty groups gracefully", () => {
      const emptyModel: RailModel = {
        ...MODEL,
        groups: [
          {
            id: "setup",
            label: "Setup",
            entries: [],
          },
        ],
      };

      render(<ProjectRail model={emptyModel} />);
      expect(screen.getByText("Setup")).toBeTruthy();
    });

    it("handles empty balances gracefully", () => {
      const noBalancesModel: RailModel = {
        ...MODEL,
      };

      render(<ProjectRail model={noBalancesModel} />);
      // Should render without crashing
      expect(screen.getByText("Test Project")).toBeTruthy();
    });

    it("handles model with no dimmed groups", () => {
      const noDimmedModel: RailModel = {
        ...MODEL,
        groups: MODEL.groups.map((g) => ({ ...g, dimmed: false })),
      };

      render(<ProjectRail model={noDimmedModel} />);
      expect(screen.getByText("Setup")).toBeTruthy();
      expect(screen.getByText("Scenes")).toBeTruthy();
    });
  });
});

// The combination no fixture above covers: an entry that is NOT locked but
// has nowhere to link to. RailEntry allows it — href is "null when the entry
// is not reachable" — and lockedReason is defined only for locked entries.
//
// The first version of this component branched on `status === "locked" ||
// !entry.href` and rendered lockedReason in both cases, so this row lost its
// label to `undefined` and drew a draft glyph regardless of its real status.
// 26 tests passed while that was true, because none of them built a row with
// both properties at once — this repo's third and favourite trap.
describe("an unreachable entry that is not locked", () => {
  const model = {
    projectId: "proj-1",
    readOnly: false,
    projectTitle: "Kinoko Coffee",
    projectSubtitle: "2 scenes",
    backHref: "/projects",
    groups: [
      {
        id: "scenes" as const,
        label: "Scenes",
        entries: [
          {
            id: "s1",
            label: "1 · A-roll",
            status: "failed" as const,
            href: null,
            count: "bumagsak",
          },
        ],
      },
    ],
  };

  it("keeps its own label instead of rendering undefined", () => {
    render(<ProjectRail model={model} />);
    expect(screen.getByText("1 · A-roll")).toBeTruthy();
  });

  it("keeps its own status instead of reporting draft", () => {
    render(<ProjectRail model={model} />);
    // StatusIcon is the accessible-name source for the glyph (see its doc
    // comment), so the status is asserted through the name it exposes.
    expect(screen.getByLabelText("Failed")).toBeTruthy();
    expect(screen.queryByLabelText("Draft")).toBeNull();
  });

  it("still renders no link", () => {
    render(<ProjectRail model={model} />);
    expect(screen.queryByRole("link", { name: /A-roll/ })).toBeNull();
  });
});

// buildRailModel runs in a Server Component and has no pathname to stamp onto
// entries, so nothing was ever marked current and the rail could not say where
// you were standing. The component reads the route itself, the same way
// step-rail.tsx always has.
describe("the current entry, derived from the route", () => {
  const model = {
    projectId: "proj-1",
    readOnly: false,
    projectTitle: "Kinoko Coffee",
    projectSubtitle: "2 scenes",
    backHref: "/projects",
    groups: [
      {
        id: "setup" as const,
        label: "Setup",
        entries: [
          { id: "c", label: "Character", status: "done" as const, href: "/projects/1/character" },
          { id: "s", label: "Script", status: "idle" as const, href: "/projects/1/brief" },
        ],
      },
    ],
  };

  it("marks the entry whose href matches the current path", () => {
    mockPathname = "/projects/1/character";
    render(<ProjectRail model={model} />);
    expect(screen.getByRole("link", { name: /Character/i }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("leaves every other entry unmarked", () => {
    mockPathname = "/projects/1/character";
    render(<ProjectRail model={model} />);
    expect(screen.getByRole("link", { name: /Script/i }).getAttribute("aria-current")).toBeNull();
  });

  it("marks nothing when the path matches no entry", () => {
    mockPathname = "/projects/1/deliver";
    render(<ProjectRail model={model} />);
    for (const name of [/Character/i, /Script/i]) {
      expect(screen.getByRole("link", { name }).getAttribute("aria-current")).toBeNull();
    }
  });
});

// The four Setup rows used to all share one href (/character) — see
// currentEntryId's doc comment (components/project-rail.tsx). Now that
// Character/Product/Script/Settings are four distinct routes, exactly one
// row should ever be marked current for any one of the four pathnames.
describe("the four Setup rows, each on its own route", () => {
  const fourSetupRoutesModel = {
    projectId: "proj-1",
    readOnly: false,
    projectTitle: "Kinoko Coffee",
    projectSubtitle: "2 scenes",
    backHref: "/projects",
    groups: [
      {
        id: "setup" as const,
        label: "Setup",
        entries: [
          {
            id: "setup-character",
            label: "Character",
            status: "done" as const,
            href: "/projects/1/character",
          },
          {
            id: "setup-product",
            label: "Product",
            status: "idle" as const,
            href: "/projects/1/product",
          },
          {
            id: "setup-script",
            label: "Script",
            status: "idle" as const,
            href: "/projects/1/script",
          },
          {
            id: "setup-settings",
            label: "Render settings",
            status: "idle" as const,
            href: "/projects/1/settings",
          },
        ],
      },
    ],
  };

  it("marks exactly the row matching the current pathname, and no other", () => {
    mockPathname = "/projects/1/product";
    render(<ProjectRail model={fourSetupRoutesModel} />);

    const current = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");

    expect(current).toHaveLength(1);
    expect(current[0]).toBe(screen.getByRole("link", { name: /Product/i }));
  });
});

describe("busy field", () => {
  it("shows the running spinner when busy: true, regardless of status", () => {
    const model = {
      projectId: "proj-1",
      readOnly: false,
      projectTitle: "Kinoko Coffee",
      projectSubtitle: "2 scenes",
      backHref: "/projects",
      groups: [
        {
          id: "scenes" as const,
          label: "Scenes",
          entries: [
            {
              id: "s1",
              label: "Scene 1",
              status: "idle" as const,
              href: "/projects/1/scenes/1",
              busy: true,
            },
          ],
        },
      ],
    };

    render(<ProjectRail model={model} />);

    // When busy: true, should show the running glyph spinner
    const statusIcon = screen.getByLabelText("Rendering");
    expect(statusIcon).toBeTruthy();
    // The spinner SVG should have animate-spin class
    const spinner = statusIcon.querySelector("svg[class*='animate-spin']");
    expect(spinner).toBeTruthy();
  });

  it("shows the entry's own status when busy is false or absent", () => {
    const model = {
      projectId: "proj-1",
      readOnly: false,
      projectTitle: "Kinoko Coffee",
      projectSubtitle: "2 scenes",
      backHref: "/projects",
      groups: [
        {
          id: "scenes" as const,
          label: "Scenes",
          entries: [
            {
              id: "s1",
              label: "Scene 1",
              status: "done" as const,
              href: "/projects/1/scenes/1",
              busy: false,
            },
          ],
        },
      ],
    };

    render(<ProjectRail model={model} />);

    // When busy: false, should show the entry's own status (done)
    const done = screen.getByLabelText("Done");
    expect(done).toBeTruthy();
    // Done glyph should NOT have animate-spin
    const spinner = done.querySelector("svg[class*='animate-spin']");
    expect(spinner).toBeFalsy();
  });

  it("overrides status glyph with running when busy: true on done entry", () => {
    const model = {
      projectId: "proj-1",
      readOnly: false,
      projectTitle: "Kinoko Coffee",
      projectSubtitle: "2 scenes",
      backHref: "/projects",
      groups: [
        {
          id: "scenes" as const,
          label: "Scenes",
          entries: [
            {
              id: "s1",
              label: "Done Scene",
              status: "done" as const,
              href: "/projects/1/scenes/1",
              busy: true,
            },
          ],
        },
      ],
    };

    render(<ProjectRail model={model} />);

    // Should show Rendering (spinner), not Done
    const rendering = screen.getByLabelText("Rendering");
    expect(rendering).toBeTruthy();
    const spinner = rendering.querySelector("svg[class*='animate-spin']");
    expect(spinner).toBeTruthy();

    // Should NOT show Done
    expect(screen.queryByLabelText("Done")).toBeNull();
  });

  it("shows running glyph on reachable busy entry", () => {
    const model = {
      projectId: "proj-1",
      readOnly: false,
      projectTitle: "Kinoko Coffee",
      projectSubtitle: "2 scenes",
      backHref: "/projects",
      groups: [
        {
          id: "scenes" as const,
          label: "Scenes",
          entries: [
            {
              id: "s1",
              label: "Compiling Scene",
              status: "failed" as const,
              href: "/projects/1/scenes/1",
              busy: true,
            },
          ],
        },
      ],
    };

    render(<ProjectRail model={model} />);

    // Should show Rendering spinner, not Failed
    const rendering = screen.getByLabelText("Rendering");
    expect(rendering).toBeTruthy();
    const spinner = rendering.querySelector("svg[class*='animate-spin']");
    expect(spinner).toBeTruthy();

    // Should NOT show Failed
    expect(screen.queryByLabelText("Failed")).toBeNull();
  });

  it("shows running glyph on unreachable busy entry", () => {
    const model = {
      projectId: "proj-1",
      readOnly: false,
      projectTitle: "Kinoko Coffee",
      projectSubtitle: "2 scenes",
      backHref: "/projects",
      groups: [
        {
          id: "scenes" as const,
          label: "Scenes",
          entries: [
            {
              id: "s1",
              label: "Locked Scene",
              status: "locked" as const,
              href: null,
              lockedReason: "Waiting for previous",
              busy: true,
            },
          ],
        },
      ],
    };

    render(<ProjectRail model={model} />);

    // Should show Rendering spinner, not Draft (the glyph for locked)
    const rendering = screen.getByLabelText("Rendering");
    expect(rendering).toBeTruthy();
    const spinner = rendering.querySelector("svg[class*='animate-spin']");
    expect(spinner).toBeTruthy();

    // Should NOT show Draft
    expect(screen.queryByLabelText("Draft")).toBeNull();
  });
});

/** A rail with one group of `entries` and nothing else in it. */
function railWith(entries: RailModel["groups"][number]["entries"]): RailModel {
  return {
    projectId: "proj-1",
    readOnly: false,
    projectTitle: "Kinoko Coffee",
    projectSubtitle: "2 scenes",
    backHref: "/projects",
    groups: [{ id: "scenes", label: "Scenes", entries }],
  };
}

// The Setup count is a warning about unfinished work, and it sits beside the
// word it modifies rather than being flung to the far edge of the rail.
describe("the group count", () => {
  it("draws it in warning weight, not as another muted label", () => {
    render(<ProjectRail model={MODEL} />);

    // Scoped to the heading row: an entry further down carries "1/2" too,
    // and its trailing count is a different thing in a different place.
    const heading = screen.getByRole("heading", { name: "Setup" });
    const count = within(heading.parentElement!).getByText("1/2");
    expect(count.className).toContain("text-warning");
  });

  it("sits inline beside the label rather than being flung to the far edge", () => {
    render(<ProjectRail model={MODEL} />);

    // justify-between put an eight-character gap between "SETUP" and the
    // number that modifies it, at which width it read as belonging to
    // neither.
    const heading = screen.getByRole("heading", { name: "Setup" });
    expect(heading.parentElement!.className).not.toContain("justify-between");
  });

  it("renders nothing where a group has no count to report", () => {
    // Setup complete, per lib/project-rail.ts — a bare heading is itself the
    // signal that there is nothing left to do.
    render(<ProjectRail model={railWith([])} />);

    expect(screen.queryByText(/^\d+\/\d+$/)).toBeNull();
  });
});

// On the Render settings screen the active row swaps its tick for the gear —
// the design's "you are here" reinforcement. Everywhere else the row keeps
// its real status glyph, which is what a rail is actually scanned for.
describe("the Render settings row's gear", () => {
  const model = railWith([
    {
      id: "setup-render-settings",
      label: "Render settings",
      status: "done",
      href: "/projects/1/settings",
      icon: "settings",
    },
  ]);

  it("swaps the status tick for a gear while that row is the current one", () => {
    mockPathname = "/projects/1/settings";
    render(<ProjectRail model={model} />);

    const row = screen.getByLabelText("Done");
    expect(row.querySelector("svg.lucide-settings")).toBeTruthy();
  });

  it("keeps the status word as the accessible name, so nothing is lost to a screen reader", () => {
    mockPathname = "/projects/1/settings";
    render(<ProjectRail model={model} />);

    expect(screen.getByLabelText("Done")).toBeTruthy();
  });

  it("leaves the normal tick on every screen you are not standing on", () => {
    mockPathname = "/projects/1/character";
    render(<ProjectRail model={model} />);

    const row = screen.getByLabelText("Done");
    expect(row.querySelector("svg.lucide-settings")).toBeNull();
  });
});

// "rendering" is the same string at four seconds and at eight minutes. The
// clock is what tells a fresh render from a stuck one.
describe("the elapsed clock on a running row", () => {
  // Built per test, not once at describe time: the clock is derived from
  // Date.now() at RENDER, so a model whose origin was stamped while the file
  // was being collected reads one second higher by the time a slow suite
  // reaches this test, and "2:10" becomes "2:11". It failed that way twice
  // before this was a function.
  function runningModel(): RailModel {
    return railWith([
      {
        id: "s-1",
        label: "1 · A-roll",
        status: "running",
        href: "/projects/1/scenes/1",
        count: "rendering",
        elapsedSince: new Date(Date.now() - 130_000).toISOString(),
      },
    ]);
  }

  it("replaces the state word with m:ss once the clock starts", async () => {
    render(<ProjectRail model={runningModel()} />);

    await waitFor(() => expect(screen.getByText("2:10")).toBeTruthy());
    expect(screen.queryByText("rendering")).toBeNull();
  });

  it("keeps the state word when the origin cannot be parsed at all", () => {
    // A bad timestamp must degrade to the word, never to "NaN:NaN" — the row
    // is chrome that renders on every screen in the project, so a throwaway
    // parse failure here would follow the operator everywhere.
    const unparseable = railWith([
      {
        id: "s-1",
        label: "1 · A-roll",
        status: "running",
        href: "/projects/1/scenes/1",
        count: "rendering",
        elapsedSince: "not a date",
      },
    ]);

    render(<ProjectRail model={unparseable} />);

    expect(screen.getByText("rendering")).toBeTruthy();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it("keeps the state word for a row with no origin to measure from", async () => {
    const queued = railWith([
      {
        id: "s-1",
        label: "1 · A-roll",
        status: "running",
        href: "/projects/1/scenes/1",
        count: "queued",
        elapsedSince: null,
      },
    ]);

    render(<ProjectRail model={queued} />);

    // Still the word a beat later — no dash, no NaN.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByText("queued")).toBeTruthy();
  });
});

// The rail is the one thing visible from every screen, so "go to Character
// and come back and that is where you see whether it finished" is only true
// if it moves on its own. A Next layout is preserved across sibling-segment
// navigation, so it never used to.
describe("keeping itself current", () => {
  it("re-asks the server while something is running", () => {
    vi.useFakeTimers();
    try {
      render(
        <ProjectRail
          model={railWith([
            { id: "s-1", label: "1 · A-roll", status: "running", href: "/projects/1/scenes/1" },
          ])}
        />,
      );

      expect(refresh).not.toHaveBeenCalled();
      act(() => void vi.advanceTimersByTime(15_000));
      expect(refresh).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls nothing at all once every row is terminal", () => {
    vi.useFakeTimers();
    try {
      render(
        <ProjectRail
          model={railWith([
            { id: "s-1", label: "1 · A-roll", status: "done", href: "/projects/1/scenes/1" },
          ])}
        />,
      );

      act(() => void vi.advanceTimersByTime(60_000));
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// The add-scene affordance lives in the rail so adding a scene doesn't mean
// leaving whatever screen you are on first.
describe("the add-scene row", () => {
  const model: RailModel = {
    ...railWith([{ id: "s-1", label: "1 · A-roll", status: "done", href: "/projects/1/scenes/1" }]),
    groups: [
      {
        id: "scenes",
        label: "Scenes",
        entries: [{ id: "s-1", label: "1 · A-roll", status: "done", href: "/projects/1/scenes/1" }],
        addScene: { projectId: "proj-1", afterIdx: 0 },
      },
    ],
  };

  it("appends after the last scene when pressed", async () => {
    render(<ProjectRail model={model} />);

    fireEvent.click(screen.getByRole("button", { name: /add scene/i }));

    await waitFor(() => expect(vi.mocked(addScene)).toHaveBeenCalledWith("proj-1", 0));
  });

  it("refreshes the route afterwards, since addScene only revalidates the brief's path", async () => {
    render(<ProjectRail model={model} />);

    fireEvent.click(screen.getByRole("button", { name: /add scene/i }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("is absent when the model offers no insertion point", () => {
    render(<ProjectRail model={railWith([])} />);

    expect(screen.queryByRole("button", { name: /add scene/i })).toBeNull();
  });
});

// The four setup calls are awaited inline inside their own server action and
// write nothing a server render can see, so the client that fired one reports
// it — see RailBusyProvider.
describe("a screen reporting its own in-flight work", () => {
  function Screen({ active }: { active: boolean }) {
    useRailBusyWhile("setup-character", active);
    return null;
  }

  const model = railWith([
    { id: "setup-character", label: "Character", status: "done", href: "/projects/1/character" },
  ]);

  it("spins the row the screen names, not the one it is standing on", async () => {
    render(
      <RailBusyProvider>
        <ProjectRail model={model} />
        <Screen active />
      </RailBusyProvider>,
    );

    await waitFor(() => expect(screen.getByLabelText("Rendering")).toBeTruthy());
    expect(screen.queryByLabelText("Done")).toBeNull();
  });

  it("stops when the call returns", async () => {
    const { rerender } = render(
      <RailBusyProvider>
        <ProjectRail model={model} />
        <Screen active />
      </RailBusyProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText("Rendering")).toBeTruthy());

    rerender(
      <RailBusyProvider>
        <ProjectRail model={model} />
        <Screen active={false} />
      </RailBusyProvider>,
    );

    await waitFor(() => expect(screen.getByLabelText("Done")).toBeTruthy());
  });

  it("stops when the screen that started it unmounts mid-call", async () => {
    // Otherwise walking away from a screen mid-call leaves its row spinning
    // for the rest of the session — the exact failure the signal exists to
    // prevent, inverted.
    const { rerender } = render(
      <RailBusyProvider>
        <ProjectRail model={model} />
        <Screen active />
      </RailBusyProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText("Rendering")).toBeTruthy());

    rerender(
      <RailBusyProvider>
        <ProjectRail model={model} />
      </RailBusyProvider>,
    );

    await waitFor(() => expect(screen.getByLabelText("Done")).toBeTruthy());
  });

  it("renders outside the provider without crashing", () => {
    render(
      <>
        <ProjectRail model={model} />
        <Screen active />
      </>,
    );

    expect(screen.getByLabelText("Done")).toBeTruthy();
  });
});

// The balances are the number an operator checks before spending, so they sit
// at a fixed place — the bottom edge of the rail — rather than wherever the
// last group happens to end.

// The rail's whole claim is that it is the activity indicator: a call
// started on one screen stays visible after you navigate away from the
// screen that started it. The provider and the hook shipped with NOBODY
// calling them, so the ring existed and never turned.
describe("useRailBusyWhile — a screen can light its own rail row", () => {
  function Caller({ active }: { active: boolean }): JSX.Element {
    useRailBusyWhile("setup-script", active);
    return <span>caller</span>;
  }

  const model = railWith([
    {
      id: "setup-script",
      label: "Script",
      status: "idle",
      href: "/projects/1/script",
    },
  ]);

  it("spins the named row while the caller is active", () => {
    render(
      <RailBusyProvider>
        <Caller active />
        <ProjectRail model={model} />
      </RailBusyProvider>,
    );

    // The running glyph, not the idle circle — StatusIcon draws "rendering"
    // for a busy row.
    expect(document.querySelector("svg.animate-spin")).toBeTruthy();
  });

  it("leaves the row alone when nothing is running", () => {
    render(
      <RailBusyProvider>
        <Caller active={false} />
        <ProjectRail model={model} />
      </RailBusyProvider>,
    );

    expect(document.querySelector("svg.animate-spin")).toBeNull();
  });
});

// queued is its own state, not a shade of running: a scene the worker has
// not claimed has no submitted_at and so no clock, and calling it
// "Rendering" to a screen reader while its own trailing word says "queued"
// is the row contradicting itself.
describe("the rail tells queued apart from rendering", () => {
  function iconLabel(status: "queued" | "running"): string {
    cleanup();
    render(
      <ProjectRail
        model={railWith([
          { id: "s-1", label: "1 · A-roll", status, href: "/projects/1/scenes/1", count: status },
        ])}
      />,
    );
    // Two other elements in the rail carry an aria-label — the nav itself,
    // and the pencil that renames the project (components/rail-title-edit.tsx).
    // Excluding them BY NAME rather than taking the first match: this helper
    // used to do the latter, and the rename button, sitting above the rows in
    // the header, quietly became icons[0] and made both assertions read the
    // wrong element's label.
    const icons = Array.from(document.querySelectorAll("[aria-label]")).filter((el) => {
      const label = el.getAttribute("aria-label") ?? "";
      return label !== "Project navigation" && !label.startsWith("Rename ");
    });
    return icons[0]?.getAttribute("aria-label") ?? "";
  }

  it("names a queued row Queued, not Rendering", () => {
    expect(iconLabel("queued")).toBe("Queued");
  });

  it("still names a rendering row Rendering", () => {
    expect(iconLabel("running")).toBe("Rendering");
  });
});

// The hook above needs an `isPending` the caller already computes. A Server
// Component page has none: it renders an ActionForm whose pending state lives
// in React's own form status, which only a client child of that <form> can
// read. RailBusyWhileSubmitting is that child, and the two paid image calls
// on the Character and Product screens are what it exists for — both are
// multi-second, both are walked away from, and neither wrote anything a
// server render could see while it ran.
describe("RailBusyWhileSubmitting — a form reports itself to the rail", () => {
  const model = railWith([
    { id: "setup-product", label: "Product", status: "idle", href: "/projects/1/product" },
  ]);

  function FormScreen({ action }: { action: () => Promise<void> }): JSX.Element {
    return (
      <>
        <form action={action}>
          <RailBusyWhileSubmitting entryId="setup-product" />
          <button type="submit">Generate</button>
        </form>
        <ProjectRail model={model} />
      </>
    );
  }

  it("spins the named row while the form's action is in flight, and stops when it settles", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => {};
    const action = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );

    render(
      <RailBusyProvider>
        <FormScreen action={action} />
      </RailBusyProvider>,
    );
    // Idle first — otherwise a row that spins unconditionally would pass
    // every assertion below.
    expect(document.querySelector("svg.animate-spin")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    await waitFor(() => expect(document.querySelector("svg.animate-spin")).toBeTruthy());

    await act(async () => {
      settle();
    });
    await waitFor(() => expect(document.querySelector("svg.animate-spin")).toBeNull());
  });

  it("stops when the operator navigates away mid-submit", async () => {
    const user = userEvent.setup();
    // Deferred, not never-settling: an action left hanging past the end of a
    // test keeps a React transition open for every test that follows it, and
    // the next useTransition in the file then reports pending state it never
    // asked for. Cost an hour once already.
    let settle: () => void = () => {};
    const action = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );

    const { rerender } = render(
      <RailBusyProvider>
        <FormScreen action={action} />
      </RailBusyProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(document.querySelector("svg.animate-spin")).toBeTruthy());

    // The form (and the page around it) goes away while the action is still
    // running — the row must not be left spinning for the rest of the
    // session.
    rerender(
      <RailBusyProvider>
        <ProjectRail model={model} />
      </RailBusyProvider>,
    );

    await waitFor(() => expect(document.querySelector("svg.animate-spin")).toBeNull());

    await act(async () => {
      settle();
    });
  });
});

// The other half of the same bug. useTransition is a transition too, so a row
// reported from one (Improve with AI, describe-from-photo, regenerate
// portrait, delete scene) was just as still as the form-driven ones — and
// unlike those, every one of these call sites already looked correct, because
// they pass a real `isPending` to a hook whose own unit tests all passed.
// What they were all sharing was a provider that could only deliver by
// re-rendering itself.
describe("a row reported from inside a useTransition", () => {
  const model = railWith([
    { id: "setup-character", label: "Character", status: "idle", href: "/projects/1/character" },
  ]);

  function TransitionScreen({ action }: { action: () => Promise<void> }): JSX.Element {
    const [isPending, startTransition] = useTransition();
    useRailBusyWhile("setup-character", isPending);
    return (
      <>
        {/* Every real caller renders something off its own isPending — a
            PendingButton's ring. Mirrored here (as text, so it can't be
            mistaken for the rail's ring) rather than left out, because a
            screen that ignores its own pending flag is not a screen this
            hook has. */}
        <span>{isPending ? "running" : "idle"}</span>
        <button
          type="button"
          onClick={() =>
            startTransition(async () => {
              await action();
            })
          }
        >
          Improve
        </button>
      </>
    );
  }

  it("spins while the awaited action is still running", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => {};
    const action = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );

    render(
      <RailBusyProvider>
        <TransitionScreen action={action} />
        <ProjectRail model={model} />
      </RailBusyProvider>,
    );
    expect(document.querySelector("svg.animate-spin")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Improve" }));
    await waitFor(() => expect(screen.getByText("running")).toBeTruthy());
    expect(document.querySelector("svg.animate-spin")).toBeTruthy();

    await act(async () => {
      settle();
    });
    await waitFor(() => expect(screen.getByText("idle")).toBeTruthy());
    await waitFor(() => expect(document.querySelector("svg.animate-spin")).toBeNull());
  });
});
