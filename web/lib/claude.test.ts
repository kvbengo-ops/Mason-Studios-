import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_RENDER_SETTINGS, UNIVERSAL_DURATIONS_S } from "./models";
import { DEFAULT_DIRECTION, type ProjectDirection } from "./direction";
import type { ScriptRow } from "./script-columns";
import {
  applyCameraMovementOverride,
  applyPronunciationGuide,
  buildDirectionBlock,
  buildProductAppearanceSection,
  buildVisualIdeaRowsBlock,
  SceneBrief,
  type Brief,
} from "./claude";

// No MODE stub needed anywhere in this file: it defaults to "development"
// (lib/mode.ts), which is the mocked branch every compile* function here
// exercises — and since isDev() re-reads process.env.MODE at call time
// (not import time, same reasoning mock-flags.ts's isMockClaude used to
// document here), a test that DID need "production" behavior could still
// vi.stubEnv it per block with no module reload required.

describe("compileBrief (MODE=development)", () => {
  it("returns a valid brief shape", async () => {
    const { compileBrief, Brief } = await import("./claude");

    const brief = await compileBrief({
      script: "Ever feel like your mornings are a race against the clock?",
      templateBody: "You are a video production planner.",
    });

    expect(() => Brief.parse(brief)).not.toThrow();
    expect(brief.character.length).toBeGreaterThan(0);
    expect(brief.scenes.length).toBeGreaterThan(0);
    for (const scene of brief.scenes) {
      // The mock fixtures have to clear the same bar a real compile does:
      // renderable on whichever model gets picked at the gate, not merely
      // on LTX. Brief.parse above already enforces it — this keeps the
      // failure legible when a fixture drifts.
      expect([...UNIVERSAL_DURATIONS_S]).toContain(scene.duration_s);
      expect(typeof scene.is_talking_head).toBe("boolean");
      expect(scene.script_line.length).toBeGreaterThan(0);
      expect(scene.video_prompt.length).toBeGreaterThan(0);
    }
    // Fewer, longer scenes post-fix (see LTX_ALLOWED_DURATIONS_S): the
    // fixture folds down to 6 scenes, still mixing talking-head values.
    expect(brief.scenes.length).toBeGreaterThanOrEqual(6);
    expect(brief.scenes.some((s) => s.is_talking_head)).toBe(true);
    expect(brief.scenes.some((s) => !s.is_talking_head)).toBe(true);
  });

  it("estimateCost maths is right for the known fixture, audio enabled", async () => {
    const { compileBrief } = await import("./claude");
    const { estimateCost } = await import("./estimate");

    const brief = await compileBrief({
      script: "irrelevant under mock mode",
      templateBody: "irrelevant under mock mode",
    });

    const cost = estimateCost(brief, true, DEFAULT_RENDER_SETTINGS);

    // Fixture (post-fix, allowed durations only): 3 talking-head scenes
    // at 8+6+8=22s, 3 silent scenes at 8+6+6=20s, 42s total.
    //
    // estimateCost routes every scene through pickModel() (lib/models.ts),
    // same as worker/internal/kie/models.go's PickModel. DEFAULT_RENDER_SETTINGS
    // is the default (Seedance 2.5) — a project that has never selected
    // Kling — and Kling is only ever reached via an explicit
    // render_settings.model selection (see pickModel's own doc comment):
    // settings.model is authoritative, full stop. So all 42s here bill at
    // the default's own default-resolution rate, $0.14/s (480p, kie's
    // published rate — see lib/kie/rates.ts) regardless of is_talking_head:
    // 42 * 0.14 = 5.88.
    expect(cost.talkingHeadCount).toBe(3);
    expect(cost.silentCount).toBe(3);
    expect(cost.seconds).toBe(42);
    expect(cost.totalUsd).toBeCloseTo(5.88, 5);
    expect(cost.audioEnabled).toBe(true);
  });

  it("estimateCost bills every scene at the silent rate when audio is disabled", async () => {
    const { compileBrief } = await import("./claude");
    const { estimateCost } = await import("./estimate");

    const brief = await compileBrief({
      script: "irrelevant under mock mode",
      templateBody: "irrelevant under mock mode",
    });

    const cost = estimateCost(brief, false, DEFAULT_RENDER_SETTINGS);

    // Same fixture as above (3 talking-head + 3 silent, 42s total), but
    // AUDIO_ENABLED=0 must route every scene — including the 3 scripted as
    // talking-head — to the default's silent rate: 42 * 0.14 = 5.88.
    // The script's is_talking_head split is still reported (informational —
    // that flag is never rewritten) even though it no longer drives price.
    expect(cost.talkingHeadCount).toBe(3);
    expect(cost.silentCount).toBe(3);
    expect(cost.seconds).toBe(42);
    expect(cost.totalUsd).toBeCloseTo(5.88, 5);
    expect(cost.audioEnabled).toBe(false);
  });
});

describe("Brief schema validation", () => {
  // The exact case that broke production: 2.5s is the kind of natural-pace
  // scene duration the compiler used to emit, and fal rejects anything not
  // in LTX_ALLOWED_DURATIONS_S with a literal_error on `body.duration`.
  it("rejects duration_s = 2.5 (the value that broke production)", async () => {
    const { Brief } = await import("./claude");

    const invalid = {
      character: "A woman in her late 20s in a kitchen.",
      scenes: [
        {
          script_line: "This is a short natural-pace scene.",
          video_prompt: "A medium shot of a woman talking.",
          is_talking_head: true,
          duration_s: 2.5,
        },
      ],
    };

    expect(() => Brief.parse(invalid)).toThrow();
  });

  // 9 used to be outside UNIVERSAL_DURATIONS_S's old [6,8,10,12,14] set
  // (LTX-constrained), but 9 IS legal now that the set is the full 4-15
  // range Kling and Seedance25 share (see UNIVERSAL_DURATIONS_S's own
  // 2026-08-29 recompute comment) — so this uses 16, above either enabled
  // model's ceiling, instead.
  it("rejects duration_s = 16 (above the allowed set's ceiling)", async () => {
    const { Brief } = await import("./claude");

    const invalid = {
      character: "A woman in her late 20s in a kitchen.",
      scenes: [
        {
          script_line: "This line runs too long for one clip.",
          video_prompt: "A medium shot of a woman talking.",
          is_talking_head: true,
          duration_s: 16,
        },
      ],
    };

    expect(() => Brief.parse(invalid)).toThrow();
  });

  it("accepts duration_s = 6, a fal-allowed clip length", async () => {
    const { Brief } = await import("./claude");

    const valid = {
      character: "A woman in her late 20s in a kitchen.",
      scenes: [
        {
          script_line: "A short line.",
          video_prompt: "A medium shot of a woman talking.",
          is_talking_head: true,
          duration_s: 6,
        },
      ],
    };

    expect(() => Brief.parse(valid)).not.toThrow();
  });

  // Driven off the constant rather than a copy of it: the whole point of
  // UNIVERSAL_DURATIONS_S is that the set changes when a model is enabled or
  // disabled, and a hardcoded list here would keep passing while the schema
  // it claims to describe moved underneath it.
  it.each([...UNIVERSAL_DURATIONS_S])("accepts every allowed duration (%d)", async (d) => {
    const { Brief } = await import("./claude");

    const valid = {
      character: "A woman in her late 20s in a kitchen.",
      scenes: [
        {
          script_line: "A line.",
          video_prompt: "A medium shot of a woman talking.",
          is_talking_head: false,
          duration_s: d,
        },
      ],
    };

    expect(() => Brief.parse(valid)).not.toThrow();
  });

  // The regression this whole change exists for. 16, 18 and 20 used to be
  // legal on LTX and rejected by every other model, so a brief carrying
  // them was renderable only until the operator picked a different model at
  // the gate — which is after the brief is written. An editor hit exactly
  // that and fal refused the render. LTX is disabled now (see its own
  // `enabled` doc comment), but these three values remain above both
  // remaining enabled models' ceiling (15s), so they still must be refused.
  it.each([16, 18, 20])(
    "rejects a duration above every enabled model's ceiling (%d)",
    async (d) => {
      const { Brief } = await import("./claude");

      const briefWithLtxOnlyDuration = {
        character: "A woman in her late 20s in a kitchen.",
        scenes: [
          {
            script_line: "A line.",
            video_prompt: "A medium shot of a woman talking.",
            is_talking_head: false,
            duration_s: d,
          },
        ],
      };

      expect(() => Brief.parse(briefWithLtxOnlyDuration)).toThrow();
    },
  );
});

function oneSceneBrief(overrides: Partial<Brief["scenes"][number]> = {}): Brief {
  return {
    character: "A woman in her late 20s with shoulder-length dark hair in a sunlit kitchen.",
    scenes: [
      {
        script_line: "Meet Seranova, the routine that fits your morning.",
        video_prompt: "Medium shot of a woman speaking to camera, soft natural light.",
        is_talking_head: true,
        duration_s: 8,
        ...overrides,
      },
    ],
  };
}

describe("buildDirectionBlock", () => {
  it("always states the shooting mode, even at the all-default direction", () => {
    // shooting_mode has no "unset" state — it always drives the scene's
    // default camera language, so unlike the other fields it must never be
    // omitted just because the project left it at the default.
    const block = buildDirectionBlock(DEFAULT_DIRECTION);
    expect(block).toMatch(/Shooting mode: selfie/);
  });

  it("omits visual_idea, voice_profile and ugc_style when left at their defaults", () => {
    // A project that never touched the Direction card should compile
    // against the same prompt shape v3 already used — no empty or
    // placeholder lines for fields nobody set.
    const block = buildDirectionBlock(DEFAULT_DIRECTION);
    expect(block).not.toMatch(/Visual idea/);
    expect(block).not.toMatch(/Voice profile/);
    expect(block).not.toMatch(/UGC style/);
  });

  it("includes every field the operator actually set", () => {
    const direction: ProjectDirection = {
      ...DEFAULT_DIRECTION,
      shooting_mode: "mirror",
      visual_idea: "Lock the camera position completely.",
      voice_profile: "warm, inspiring",
      ugc_style: "testimonial",
    };
    const block = buildDirectionBlock(direction);
    expect(block).toMatch(/Shooting mode: mirror/);
    expect(block).toMatch(/Visual idea.*Lock the camera position completely\./);
    expect(block).toMatch(/Voice profile: warm, inspiring/);
    expect(block).toMatch(/UGC style: testimonial/);
  });

  it("never mentions camera_movement or pronunciation_guide", () => {
    // Both are applied as deterministic post-processing (see
    // applyCameraMovementOverride / applyPronunciationGuide below), not
    // requested of the model — see this file's doc comment on
    // buildDirectionBlock for why "every time, no exceptions" isn't a
    // property worth trusting to a prompted instruction.
    const direction: ProjectDirection = {
      ...DEFAULT_DIRECTION,
      shooting_mode: "static",
      camera_movement: true,
      pronunciation_guide: "Seranova → seh-rah-NOH-vah",
    };
    const block = buildDirectionBlock(direction);
    expect(block).not.toMatch(/camera.?movement/i);
    expect(block).not.toMatch(/pronunciation/i);
    expect(block).not.toMatch(/Seranova/);
  });
});

describe("buildVisualIdeaRowsBlock", () => {
  it("returns '' when no row has a visual idea — the section is omitted entirely, not sent empty", () => {
    const rows: ScriptRow[] = [
      { script: "Meet Seranova.", visualIdea: null },
      { script: "Ships free this week.", visualIdea: null },
    ];
    expect(buildVisualIdeaRowsBlock(rows)).toBe("");
  });

  it("returns '' for an empty row list", () => {
    expect(buildVisualIdeaRowsBlock([])).toBe("");
  });

  it("lists only rows that have a visual idea, numbered from 1", () => {
    const rows: ScriptRow[] = [
      { script: "Meet Seranova.", visualIdea: "Locked wide shot, zero zoom." },
      { script: "No note on this one.", visualIdea: null },
      { script: "Ships free.", visualIdea: "Close-up on the jar." },
    ];
    const block = buildVisualIdeaRowsBlock(rows);
    expect(block).toMatch(/1\. SCRIPT: Meet Seranova\./);
    expect(block).toMatch(/VISUAL IDEA: Locked wide shot, zero zoom\./);
    expect(block).toMatch(/2\. SCRIPT: Ships free\./);
    expect(block).toMatch(/VISUAL IDEA: Close-up on the jar\./);
    // The skipped null row must not appear at all, and numbering must not
    // reserve a slot for it (2, not 3, for the second listed row).
    expect(block).not.toMatch(/No note on this one/);
  });

  it("labels a visual-only row (empty script cell) as a visual-only beat", () => {
    const rows: ScriptRow[] = [{ script: "", visualIdea: "Cutaway to the product label." }];
    const block = buildVisualIdeaRowsBlock(rows);
    expect(block).toMatch(/1\. SCRIPT: \(no dialogue — visual-only beat\)/);
    expect(block).toMatch(/VISUAL IDEA: Cutaway to the product label\./);
  });
});

describe("buildProductAppearanceSection", () => {
  it("returns '' when unset", () => {
    expect(buildProductAppearanceSection(undefined)).toBe("");
  });

  it("returns '' for an empty or whitespace-only description — no empty/placeholder line", () => {
    expect(buildProductAppearanceSection("")).toBe("");
    expect(buildProductAppearanceSection("   ")).toBe("");
    expect(buildProductAppearanceSection("\n\t")).toBe("");
  });

  it("includes the operator's description, trimmed, when set", () => {
    const section = buildProductAppearanceSection(
      "  Matte green stand-up pouch, kraft-paper texture.  ",
    );
    expect(section).toMatch(/Matte green stand-up pouch, kraft-paper texture\./);
    expect(section).not.toMatch(/^\s/);
  });

  it("reads as a visual constraint, not an instruction to write dialogue", () => {
    const section = buildProductAppearanceSection("Green pouch.");
    expect(section).toMatch(/not dialogue/i);
    expect(section).toMatch(/do not have any character speak/i);
  });
});

describe("Brief schema — visual_idea (per-scene, spec §3.3)", () => {
  it("accepts a scene with visual_idea explicitly null", async () => {
    const { Brief } = await import("./claude");
    const valid = {
      character: "A woman in her late 20s in a kitchen.",
      scenes: [
        {
          script_line: "A line.",
          video_prompt: "A medium shot of a woman talking.",
          is_talking_head: true,
          duration_s: 8,
          visual_idea: null,
        },
      ],
    };
    expect(() => Brief.parse(valid)).not.toThrow();
  });

  it("accepts a scene with visual_idea set to the echoed operator text", async () => {
    const { Brief } = await import("./claude");
    const valid = {
      character: "A woman in her late 20s in a kitchen.",
      scenes: [
        {
          script_line: "A line.",
          video_prompt: "A medium shot of a woman talking.",
          is_talking_head: true,
          duration_s: 8,
          visual_idea: "Locked wide shot, zero zoom.",
        },
      ],
    };
    expect(() => Brief.parse(valid)).not.toThrow();
  });

  it("still accepts a scene with visual_idea entirely omitted (every fixture before this feature)", async () => {
    const { Brief } = await import("./claude");
    expect(() => Brief.parse(oneSceneBrief())).not.toThrow();
  });

  it("SceneBrief (Apply/Split's schema) omits visual_idea as well as script_line", () => {
    // compileScene already knows which visual idea (if any) applies — it's
    // CompileSceneArgs.visualIdea, sourced from the scene's own stored
    // scenes.visual_idea — so there is nothing for the model to echo back
    // that the caller doesn't already have. See SceneBrief's doc comment.
    const shape = SceneBrief.parse({
      video_prompt: "A medium shot.",
      is_talking_head: true,
      duration_s: 8,
    });
    expect(shape).not.toHaveProperty("script_line");
    expect(shape).not.toHaveProperty("visual_idea");
  });
});

describe("applyCameraMovementOverride", () => {
  it("prepends the OVERRIDE clause to every scene when static + camera_movement and the exact static phrase is absent (pre-v7 fallback)", () => {
    const brief = oneSceneBrief();
    const direction: ProjectDirection = {
      ...DEFAULT_DIRECTION,
      shooting_mode: "static",
      camera_movement: true,
    };
    const result = applyCameraMovementOverride(brief, direction);
    expect(result.scenes[0]!.video_prompt).toMatch(/^OVERRIDE:/);
    expect(result.scenes[0]!.video_prompt).toMatch(/handheld/i);
  });

  it("replaces the exact static phrase in place, rather than prepending, when it is present (v7+)", () => {
    const brief = oneSceneBrief({
      video_prompt:
        "Medium shot of a woman speaking to camera, static tripod, locked-off framing, soft natural light.",
    });
    const direction: ProjectDirection = {
      ...DEFAULT_DIRECTION,
      shooting_mode: "static",
      camera_movement: true,
    };
    const result = applyCameraMovementOverride(brief, direction);
    expect(result.scenes[0]!.video_prompt).not.toMatch(/^OVERRIDE:/);
    expect(result.scenes[0]!.video_prompt).not.toContain("static tripod, locked-off framing");
    expect(result.scenes[0]!.video_prompt).toMatch(/handheld/i);
    expect(result.scenes[0]!.video_prompt).toBe(
      "Medium shot of a woman speaking to camera, deliberate handheld camera movement: organic " +
        "sway, micro-jitter, breathing wobble, as if held by hand, never mounted or locked-off, " +
        "soft natural light.",
    );
  });

  it("replaces every occurrence of the exact static phrase, not just the first", () => {
    const brief = oneSceneBrief({
      video_prompt:
        "static tripod, locked-off framing at first, then static tripod, locked-off framing again.",
    });
    const direction: ProjectDirection = {
      ...DEFAULT_DIRECTION,
      shooting_mode: "static",
      camera_movement: true,
    };
    const result = applyCameraMovementOverride(brief, direction);
    expect(result.scenes[0]!.video_prompt).not.toContain("static tripod, locked-off framing");
    expect(result.scenes[0]!.video_prompt.match(/handheld/gi)).toHaveLength(2);
  });

  // v7 pins the Camera attribute only. Template §5 still teaches Claude that
  // `static` means "propped phone, both hands free", so that wording can land
  // in the Action prose, where replacing the Camera attribute leaves nothing
  // to arbitrate between "handheld" and "props her phone".
  it("also prepends the OVERRIDE when static-framing language survives outside the pinned phrase", () => {
    const brief = oneSceneBrief({
      video_prompt:
        "Medium shot of a woman who props her phone against the kettle and steps back, " +
        "static tripod, locked-off framing, soft natural light.",
    });
    const direction: ProjectDirection = {
      ...DEFAULT_DIRECTION,
      shooting_mode: "static",
      camera_movement: true,
    };
    const result = applyCameraMovementOverride(brief, direction);
    expect(result.scenes[0]!.video_prompt).toMatch(/^OVERRIDE:/);
    // Still replaced, not merely prepended — the Camera attribute itself must
    // not survive as "static tripod, locked-off framing".
    expect(result.scenes[0]!.video_prompt).not.toContain("static tripod, locked-off framing");
  });

  // The guard against the residual check reading its own output:
  // HANDHELD_CAMERA_CLAUSE ends "never mounted or locked-off", so scanning the
  // REPLACED text would match every time and silently restore an
  // unconditional prepend. A clean prompt must stay clean.
  it("does not prepend when the only static-framing words are the ones it just inserted", () => {
    const brief = oneSceneBrief({
      video_prompt:
        "Medium shot of a woman speaking to camera in a sunlit kitchen, " +
        "static tripod, locked-off framing, soft natural light.",
    });
    const direction: ProjectDirection = {
      ...DEFAULT_DIRECTION,
      shooting_mode: "static",
      camera_movement: true,
    };
    const result = applyCameraMovementOverride(brief, direction);
    expect(result.scenes[0]!.video_prompt).not.toMatch(/^OVERRIDE:/);
    expect(result.scenes[0]!.video_prompt).toMatch(/handheld/i);
  });

  it("is a no-op under selfie even if camera_movement is somehow true", () => {
    // Belt-and-suspenders: DirectionSchema already normalizes this case to
    // false before it reaches the database (lib/direction.ts), but this
    // function is not supposed to trust that — the spec is explicit that
    // the override is a static-mode-only behavior (§3.1: "not rendered
    // under Selfie" — shake is already inherent there).
    const brief = oneSceneBrief();
    const direction: ProjectDirection = {
      ...DEFAULT_DIRECTION,
      shooting_mode: "selfie",
      camera_movement: true,
    };
    const result = applyCameraMovementOverride(brief, direction);
    expect(result).toEqual(brief);
  });

  it("is a no-op under static when camera_movement is off", () => {
    const brief = oneSceneBrief();
    const direction: ProjectDirection = {
      ...DEFAULT_DIRECTION,
      shooting_mode: "static",
      camera_movement: false,
    };
    expect(applyCameraMovementOverride(brief, direction)).toEqual(brief);
  });
});

describe("applyPronunciationGuide", () => {
  it("appends the phonetic in brackets after the word's first occurrence in that scene", () => {
    const brief = oneSceneBrief({
      script_line: "Meet Seranova, the routine that fits your morning. Seranova ships free.",
    });
    const result = applyPronunciationGuide(brief, "Seranova → seh-rah-NOH-vah");
    // Only the FIRST occurrence gets annotated (spec §3.3) — the second
    // "Seranova" later in the same line is untouched.
    expect(result.scenes[0]!.script_line).toBe(
      "Meet Seranova [seh-rah-NOH-vah], the routine that fits your morning. Seranova ships free.",
    );
  });

  it("is a no-op when the project has no pronunciation guide", () => {
    const brief = oneSceneBrief();
    expect(applyPronunciationGuide(brief, "")).toEqual(brief);
  });

  it("does not annotate a scene whose dialogue never mentions the guided word", () => {
    const brief = oneSceneBrief({ script_line: "Your first order ships free this week." });
    const result = applyPronunciationGuide(brief, "Seranova → seh-rah-NOH-vah");
    expect(result.scenes[0]!.script_line).toBe(brief.scenes[0]!.script_line);
  });

  it("matches whole words only, case-insensitively", () => {
    // "sera" must not match inside "Seranova" and vice versa — a
    // substring match would misfire on unrelated words that happen to
    // contain a guided word as a prefix.
    const brief = oneSceneBrief({ script_line: "seranova is here." });
    const result = applyPronunciationGuide(brief, "Seranova → seh-rah-NOH-vah");
    expect(result.scenes[0]!.script_line).toBe("seranova [seh-rah-NOH-vah] is here.");
  });

  it("handles multiple guided words on one line, each on its own first occurrence", () => {
    const brief = oneSceneBrief({
      script_line: "Seranova pairs perfectly with Kinoko every morning.",
    });
    const result = applyPronunciationGuide(
      brief,
      "Seranova → seh-rah-NOH-vah\nKinoko → kee-NOH-koh",
    );
    expect(result.scenes[0]!.script_line).toBe(
      "Seranova [seh-rah-NOH-vah] pairs perfectly with Kinoko [kee-NOH-koh] every morning.",
    );
  });

  it("ignores blank lines and lines with no arrow in the guide text", () => {
    const brief = oneSceneBrief({ script_line: "Seranova ships free this week." });
    const result = applyPronunciationGuide(
      brief,
      "\nnot a pronunciation line\nSeranova → seh-rah-NOH-vah\n",
    );
    expect(result.scenes[0]!.script_line).toBe("Seranova [seh-rah-NOH-vah] ships free this week.");
  });
});

describe("compileScene (MODE=development) — Apply/Split's single-scene engine", () => {
  it("returns a scene shape with no script_line field", async () => {
    const { compileScene } = await import("./claude");

    const scene = await compileScene({
      scriptLine: "Ever feel like your mornings are a race against the clock?",
      templateBody: "You are a video production planner.",
    });

    // script_line is Apply/Split's *input*, not something Claude regenerates
    // — SceneBrief is Brief's scene schema minus that field (see lib/claude.ts).
    expect(scene).not.toHaveProperty("script_line");
    expect(() => SceneBrief.parse(scene)).not.toThrow();
    expect([6, 8, 10, 12, 14, 16, 18, 20]).toContain(scene.duration_s);
    expect(typeof scene.is_talking_head).toBe("boolean");
    expect(scene.video_prompt.length).toBeGreaterThan(0);
  });

  it("never echoes the operator's dialogue into the mock video_prompt", async () => {
    const { compileScene } = await import("./claude");

    // The mock fixture must not fall into the exact "quoted line becomes a
    // burned-in on-screen caption" bug applyPronunciationGuide's doc comment
    // describes — pinning this catches a future edit to mockScene() that
    // starts interpolating scriptLine into the prompt text.
    const scriptLine = "Ever feel like your mornings are a race against the clock?";
    const scene = await compileScene({ scriptLine, templateBody: "irrelevant under mock mode" });
    expect(scene.video_prompt).not.toContain(scriptLine);
  });

  it("applies the camera-movement OVERRIDE under static + camera_movement, same as a full compile", async () => {
    const { compileScene } = await import("./claude");

    const direction: ProjectDirection = {
      ...DEFAULT_DIRECTION,
      shooting_mode: "static",
      camera_movement: true,
    };

    const scene = await compileScene({
      scriptLine: "Your first order ships free this week.",
      templateBody: "irrelevant under mock mode",
      direction,
    });

    // Reuses applyCameraMovementOverride verbatim rather than a second copy
    // of the prepend logic — this is what makes a re-Applied scene keep the
    // same handheld-shake rule its unretouched neighbours got at compile time.
    expect(scene.video_prompt).toMatch(/^OVERRIDE:/);
  });

  it("does not apply the OVERRIDE under selfie mode", async () => {
    const { compileScene } = await import("./claude");

    const scene = await compileScene({
      scriptLine: "Your first order ships free this week.",
      templateBody: "irrelevant under mock mode",
      direction: { ...DEFAULT_DIRECTION, shooting_mode: "selfie" },
    });

    expect(scene.video_prompt).not.toMatch(/^OVERRIDE:/);
  });
});

describe("improveDescriptionText (MODE=development)", () => {
  it("fills gaps rather than rewriting — the operator's own text survives in the suggestion", async () => {
    const { improveDescriptionText } = await import("./claude");

    const suggestion = await improveDescriptionText({
      description: "an athletic woman",
      subject: "character",
    });

    // The whole point of "Improve", not "regenerate": what the operator
    // already wrote must still be there, not replaced by something new.
    expect(suggestion.description).toContain("an athletic woman");
    // And it must actually have ADDED something — a no-op "improvement"
    // would leave the thin description exactly as thin.
    expect(suggestion.description.length).toBeGreaterThan("an athletic woman".length);
  });

  it("suggests different filler details for a product than for a character", async () => {
    const { improveDescriptionText } = await import("./claude");

    const character = await improveDescriptionText({
      description: "a woman",
      subject: "character",
    });
    const product = await improveDescriptionText({
      description: "a pouch",
      subject: "product",
    });

    expect(character.description).not.toEqual(product.description);
  });
});

describe("describePhotoAppearance (MODE=development)", () => {
  it("returns a non-empty appearance description without ever fetching imageUrl", async () => {
    const { describePhotoAppearance } = await import("./claude");

    // The mock fixture must not depend on imageUrl at all under MODE=development
    // — same "never touch the real input under mock mode" contract mockScene()
    // holds for scriptLine. A garbage URL succeeding here IS the assertion.
    const result = await describePhotoAppearance({ imageUrl: "not-a-real-url" });

    expect(result.description.length).toBeGreaterThan(0);
  });
});

describe("describeReferenceImage's system prompt forbids transcribing text", () => {
  // A behavioural test is impossible here — this is a real vendor call, not
  // something MODE=development stands in for the way it does elsewhere in
  // this file. So this guards the INSTRUCTION itself, the way
  // lib/vendor-gate-seam.test.ts asserts things about source text rather than
  // running the code.
  //
  // If this instruction is ever dropped from the system prompt, a vision call
  // is free to read a logo or label out loud — "a pouch reading KINOKO" — and
  // Seedance paints those letters into the frame. This codebase has paid for
  // that mistake twice already.
  //
  // /ugc sends the reference image too now, which does not make this safe:
  // the description is still prose the model reads, and a quoted word in
  // prose is a word it draws.
  it("tells Claude never to transcribe text it sees in the picture", () => {
    const source = readFileSync(new URL("./claude.ts", import.meta.url), "utf8");

    const start = source.indexOf("export async function describeReferenceImage");
    expect(start, "describeReferenceImage was renamed or removed").toBeGreaterThan(-1);
    // Bounded by whatever is declared NEXT, not by a named neighbour. It
    // used to look for "export const RefinedPrompt", which was deleted with
    // Refine — and because the miss fell back to "to the end of the file",
    // the assertion below quietly widened to the whole module instead of
    // failing. A guard that broadens when its landmark disappears is worse
    // than one that breaks.
    const end = source.indexOf("\nexport ", start + 1);
    expect(end, "describeReferenceImage is the last export; the bound below reads the whole file")
      .toBeGreaterThan(-1);
    const body = source.slice(start, end);

    expect(body).toMatch(/never transcribe text/i);
  });
});
