// @vitest-environment jsdom
//
// Two things this column gets right that nothing was checking, and both of
// them spend money when got wrong.
//
// 1. The button follows the result box: Generate while it is empty,
//    Regenerate once it holds something. Both press-to-spend, so the word has
//    to be right BEFORE the press — an operator who reads "Generate" and gets
//    a re-render of the scene they were only inspecting has been charged for
//    a decision they did not make.
//
// 2. The prompt field re-syncs when the SERVER sends a different scene.
//    Without that, selecting another scene leaves the previous scene's text
//    in the field while everything around it has moved on, and Regenerate
//    bills for a prompt belonging to a clip nobody is looking at. The code
//    for it is four lines of render-phase setState with no effect and no
//    dependency array — the kind that reads as obviously fine and is not.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UgcColumn, type UgcOption } from "./ugc-column";
import { generateClip, regenerateClip } from "@/actions/ugc";
import type { ElementTag } from "@/lib/elements";
import { __resetAllGeneratePendingForTests, getSnapshot } from "@/lib/ugc-generate-pending-store";

vi.mock("@/actions/ugc", () => ({
  generateClip: vi.fn(async () => undefined),
  regenerateClip: vi.fn(async () => undefined),
}));

// A successful Generate now navigates to the new scene (useRouter().push),
// so every render in this file needs a router — plain RTL render() has no
// AppRouterContext of its own, and useRouter() throws without one. Only
// push is exercised below; refresh/replace are stubbed for anything that
// happens to read them.
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  // The new-scene prompt draft persists in localStorage; one test's typing
  // must not refill the next test's box.
  window.localStorage.clear();
  vi.mocked(generateClip).mockReset();
  vi.mocked(generateClip).mockResolvedValue(undefined);
  vi.mocked(regenerateClip).mockReset();
  vi.mocked(regenerateClip).mockResolvedValue(undefined);
  push.mockReset();
  // The pending store is a module singleton (lib/ugc-generate-pending-
  // store.ts's own doc comment) — it outlives any one render() in this file.
  __resetAllGeneratePendingForTests();
});

// modelId is KieModel.id — what app/(app)/ugc/[id]/page.tsx passes
// (`offer.model.id`). This fixture used to carry kieModelName instead
// ("bytedance/seedance-2-5"), which no production code ever puts in this
// field. It mattered: the column pins itself to a model by id, and against
// the old fixture that pin could never match, so every test here silently
// exercised the fallback branch instead of the real one.
/**
 * Every field a NON-Kling fixture needs beyond the four models list below:
 * nativeAudio false (the whole point of the flag — only Kling's own fixture
 * ever sets it true) and no sound/silent rate, since nothing but Kling's own
 * Sound On/Off control ever reads either.
 */
const NOT_KLING = {
  nativeAudio: false,
  soundCreditsPerSecond: null,
  silentCreditsPerSecond: null,
} as const;

const OPTIONS: readonly UgcOption[] = [
  {
    // THE PINNED PAIR since 2026-09-04. Its rate is a receipt — 175.5
    // credits for one 15s 480p render — so `unpaid` is false and the
    // column's caveat correctly does not render for it. The tests that
    // exercise that caveat use UNPAID_OPTIONS below instead of bending this
    // fixture into saying something untrue about the live model.
    modelId: "seedance-2-fast",
    label: "Seedance 2.0 Fast",
    resolution: "480p",
    durationsS: [4, 8],
    creditsPerSecond: 11.7,
    unpaid: false,
    // seedance-2.5 480p's measured with-a-video rate (rates.ts).
    videoCreditsPerSecond: 17,
    ...NOT_KLING,
  },
  {
    modelId: "seedance-2.5-byteplus",
    label: "Seedance 2.5",
    resolution: "480p",
    durationsS: [4, 8],
    creditsPerSecond: 28,
    unpaid: false,
    // seedance-2.5 480p's measured with-a-video rate (rates.ts).
    videoCreditsPerSecond: 17,
    ...NOT_KLING,
  },
  {
    modelId: "seedance-2.5-byteplus",
    label: "Seedance 2.5",
    resolution: "720p",
    durationsS: [4, 8],
    creditsPerSecond: 63,
    unpaid: false,
    // seedance-2.5 480p's measured with-a-video rate (rates.ts).
    videoCreditsPerSecond: 17,
    ...NOT_KLING,
  },
  // Second on purpose, and seven times cheaper. The regression below is only
  // visible when the scene's model is NOT the one options[0] would pick.
  {
    modelId: "hailuo-2.3-pro",
    label: "Hailuo 2.3 Pro",
    resolution: "768P",
    durationsS: [6, 10],
    creditsPerSecond: 9,
    unpaid: false,
    // seedance-2.5 480p's measured with-a-video rate (rates.ts).
    videoCreditsPerSecond: 17,
    ...NOT_KLING,
  },
];

const BUDGET = {
  dailyRemainingUsd: 100,
  dailyCapUsd: 100,
  weeklyRemainingUsd: 500,
  weeklyCapUsd: 500,
  globalRemainingUsd: 1000,
  globalCapUsd: 1000,
};

/**
 * The same options with the pinned pair marked unpaid.
 *
 * The caveat only renders for the option actually in use, so a test about it
 * has to pin to an unpaid pair. Kept separate rather than flipping the flag
 * on OPTIONS, because OPTIONS describes what is really on offer and a rate
 * that carries a receipt must not be described as lacking one.
 */
const UNPAID_OPTIONS: readonly UgcOption[] = OPTIONS.map((o) =>
  o.modelId === "seedance-2.5-byteplus" && o.resolution === "480p" ? { ...o, unpaid: true } : o,
);
const BYTEPLUS_UNPAID_OPTIONS: readonly UgcOption[] = [
  {
    ...OPTIONS[1]!,
    modelId: "seedance-2.5-byteplus",
    label: "Seedance 2.5 · BytePlus ModelArk",
    creditsPerSecond: 20.56005,
    unpaid: true,
  },
];

function renderColumn(
  selectedScene: {
    id: string;
    idx: number;
    prompt: string;
    modelId?: string;
    resolution?: string;
  } | null,
  options: readonly UgcOption[] = OPTIONS,
) {
  return render(
    <UgcColumn
      projectId="proj-1"
      options={options}
      selectedScene={selectedScene}
      budget={BUDGET}
      vendor="kie"
      audioEnabled={false}
      elements={[]}
    />,
  );
}

describe("UgcColumn names the spend before the press", () => {
  it("says Generate when no scene is selected", () => {
    renderColumn(null);

    expect(screen.getByRole("button", { name: /^generate/i })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /regenerate/i }),
      "offered Regenerate with nothing selected — there is no scene to re-render",
    ).toBeNull();
  });

  it("says Regenerate, and names the scene, once one is selected", () => {
    // Naming the scene number matters as much as the verb: the strip can hold
    // a dozen clips and the press bills exactly one of them.
    renderColumn({ id: "scene-1", idx: 3, prompt: "a cat knocks a glass over" });

    expect(screen.getByRole("button", { name: /regenerate scene 3/i })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /^generate ·/i }),
      "offered Generate while a scene was selected — the press re-renders that scene",
    ).toBeNull();
  });
});

describe("Create video prompt draft persistence", () => {
  it("restores the prompt after the composer unmounts and mounts again", async () => {
    const createProps = {
      projectId: "",
      options: OPTIONS,
      selectedScene: null,
      budget: BUDGET,
      vendor: "kie" as const,
      audioEnabled: false,
      elements: [],
      ensureProject: async () => ({ projectId: "personal-project" }),
      layout: "bar" as const,
    };
    const { unmount } = render(<UgcColumn {...createProps} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A product reveal" } });

    expect(window.localStorage.getItem("ugc:draft:create")).toBe("A product reveal");
    unmount();

    render(<UgcColumn {...createProps} />);
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("A product reveal"),
    );
  });
});

describe("UgcColumn's prompt field follows the selected scene", () => {
  it("loads the selected scene's prompt", () => {
    renderColumn({ id: "scene-1", idx: 1, prompt: "a cat knocks a glass over" });

    expect(screen.getByRole("textbox").textContent ?? "").toContain("a cat knocks a glass over");
  });

  it("re-syncs when the server sends a DIFFERENT scene", () => {
    // The regression this pins: without the syncedTo check, this rerender
    // leaves scene 1's prompt in the field while the rest of the column has
    // moved to scene 2, and Regenerate then bills scene 2 for scene 1's text.
    const { rerender } = renderColumn({
      id: "scene-1",
      idx: 1,
      prompt: "a cat knocks a glass over",
    });

    rerender(
      <UgcColumn
        projectId="proj-1"
        options={OPTIONS}
        selectedScene={{ id: "scene-2", idx: 2, prompt: "a dog opens a door" }}
        budget={BUDGET}
        vendor="kie"
        audioEnabled={false}
        elements={[]}
      />,
    );

    const text = screen.getByRole("textbox").textContent ?? "";
    expect(text, "the previous scene's prompt survived the switch").not.toContain(
      "a cat knocks a glass over",
    );
    expect(text).toContain("a dog opens a door");
  });

  it("clears the field when the selection is dropped for a new scene", () => {
    const { rerender } = renderColumn({
      id: "scene-1",
      idx: 1,
      prompt: "a cat knocks a glass over",
    });

    rerender(
      <UgcColumn
        projectId="proj-1"
        options={OPTIONS}
        selectedScene={null}
        budget={BUDGET}
        vendor="kie"
        audioEnabled={false}
        elements={[]}
      />,
    );

    expect(
      screen.getByRole("textbox").textContent ?? "",
      "composing a new scene started with the last scene's prompt already in the box",
    ).not.toContain("a cat knocks a glass over");
  });
});

// ---------------------------------------------------------------------------
// The button and the dialog must quote the same thing.
//
// Found by looking at the screen, not the code: the Regenerate button said
// "252 credits" and the confirm dialog it opened said "$1.26". Both numbers
// were RIGHT — 252 credits is 4s of Seedance 720p at 63 cr/s, and $1.26 is
// that at 200 credits to the dollar — which is exactly what makes it bad. An
// operator with two correct numbers in two units has to do arithmetic to
// convince themselves they are the same spend, at the moment they are being
// asked to approve it.
//
// kie bills credits; dollars are derived. The route quotes credits, so the
// dialog does too, with the dollars kept underneath because the spend caps
// are denominated in them.
// ---------------------------------------------------------------------------

describe("UgcColumn quotes one unit, from the button through to the confirm", () => {
  it("shows the button's price in the dialog, not just on the button", async () => {
    const user = userEvent.setup();
    renderColumn({ id: "scene-1", idx: 3, prompt: "a cat knocks a glass over" });

    const button = screen.getByRole("button", { name: /regenerate scene 3/i });
    const buttonCredits = /\$(\d+\.\d{2})/.exec(button.textContent ?? "")?.[1];
    expect(buttonCredits, "the button does not quote a price at all").toBeTruthy();

    await user.click(button);
    const dialog = await screen.findByRole("dialog");

    expect(
      within(dialog).getAllByText(new RegExp(`\\$${buttonCredits}`)).length,
      `the button quotes $${buttonCredits} and the dialog does not — an operator has to check the two agree while being asked to approve the spend`,
    ).toBeGreaterThan(0);
  });

  it("keeps the dollar figure visible, since the caps are in dollars", async () => {
    // Not a swap. renderCapRefusalMessage quotes DAILY_CAP_USD and friends, so
    // a dialog with no dollars anywhere would refuse in a unit it never showed.
    const user = userEvent.setup();
    renderColumn({ id: "scene-1", idx: 3, prompt: "a cat knocks a glass over" });

    await user.click(screen.getByRole("button", { name: /regenerate scene 3/i }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getAllByText(/\$\d/).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The column must show the settings the render will actually use.
//
// Regenerate submits only sceneId, prompt and versionMode. The model,
// resolution and length come from the scene's stored render_settings_override,
// which is also what rerenderScene prices — so the pickers are not an input on
// this path, they are a REPORT. A column that reported options[0] instead
// quoted one model and rendered another.
//
// That is commit 21bc828's defect ("Price the scene the server is going to
// bill") arriving on a second route. It is the second fixed bug to come back
// on a new surface in one session — the other was `defer store.Close()`
// beating t.Cleanup, fixed in bb67c7e and reintroduced by a new test file. A
// new surface copies the shape and not the lesson, so the lesson gets a test
// this time.
// ---------------------------------------------------------------------------

describe("UgcColumn pins its settings, but the model follows the scene", () => {
  const HAILUO_SCENE = {
    id: "scene-1",
    idx: 3,
    prompt: "a cat knocks a glass over",
    modelId: "hailuo-2.3-pro",
    resolution: "768P",
    durationS: 6,
  };

  // Same pair the column is pinned to (PINNED_MODEL_ID/PINNED_RESOLUTION),
  // so a scene rendered on it exercises the LENGTH/caveat pinning below
  // without the model-follows-scene behaviour (see the describe further
  // down) moving the picker off it first.
  const SEEDANCE_SCENE = {
    id: "scene-1",
    idx: 3,
    prompt: "a cat knocks a glass over",
    modelId: "seedance-2.5-byteplus",
    resolution: "480p",
    durationS: 6,
  };

  it("shows the selected scene's own model, not the pinned pair", () => {
    // This used to assert the opposite: the column opened on the pinned
    // default whatever the scene was rendered with. That was reversed — the
    // model decides which form renders (Kling's frames or Seedance's
    // References box), so opening a Kling scene under the Seedance pin
    // showed the wrong form entirely. An existing scene now opens on ITS
    // own model; only a NEW scene (no modelId) opens on the pin.
    renderColumn(HAILUO_SCENE);
    const model = screen.getByLabelText("Model") as HTMLSelectElement;
    expect(model.selectedOptions[0]?.textContent).toBe("Hailuo 2.3 Pro · 768P");
    expect(model.selectedOptions[0]?.textContent).not.toBe("Seedance 2.5");
  });

  it("shows the pinned length, not the selected scene's own", () => {
    // SEEDANCE_SCENE is 6s and sits on the pinned model/resolution pair — so
    // the model-follows-scene behaviour leaves the picker on Seedance 2.5,
    // and this test still isolates the LENGTH pin: the row says 4s, because
    // 4s is what will render.
    renderColumn(SEEDANCE_SCENE);
    expect(screen.getByText("4s")).toBeTruthy();
    expect(screen.queryByText("6s")).toBeNull();
  });

  it("offers no control at all, since a control that changes nothing is a trap", () => {
    // An editor clicks it, nothing happens, and they learn to distrust the
    // whole row. Asserted structurally because nothing about it is visible.
    renderColumn(HAILUO_SCENE);
    expect(screen.queryByLabelText("Clip length in seconds")).toBeNull();
    expect(screen.queryByTitle("Change model")).toBeNull();
  });

  it("omits the published-rate notice from the prompt controls", () => {
    renderColumn(null, UNPAID_OPTIONS);
    expect(screen.queryByText(/published rate, not a receipt/i)).toBeNull();
  });

  it("carries the unpaid-rate caveat into the confirm, not just onto the page", async () => {
    // The column already says it, but a caveat on the page is one the
    // operator has scrolled past by the time they approve. This is where the
    // money is committed, so the qualification has to travel with the number.
    // A kie model: the pinned BytePlus pair names BytePlus instead (next test).
    const user = userEvent.setup();
    renderColumn(
      { ...SEEDANCE_SCENE, modelId: "hailuo-2.3-pro", resolution: "768P" },
      OPTIONS.map((o) => (o.modelId === "hailuo-2.3-pro" ? { ...o, unpaid: true } : o)),
    );

    await user.click(screen.getByRole("button", { name: /regenerate/i }));
    expect(await screen.findByText(/published figure, not a receipt/i)).toBeTruthy();
  });

  it("names BytePlus ModelArk for the BytePlus option in the confirm", async () => {
    const user = userEvent.setup();
    renderColumn({ ...SEEDANCE_SCENE, modelId: "seedance-2.5-byteplus" }, BYTEPLUS_UNPAID_OPTIONS);

    await user.click(screen.getByRole("button", { name: /regenerate/i }));
    expect(
      await screen.findByText(/BytePlus ModelArk’s published token price, not a receipt/i),
    ).toBeTruthy();
    expect(screen.queryByText(/kie’s published figure/i)).toBeNull();
  });

  it("says so when the pinned pair is not on offer, rather than quietly using another", () => {
    // A pin that cannot be honoured degrades to a working column — but
    // silently rendering a different model under a row that looks deliberate
    // is how the wrong thing gets billed with nobody the wiser.
    render(
      <UgcColumn
        projectId="proj-1"
        options={OPTIONS.filter(
          (o) => !(o.modelId === "seedance-2.5-byteplus" && o.resolution === "480p"),
        )}
        selectedScene={null}
        budget={BUDGET}
        vendor="kie"
        audioEnabled={false}
        elements={[]}
      />,
    );
    expect(screen.getByText(/is not offerable right now/i)).toBeTruthy();
    expect(
      (screen.getByLabelText("Model") as HTMLSelectElement).selectedOptions[0]?.textContent,
    ).toBe("Seedance 2.0 Fast · 480p");
  });
});

describe("the prompt placeholder cannot be mistaken for a written prompt", () => {
  // It was three finished paragraphs of prose in the same monospace face as
  // real text. An operator opened a new project, read it as their own prompt,
  // and asked why Generate was refusing them — nothing was broken, the box
  // was empty and the button said so.
  //
  // Length was not the problem; PROSE was. A finished sentence reads as an
  // answer at a glance whatever its length.
  it("is labelled fragments, not sentences", () => {
    renderColumn(null);
    const box = screen.getByLabelText(/prompt/i);
    const placeholder = box.getAttribute("placeholder") ?? "";

    expect(placeholder, "the placeholder lost its structure hint").toContain("Movement:");

    // No sentence-ending punctuation: a full stop is what makes a fragment
    // read as a finished thought.
    expect(
      /\.\s|\.$/.test(placeholder),
      "the placeholder contains a finished sentence again — an operator will read it as their own prompt",
    ).toBe(false);
  });
});

// Length was hardcoded to 4 while the row beside it claimed it could be
// changed, and the reference ad this route exists to match runs 5.06s a clip.
// These pin that it is a control again, and that changing it repriced the
// button BEFORE anything is spent — a length control that did not move the
// quote would be the same trap the pinned row was.
describe("Length is a control, and it reprices the button", () => {
  it("offers only durations the model sells, and closes once one is picked", async () => {
    const user = userEvent.setup();
    renderColumn(null);

    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Length: 4 seconds" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["4s", "8s"]);
    await user.click(screen.getByRole("menuitem", { name: "8 seconds" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "Length: 8 seconds" })).toBeTruthy();
  });

  it("changes the credits on the button when the length changes", async () => {
    const user = userEvent.setup();
    renderColumn(null);

    // 28 cr/s x 4s.
    expect(screen.getByRole("button", { name: /Generate · \$0\.56/ })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Length: 4 seconds" }));
    await user.click(screen.getByRole("menuitem", { name: "8 seconds" }));

    // 28 cr/s x 8s, quoted before the press rather than discovered after it.
    expect(screen.getByRole("button", { name: /Generate · \$1\.12/ })).toBeTruthy();
  });
});

/**
 * A TAGGED VIDEO IS NOT A STARTING FRAME.
 *
 * The clip's primary reference is one conditioning image, and the FIRST @tag
 * in the prompt claims that slot. Every taggable element used to be a
 * picture, so no filter was needed; 0093 added video and 0079 audio, and the
 * slot kept taking whatever came first.
 *
 * What that cost, on the first real video ever uploaded to production
 * (2026-09-09): the operator writes "@new_video1 in a kitchen", Generate
 * lights up, the spend is approved, and generateClip copies the MP4 under a
 * ref_frame key with a .jpg extension and sends its bytes in
 * reference_image_urls. kie answers code=500 "File type not supported" —
 * after the money is committed, not before.
 *
 * Each of these asserts the ENABLED state as well as the disabled one. A test
 * that only proves the button goes off would also pass against a column that
 * never turns it on.
 */
describe("only a picture can be the clip's starting frame", () => {
  const picture: ElementTag = {
    id: "el-pic",
    name: "jen",
    category: "character",
    description: "a woman in a cream shirt",
    previewUrl: "https://signed.example/jen.jpg",
    assetKind: "character_ref",
  };
  const video: ElementTag = {
    id: "el-vid",
    name: "new_video1",
    category: "video",
    description: "a woman sips from a white mug",
    previewUrl: "https://signed.example/clip.mp4",
    assetKind: "video_ref",
    // MEASURED, because an unmeasured one is a different case with a
    // different answer: it cannot be priced, so Generate stays off and says
    // so. That case has its own test below rather than riding along here
    // and making these assertions pass for the wrong reason.
    durationS: 4.064,
  };
  const voice: ElementTag = {
    id: "el-voice",
    name: "narrator",
    category: "audio",
    description: "a low warm read",
    previewUrl: "https://signed.example/voice.mp3",
    assetKind: "audio",
  };

  /**
   * TYPED, NOT PASSED AS A SELECTED SCENE. The disabled rule under test lives
   * on the Generate branch, which is the no-scene-selected path; handing this
   * column a selectedScene would render Regenerate instead and the assertion
   * would be about a control this change never touched.
   *
   * The first draft of these tests did pass selectedScene={null} and no
   * prompt at all. Three of them went green immediately — because an empty
   * prompt disables the button on its own, so they were passing on the wrong
   * clause and would have kept passing with the video filter deleted.
   */
  function renderWith(prompt: string, elements: readonly ElementTag[]) {
    const result = render(
      <UgcColumn
        projectId="proj-1"
        options={OPTIONS}
        selectedScene={null}
        budget={BUDGET}
        vendor="kie"
        audioEnabled={false}
        elements={elements}
      />,
    );
    fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: prompt } });
    return result;
  }

  it("enables Generate for a plain prompt with no references", () => {
    renderWith("A cat watches the sunset.", []);
    expect(screen.getByRole("button", { name: /^generate/i }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(/references are optional/i)).toBeTruthy();
  });

  // Seedance's multimodal reference mode takes a video with no picture
  // (kie's bytedance/seedance-2-5 schema, read 2026-11-06). The video rides
  // out in reference_video_urls; nothing is sent as a frame.
  it("turns Generate on when the only tag is a video", () => {
    renderWith("@new_video1 in a kitchen", [video]);

    expect(
      screen.getByRole("button", { name: /^generate/i }).hasAttribute("disabled"),
      "refused a video-only prompt — Seedance takes a video reference without a picture",
    ).toBe(false);
  });

  it("says WHY a voice-only prompt is off, rather than asking for a reference already attached", () => {
    renderWith("@narrator reads the line", [voice]);

    // The generic copy is a riddle here: the operator HAS attached a
    // reference and can see its card. Naming the kind is the whole point.
    const note = screen.getByText(/voice tag/i);
    expect(note.textContent).toMatch(/tag a picture or a video too/i);
    expect(
      note.textContent,
      "told the operator the voice is ignored — it is not, it rides out in reference_audio_urls",
    ).toMatch(/still reaches the render/i);
  });

  it("keeps Generate off when the only tag is a voice", () => {
    renderWith("@narrator reads the line", [voice]);

    expect(screen.getByRole("button", { name: /^generate/i }).hasAttribute("disabled")).toBe(true);
  });

  it("turns Generate on for a tagged picture", () => {
    renderWith("@jen in a kitchen", [picture]);

    expect(
      screen.getByRole("button", { name: /^generate/i }).hasAttribute("disabled"),
      "refused a tagged picture — the filter is rejecting the one kind this slot exists for",
    ).toBe(false);
  });

  it("SEEDANCE IS UNTOUCHED: a webp picture tagged in the box still turns Generate on, no Kling errors", () => {
    // Both of CHANGE 1/2's new checks (the @tag refusal and the webp-frame
    // refusal) are gated on isKling — this pins that a Seedance submission
    // carrying BOTH an @tag and a webp reference sails through exactly as it
    // always has, and that neither Kling-only red line ever renders here.
    const webpPicture: ElementTag = {
      ...picture,
      previewUrl: "https://signed.example/jen.webp",
      imageExt: "webp",
    };
    renderWith("@jen in a kitchen", [webpPicture]);

    expect(
      screen.getByRole("button", { name: /^generate/i }).hasAttribute("disabled"),
      "a webp reference disabled Generate on Seedance — this check must be Kling-only",
    ).toBe(false);
    expect(screen.queryByText(/can.t use @tags/i)).toBeNull();
    expect(screen.queryByText(/kling only takes png or jpg frames/i)).toBeNull();
  });

  it("lets a picture take the slot even when a video is tagged first", () => {
    // ORDER IS THE WHOLE TEST. "first tag wins" is the rule the slot runs on,
    // so a video written ahead of the picture is exactly the case where a
    // naive skip-the-video fix still hands the slot to the wrong element.
    renderWith("@new_video1 with @jen in a kitchen", [video, picture]);

    expect(
      screen.getByRole("button", { name: /^generate/i }).hasAttribute("disabled"),
      "a picture was tagged and Generate stayed off — the video consumed the slot instead of being skipped",
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Generate spends, so Generate asks.
//
// It was the last control on this route that submitted straight off the
// press: the form went to generateClip with whatever the pickers happened to
// say, and the operator found out what they had bought afterwards. Regenerate
// beside it has asked since it was written, which made the cheaper-looking
// half of the same column the unguarded one.
// ---------------------------------------------------------------------------

describe("UgcColumn — Generate confirms before it spends", () => {
  // The reference is what makes Generate pressable, and the picker is a
  // separate component with its own dialog. An @tag resolves to the same
  // thing without touching it (see taggedReferences), so the fixture below
  // gives the column one element and the prompt names it.
  const ELEMENTS: readonly ElementTag[] = [
    {
      id: "el-1",
      name: "jen",
      description: "a woman at a counter",
      category: "character",
      previewUrl: "https://storage.test/jen.jpg",
      assetKind: "character_ref",
    },
  ];

  async function openConfirm(): Promise<{
    user: ReturnType<typeof userEvent.setup>;
    dialog: HTMLElement;
  }> {
    const user = userEvent.setup();
    render(
      <UgcColumn
        projectId="proj-1"
        options={OPTIONS}
        selectedScene={null}
        budget={BUDGET}
        vendor="kie"
        elements={ELEMENTS}
        audioEnabled={false}
      />,
    );
    await user.type(screen.getByRole("textbox"), "@jen knocks a glass over");
    // Moves the tag into the box — a new scene's box starts empty, so
    // typing the tag alone is no longer enough to make it the effective
    // reference. See "only a picture can be the clip's starting frame"'s
    // own renderWith for the fuller version of this comment.
    await user.click(screen.getByRole("button", { name: /^Generate ·/ }));
    return { user, dialog: await screen.findByRole("dialog") };
  }

  it("the press opens a confirm and queues nothing", async () => {
    const { dialog } = await openConfirm();

    expect(dialog.textContent).toContain("Generate this clip?");
    expect(
      generateClip,
      "pressing Generate queued the clip before anybody agreed to the price",
    ).not.toHaveBeenCalled();
  });

  it("names the cost and the three settings that decide it", async () => {
    const { dialog } = await openConfirm();

    // 28 cr/s x 4s, the same figure the button quotes, plus the dollars the
    // caps are denominated in.
    expect(dialog.textContent).toContain("$0.56");
    expect(dialog.textContent).toMatch(/\$\d/);
    expect(dialog.textContent).toContain("Seedance 2.5 · 480p · 4s");
  });

  it("queues on Confirm, and a second press cannot queue a second clip", async () => {
    const { user, dialog } = await openConfirm();
    const confirm = within(dialog).getByRole("button", { name: /^confirm/i });

    await user.click(confirm);
    await user.click(confirm);

    await waitFor(() => expect(generateClip).toHaveBeenCalledTimes(1));
    const submitted = vi.mocked(generateClip).mock.calls[0]?.[0] as FormData;
    // The settings that were CONFIRMED, not whatever the pickers might read
    // by the time the action runs.
    expect(submitted.get("modelId")).toBe("seedance-2.5-byteplus");
    expect(submitted.get("resolution")).toBe("480p");
    expect(submitted.get("durationS")).toBe("4");
  });

  it("a successful Generate selects the new scene instead of staying on the composer", async () => {
    // generateClip now returns the new scene's id on success (see
    // GenerateClipResult in actions/ugc.ts) so the operator lands on the
    // clip they just paid for, not on a composer that still reads "+ New
    // scene".
    vi.mocked(generateClip).mockResolvedValueOnce({ sceneId: "scene-42" });
    const { user, dialog } = await openConfirm();
    const confirm = within(dialog).getByRole("button", { name: /^confirm/i });

    await user.click(confirm);

    await waitFor(() => expect(push).toHaveBeenCalledWith("/ugc/proj-1?scene=scene-42"));
  });

  it("a failed Generate does not navigate anywhere", async () => {
    vi.mocked(generateClip).mockResolvedValueOnce({ error: "Daily cap reached." });
    const { user, dialog } = await openConfirm();
    const confirm = within(dialog).getByRole("button", { name: /^confirm/i });

    await user.click(confirm);

    await waitFor(() => expect(generateClip).toHaveBeenCalledTimes(1));
    expect(push).not.toHaveBeenCalled();
  });

  it("the strip's placeholder store goes pending before generateClip ever resolves", async () => {
    // THE WHOLE POINT of lib/ugc-generate-pending-store.ts: generateClip
    // takes 4-5s on a real project, and ugc-scene-strip.tsx's placeholder
    // tile (a sibling of this column, reading the same store) has to be
    // able to show up for that whole wait — which is only possible if the
    // store goes pending BEFORE the await, not once the request finally
    // lands. A deferred promise here stands in for that slow request:
    // nothing resolves it until this test says so, so if the store were
    // only written to AFTER the await, this assertion would run with
    // nothing in it yet and catch the regression.
    let resolveGenerate!: (value: { sceneId: string }) => void;
    vi.mocked(generateClip).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGenerate = resolve;
        }),
    );
    const { user, dialog } = await openConfirm();
    const confirm = within(dialog).getByRole("button", { name: /^confirm/i });

    await user.click(confirm);

    await waitFor(() => expect(generateClip).toHaveBeenCalledTimes(1));
    expect(
      getSnapshot("proj-1"),
      "generateClip is still in flight and the store has not gone pending",
    ).toEqual({ sceneId: null });

    resolveGenerate({ sceneId: "scene-42" });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/ugc/proj-1?scene=scene-42"));
  });

  it("cancelling queues nothing", async () => {
    const { user, dialog } = await openConfirm();

    await user.click(within(dialog).getByRole("button", { name: /^cancel/i }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(generateClip).not.toHaveBeenCalled();
  });

  it("re-asks after the settings change, at the new price", async () => {
    const { user, dialog } = await openConfirm();
    expect(dialog.textContent).toContain("$0.56");
    await user.click(within(dialog).getByRole("button", { name: /^cancel/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Length: 4 seconds" }));
    await user.click(screen.getByRole("menuitem", { name: "8 seconds" }));
    await user.click(screen.getByRole("button", { name: /^Generate ·/ }));

    const reopened = await screen.findByRole("dialog");
    expect(reopened.textContent).toContain("$1.12");
    expect(reopened.textContent).toContain("Seedance 2.5 · 480p · 8s");
    expect(generateClip).not.toHaveBeenCalled();
  });
});

/**
 * THE NUMBER ON THE CONFIRM DIALOG IS THE NUMBER kie WILL BILL.
 *
 * #118 made Generate ask before it spends, which is what makes this matter:
 * the dialog's whole job is to show a price the operator can check, and the
 * price it showed was `creditsPerSecond * duration` — the clip alone.
 *
 * A render carrying a video is billed from a different table (17 cr/s over
 * the video's seconds AND the clip's, against 28 over the clip's alone), so
 * that quote was wrong in BOTH directions depending on length: 112 offered
 * against 136 billed at 4s, 224 against 204 at 8s. A confirm showing a wrong
 * price is worse than no confirm — it manufactures the confidence it exists
 * to provide.
 */
describe("the Generate price counts the tagged video", () => {
  const picture: ElementTag = {
    id: "el-pic",
    name: "jen",
    category: "character",
    description: "a woman in a cream shirt",
    previewUrl: "https://signed.example/jen.jpg",
    assetKind: "character_ref",
  };
  const measuredVideo: ElementTag = {
    id: "el-vid",
    name: "clip1",
    category: "video",
    description: "a woman sips",
    previewUrl: "https://signed.example/clip.mp4",
    assetKind: "video_ref",
    durationS: 4.064,
  };
  const unmeasuredVideo: ElementTag = { ...measuredVideo, id: "el-vid2", durationS: null };

  function renderWith(prompt: string, elements: readonly ElementTag[]): void {
    render(
      <UgcColumn
        projectId="proj-1"
        options={OPTIONS}
        selectedScene={null}
        budget={BUDGET}
        vendor="kie"
        audioEnabled={false}
        elements={elements}
      />,
    );
    fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: prompt } });
    // See "only a picture can be the clip's starting frame"'s renderWith for
    // why the tag(s) have to be moved into the box before these assertions
    // mean anything — a new scene's box starts empty.
  }

  it("quotes the clip alone when no video is tagged", () => {
    // The branch that must not move: 28 cr/s x 4s on the pinned pair, the
    // rate six receipts agree on.
    renderWith("@jen sips coffee", [picture]);

    expect(screen.getByRole("button", { name: /^generate · \$0\.56$/i })).toBeTruthy();
  });

  it("adds the video's own seconds, at the video rate", () => {
    // 17 cr/s x (4s clip + 4s video) = 136 credits — the production receipt
    // for exactly this shape (task b0e0a5e8), against the 46.8 the clip-only
    // quote would have shown.
    renderWith("@jen sips coffee, @clip1 style", [picture, measuredVideo]);

    expect(
      screen.getByRole("button", { name: /^generate · \$0\.68$/i }),
      "the confirm still quotes the clip alone on a render kie bills for the video too",
    ).toBeTruthy();
  });

  it("floors the video's seconds, because that is what the receipts show", () => {
    // 4.064 bills as 4: 17 x 8.064 would be 137.1 and the bill was 136.
    renderWith("@jen sips coffee, @clip1 style", [picture, measuredVideo]);

    expect(screen.queryByRole("button", { name: /137/ })).toBeNull();
  });

  it("refuses to quote a video nobody measured, and says why", () => {
    renderWith("@jen sips coffee, @clip1 style", [picture, unmeasuredVideo]);

    const button = screen.getByRole("button", { name: /^generate$/i });
    expect(
      button.hasAttribute("disabled"),
      "offered a price for a render the server will refuse to cost",
    ).toBe(true);
    expect(screen.getByText(/never measured/i).textContent).toMatch(/cannot be priced/i);
  });
});

// ---------------------------------------------------------------------------
// Kling's std tier is real 720p on the wire and priced/billed as 720p — the
// 2026-09-10 operator decision only changes what the SCREEN says. A Tier
// pill that painted the real value would tell an editor their clip is a
// different (cheaper-looking) tier than what actually renders; a hidden
// input relabelled the same way would submit the wrong resolution outright.
// lib/ugc-tier-label.ts is what draws that line — this pins that ugc-column
// actually calls it where display happens and NOWHERE it writes.
// ---------------------------------------------------------------------------

describe("the Tier pill shows /ugc's display label, kie's real resolution stays on the wire", () => {
  const KLING_STD_OPTION: UgcOption = {
    modelId: "kling-3.0-pro",
    label: "Kling 3.0",
    resolution: "720p",
    durationsS: [3, 4, 5, 6],
    creditsPerSecond: 20,
    unpaid: false,
    videoCreditsPerSecond: null,
    nativeAudio: true,
    // Matches creditsPerSecond above (Sound On is the default), and Kling's
    // own measured silent 720p receipt (lib/kie/rates.ts) — the credits
    // quote on "quotes credits off the real 20 cr/s rate" below only holds
    // with Sound On reading the same number this option already carried.
    soundCreditsPerSecond: 20,
    silentCreditsPerSecond: 14,
  };

  /**
   * audioEnabled: true, not the shared renderColumn's hardcoded false — this
   * describe block's whole point is the SOUND rate (20 cr/s), and Kling's
   * own Sound On/Off control (default On) only reads that rate when
   * AUDIO_ENABLED is globally on. Against the shared helper's false, every
   * Kling render here would price off the SILENT rate instead (14 cr/s),
   * which is correct behaviour (spec: sound is off when audio is globally
   * off) but not what these three tests are about.
   */
  function renderKling(
    selectedScene: { id: string; idx: number; prompt: string } | null,
    options: readonly UgcOption[],
  ) {
    return render(
      <UgcColumn
        projectId="proj-1"
        options={options}
        selectedScene={selectedScene}
        budget={BUDGET}
        vendor="kie"
        audioEnabled
        elements={[]}
      />,
    );
  }

  it("shows 480p on the Tier pill while the hidden resolution input still carries 720p", () => {
    const { container } = renderKling(null, [KLING_STD_OPTION]);

    const pill = screen.getByRole("button", { name: "Resolution: 480p" });
    expect(pill).toBeTruthy();
    // ugcTierLabel("kling-3.0-pro", "720p") === "480p" — the pill reads the
    // relabelled value, never the real one.
    expect(pill!.textContent).toContain("480p");
    expect(pill!.textContent).not.toContain("720p");

    // The wire value. A mutation that made ugcTierLabel's relabel leak into
    // the hidden input, or made this input read the label instead of
    // option.resolution, submits the wrong tier to generateClip and this
    // goes red.
    const hiddenInput = container.querySelector('input[name="resolution"]') as HTMLInputElement;
    expect(hiddenInput).toBeTruthy();
    expect(hiddenInput.value).toBe("720p");
  });

  it("offers only priced tiers and switches the price and submitted resolution", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <UgcColumn
        layout="bar"
        projectId="proj-1"
        options={[
          KLING_STD_OPTION,
          {
            ...KLING_STD_OPTION,
            resolution: "1080p",
            creditsPerSecond: 27,
            soundCreditsPerSecond: 27,
            silentCreditsPerSecond: 18,
          },
        ]}
        selectedScene={null}
        budget={BUDGET}
        vendor="kie"
        audioEnabled
        elements={[]}
      />,
    );

    expect(screen.getByRole("button", { name: /generate.*\$0\.40/i })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Resolution: 480p" }));
    expect(screen.getByRole("menuitem", { name: /480p.*\$0\.100\/s/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /1080p.*\$0\.135\/s/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /4K/ })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: /1080p.*\$0\.135\/s/ }));

    expect((container.querySelector('input[name="resolution"]') as HTMLInputElement).value).toBe(
      "1080p",
    );
    expect(screen.getByRole("button", { name: /generate.*\$0\.54/i })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows every supported resolution and disables tiers without a verified price", async () => {
    const user = userEvent.setup();
    const { container } = renderColumn(null, [OPTIONS[1]!]);

    await user.click(screen.getByRole("button", { name: "Resolution: 480p" }));
    expect(
      screen
        .getByRole("menuitem", { name: /720p.*Price unverified/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      screen
        .getByRole("menuitem", { name: /1080p.*Price unverified/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect((container.querySelector('input[name="resolution"]') as HTMLInputElement).value).toBe(
      "480p",
    );
  });

  it("changes aspect ratio from the menu without changing the price", async () => {
    const user = userEvent.setup();
    const { container } = renderKling(null, [KLING_STD_OPTION]);

    await user.click(screen.getByRole("button", { name: /Aspect ratio:/ }));
    await user.click(screen.getByRole("menuitem", { name: "16:9" }));

    expect((container.querySelector('input[name="aspectRatio"]') as HTMLInputElement).value).toBe(
      "16:9",
    );
    expect(screen.getByRole("button", { name: /^generate · \$0\.40$/i })).toBeTruthy();
  });

  it("quotes credits off the real 20 cr/s rate on the Generate button, not a relabelled one", () => {
    renderKling(null, [KLING_STD_OPTION]);
    // 20 cr/s x 4s (the pinned duration) = 80 credits.
    expect(screen.getByRole("button", { name: /^generate · \$0\.40$/i })).toBeTruthy();
  });

  // Same wire-value rule, on the OTHER write path. Regenerate's confirmAction
  // sets formData directly from option.resolution (ugc-column.tsx ~988) — a
  // mutation that swapped it for ugcTierLabel(option.modelId, option.resolution)
  // would still show "480p" correctly on screen and silently submit "480p" to
  // regenerateClip, which stores it in render_settings_override and gets it
  // back from kie as a real, billed 480p-shaped request that does not exist.
  it("submits the real 720p resolution on Regenerate, never the 480p display label", async () => {
    const user = userEvent.setup();
    renderColumn({ id: "scene-9", idx: 2, prompt: "a woman opens a package" }, [KLING_STD_OPTION]);

    await user.click(screen.getByRole("button", { name: /regenerate/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^confirm/i }));

    await waitFor(() => expect(regenerateClip).toHaveBeenCalledTimes(1));
    const submitted = vi.mocked(regenerateClip).mock.calls[0]?.[0] as FormData;
    expect(submitted.get("modelId")).toBe("kling-3.0-pro");
    expect(submitted.get("resolution")).toBe("720p");
  });
});

/**
 * WHY THE PRICE IS UNKNOWN, NOT JUST THAT IT IS.
 *
 * Two different things stop a tagged video being priced, and they want
 * opposite actions from the operator:
 *
 *   the model has no video rate  -> the file is fine; change the model
 *   the file was never measured  -> the model is fine; re-upload the file
 *
 * They were one message until 2026-09-11, and it was the second one. On
 * Kling — which has no video rate at any tier — that sentence is false in
 * every word, and the action it asks for cannot work. The operator
 * re-uploads a perfectly good file, fails again, and finds nothing on
 * screen naming the real cause. #121 reported it; #120 introduced it.
 */
describe("an unpriceable video says which of the two things is wrong", () => {
  const picture: ElementTag = {
    id: "el-pic",
    name: "jen",
    category: "character",
    description: "a woman in a cream shirt",
    previewUrl: "https://signed.example/jen.jpg",
    assetKind: "character_ref",
  };
  const measuredVideo: ElementTag = {
    id: "el-vid",
    name: "clip1",
    category: "video",
    description: "a woman sips",
    previewUrl: "https://signed.example/clip.mp4",
    assetKind: "video_ref",
    durationS: 4.064,
  };
  const unmeasuredVideo: ElementTag = { ...measuredVideo, id: "el-vid2", durationS: null };

  /**
   * A model with no video receipt — Hailuo's real shape, and Seedance 2.0's.
   *
   * WAS KLING, until Kling stopped resolving a prompt's tags into
   * references at all (its own References box and video-tagging mechanism
   * are gone — see the Frame slots tests below). This describe block is
   * about the tag-driven box's own video pricing, which is still exactly
   * how every OTHER model works; Hailuo exercises the identical "no video
   * rate" case without leaning on a mechanism Kling no longer has.
   */
  const NO_VIDEO_RATE: readonly UgcOption[] = [
    {
      modelId: "hailuo-2.3-pro",
      label: "Hailuo 2.3 Pro",
      resolution: "768P",
      durationsS: [5, 10],
      creditsPerSecond: 9,
      unpaid: false,
      videoCreditsPerSecond: null,
      ...NOT_KLING,
    },
  ];

  function renderWith(
    prompt: string,
    elements: readonly ElementTag[],
    options: readonly UgcOption[] = OPTIONS,
  ): void {
    render(
      <UgcColumn
        projectId="proj-1"
        options={options}
        selectedScene={null}
        budget={BUDGET}
        vendor="kie"
        audioEnabled={false}
        elements={elements}
      />,
    );
    fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: prompt } });
    // Same reasoning as the other renderWith helpers in this file — a new
    // scene's box starts empty, so the tag(s) have to be moved in before the
    // video-pricing checks below (which now resolve against the box) see
    // them at all.
  }

  it("names the MODEL when the model is what cannot take a video", () => {
    renderWith("@jen sips, @clip1 style", [picture, measuredVideo], NO_VIDEO_RATE);

    const note = screen.getByText(/cannot take a video reference/i).textContent ?? "";
    expect(note, "did not say which model refuses it").toMatch(/Hailuo 2\.3 Pro/);
    expect(
      note,
      "told the operator to re-upload a file that is fine and whose length is known",
    ).not.toMatch(/never measured|re-upload/i);
  });

  it("names the FILE when the file is what cannot be measured", () => {
    renderWith("@jen sips, @clip1 style", [picture, unmeasuredVideo]);

    const note = screen.getByText(/never measured/i).textContent ?? "";
    expect(note).toMatch(/re-upload/i);
    expect(note, "blamed the model for a file the browser could not decode").not.toMatch(
      /cannot take a video reference/i,
    );
  });

  it("blames the model first when both are true at once", () => {
    // An unmeasured file on a model that could not have taken it anyway.
    // Changing the model is the action that can actually succeed, and
    // re-uploading is the one that cannot, so the model message wins.
    renderWith("@jen sips, @clip1 style", [picture, unmeasuredVideo], NO_VIDEO_RATE);

    expect(screen.getByText(/cannot take a video reference/i)).toBeTruthy();
    expect(screen.queryByText(/never measured/i)).toBeNull();
  });

  it("keeps Generate off in both cases", () => {
    renderWith("@jen sips, @clip1 style", [picture, measuredVideo], NO_VIDEO_RATE);

    expect(screen.getByRole("button", { name: /^generate$/i }).hasAttribute("disabled")).toBe(true);
  });
});

/**
 * A PROMPT TOO LONG FOR THE MODEL IS REFUSED BEFORE THE PRESS.
 *
 * kie answered a real /ugc render with code=422 "The length of 'prompt' must
 * not exceed 2500 characters" on 2026-09-11 — after the confirm dialog had
 * been approved for 80 credits, leaving the scene marked failed and naming
 * a limit nothing in this product knew existed.
 *
 * THE SUBMITTED LENGTH IS THE ONE THAT COUNTS. That render's box held 2,310
 * characters, under the cap; substituting @greta_ref, @mug_ref and @Audio_5
 * for their saved descriptions added 2,430 more and kie saw 4,740. A check
 * against the typed text would have passed it straight through.
 */
describe("a prompt too long for the model never reaches the vendor", () => {
  const picture: ElementTag = {
    id: "el-pic",
    name: "jen",
    category: "character",
    description: "a woman in a cream shirt",
    previewUrl: "https://signed.example/jen.jpg",
    assetKind: "character_ref",
  };
  /** A tag whose description alone blows past Kling's 2,500. */
  const verbose: ElementTag = {
    id: "el-verbose",
    name: "greta",
    category: "character",
    description: "a woman ".repeat(400),
    previewUrl: "https://signed.example/greta.jpg",
    assetKind: "character_ref",
  };

  const KLING: readonly UgcOption[] = [
    {
      modelId: "kling-3.0-pro",
      label: "Kling 3.0",
      resolution: "720p",
      durationsS: [4, 5, 10],
      creditsPerSecond: 20,
      unpaid: false,
      videoCreditsPerSecond: null,
      maxPromptChars: 2500,
      nativeAudio: true,
      soundCreditsPerSecond: 20,
      silentCreditsPerSecond: 14,
    },
  ];

  function renderWith(
    prompt: string,
    elements: readonly ElementTag[],
    options: readonly UgcOption[],
  ): void {
    render(
      <UgcColumn
        projectId="proj-1"
        options={options}
        selectedScene={null}
        budget={BUDGET}
        vendor="kie"
        audioEnabled={false}
        elements={elements}
      />,
    );
    fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: prompt } });
    // Same reasoning as the other renderWith helpers in this file — a new
    // scene's box starts empty, so the tag has to be moved in before
    // Generate's own disabled state means what these assertions expect.
    // Kling has no box at all (see the Frame slots tests below), so this is
    // a no-op there — queryByRole finds nothing to click.
  }

  /** Fills Kling's Start frame slot via the same picker dialog flow the Frame slots tests below use. */
  async function pickKlingStartFrame(
    user: ReturnType<typeof userEvent.setup>,
    name: string,
  ): Promise<void> {
    await user.click(screen.getByRole("button", { name: /^start frame/i }));
    await user.click(
      await screen.findByRole("button", { name: new RegExp(`^show @${name}$`, "i") }),
    );
    await user.click(await screen.findByRole("button", { name: /^use element$/i }));
  }

  it("refuses a Kling prompt over the cap — TYPED length, not a substitution", () => {
    // KLING NEVER SUBSTITUTES (no box, no tag resolution — see the Frame
    // slots tests below), so the only way past the cap now is a prompt that
    // is actually this long as typed. This replaces the old "substitution
    // pushes it over" test, which relied on a mechanism Kling no longer has.
    const typed = "a".repeat(2501);
    renderWith(typed, [], KLING);

    expect(
      screen.getByRole("button", { name: /^generate/i }).hasAttribute("disabled"),
      "offered a render kie refuses with a 422 after the spend is approved",
    ).toBe(true);
    expect(screen.getByText(/characters over/i).textContent).toMatch(/Kling 3\.0/);
  });

  it("says by how much, without claiming a substitution Kling never does", () => {
    renderWith("a".repeat(2501), [], KLING);

    const note = screen.getByText(/characters over/i).textContent ?? "";
    expect(note).toMatch(/Kling 3\.0/);
    expect(note).toMatch(/2,500/);
    // NOT "every @tag is replaced by its full description" — that sentence
    // is Seedance's own mechanism (the box) and is false for Kling, which
    // sends the prompt exactly as typed.
    expect(note).not.toMatch(/replaced by its full description/i);
  });

  it("allows a short prompt on the same model, once a Start frame is picked", async () => {
    // The other half: a cap that refused everything would pass the test above.
    // Tag-free: Kling refuses any @tag outright now (see "Kling mode" below),
    // so this has to be a plain prompt to isolate what THIS test checks.
    const user = userEvent.setup();
    renderWith("jen sips coffee", [picture], KLING);
    await pickKlingStartFrame(user, "jen");

    expect(screen.getByRole("button", { name: /^generate ·/i }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("LEAVES SEEDANCE ALONE, however long the prompt gets", () => {
    // THE REGRESSION THIS GUARDS. Seedance declares no maxPromptChars —
    // no Seedance render has ever been refused for length, and several have
    // gone out past 4,000 characters — so the check must be inert for it.
    // A cap accidentally applied to every model would break the route this
    // whole product runs on.
    renderWith("@greta sips coffee", [verbose], OPTIONS);

    expect(
      screen.getByRole("button", { name: /^generate/i }).hasAttribute("disabled"),
      "a model with no declared prompt limit was refused anyway",
    ).toBe(false);
    expect(screen.queryByText(/characters over/i)).toBeNull();
  });

  it("still quotes Seedance's price with a long prompt, unchanged", () => {
    // Not just enabled — priced. 28 cr/s x 4s, the same number a short
    // prompt gets.
    renderWith("@greta sips coffee", [verbose], OPTIONS);

    expect(screen.getByRole("button", { name: /^generate · \$0\.56$/i })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The References box: a per-scene allowlist of element tag names, sitting
// above the prompt. See ugc-column.tsx's own boxElements comment for the
// full argument; these tests pin the shape of it from the outside.
// ---------------------------------------------------------------------------

describe("Kling 4.0 Reference tags", () => {
  const image: ElementTag = {
    id: "el-person",
    name: "person",
    category: "character",
    description: null,
    previewUrl: "https://signed.example/person.png",
    assetKind: "ref_frame",
  };
  const voice: ElementTag = {
    ...image,
    id: "el-voice",
    name: "voice",
    category: "audio",
    assetKind: "audio",
  };
  const options: readonly UgcOption[] = [
    {
      ...OPTIONS[0]!,
      modelId: "kling-4.0-reference",
      label: "Kling 4.0 Reference",
      resolution: "720p",
      creditsPerSecond: 28.5,
      videoCreditsPerSecond: null,
    },
  ];

  it("keeps one Kling model choice and switches endpoints from the prompt's mode controls", async () => {
    const user = userEvent.setup();
    const frames: UgcOption = {
      ...options[0]!,
      modelId: "kling-4.0",
      label: "Kling 4.0",
      nativeAudio: true,
      soundCreditsPerSecond: 28.5,
      silentCreditsPerSecond: 28.5,
    };
    const { container } = render(
      <UgcColumn
        projectId="proj-1"
        options={[frames, ...options]}
        selectedScene={null}
        budget={BUDGET}
        vendor="kie"
        audioEnabled
        elements={[image]}
        layout="bar"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Model: Kling 4.0" }));
    const menu = within(screen.getByRole("menu"));
    expect(menu.getAllByRole("menuitem", { name: /Kling 4.0/ })).toHaveLength(1);
    expect(menu.queryByText("Kling 4.0 Reference")).toBeNull();
    expect(menu.queryByRole("menuitem", { name: /^References/ })).toBeNull();
    expect(menu.queryByRole("menuitem", { name: /^Start\/end frames/ })).toBeNull();
    await user.click(menu.getByRole("menuitem", { name: /Kling 4.0/ }));
    const modes = within(screen.getByRole("group", { name: "Kling 4.0 mode" }));
    await user.click(modes.getByRole("button", { name: "References" }));
    expect(container.querySelector('input[name="modelId"]')?.getAttribute("value")).toBe(
      "kling-4.0-reference",
    );

    await user.click(modes.getByRole("button", { name: "Start/end frames" }));
    expect(container.querySelector('input[name="modelId"]')?.getAttribute("value")).toBe(
      "kling-4.0",
    );
  });

  it("lets an image tag enter the References box without requiring start/end frames", () => {
    const { container } = render(
      <UgcColumn
        projectId="proj-1"
        options={options}
        selectedScene={null}
        budget={BUDGET}
        vendor="kie"
        audioEnabled
        elements={[image]}
      />,
    );
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "@person runs" } });
    expect(screen.getByRole("button", { name: /^generate/i }).hasAttribute("disabled")).toBe(false);
    expect(container.querySelector('input[name="referenceTag"]')?.getAttribute("value")).toBe(
      "person",
    );
    expect(container.querySelector('input[name="startElementId"]')).toBeNull();
  });

  it("explains why an audio tag disables regeneration with Kling 4.0 Reference", () => {
    render(
      <UgcColumn
        projectId="proj-1"
        options={options}
        selectedScene={{
          id: "scene-1",
          idx: 1,
          prompt: "@person runs with @voice",
          referenceTags: ["person", "voice"],
        }}
        budget={BUDGET}
        vendor="kie"
        audioEnabled
        elements={[image, voice]}
      />,
    );
    expect(screen.getByRole("button", { name: /regenerate/i }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Kling 4.0 Reference can't use audio references/)).toBeTruthy();
  });
});

describe("UgcColumn's References box", () => {
  const jen: ElementTag = {
    id: "el-jen",
    name: "jen",
    category: "character",
    description: "a woman in a cream shirt",
    previewUrl: "https://signed.example/jen.jpg",
    assetKind: "character_ref",
  };
  const mia: ElementTag = {
    id: "el-mia",
    name: "mia",
    category: "character",
    description: "a woman with dark hair",
    previewUrl: "https://signed.example/mia.jpg",
    assetKind: "character_ref",
  };
  const ELEMENTS: readonly ElementTag[] = [jen, mia];

  type SceneProp = {
    id: string;
    idx: number;
    prompt: string;
    versionId?: string | null;
    referenceTags?: readonly string[];
  } | null;

  function renderBox(selectedScene: SceneProp, elements: readonly ElementTag[] = ELEMENTS) {
    return render(
      <UgcColumn
        projectId="proj-1"
        options={OPTIONS}
        selectedScene={selectedScene}
        budget={BUDGET}
        vendor="kie"
        audioEnabled={false}
        elements={elements}
      />,
    );
  }

  it("starts empty for a new scene", () => {
    renderBox(null);

    expect(screen.getByText("Add references")).toBeTruthy();
    expect(screen.queryByText("@jen")).toBeNull();
  });

  it("seeds the box from the selected scene's saved reference tags", () => {
    renderBox({ id: "scene-1", idx: 1, prompt: "", referenceTags: ["jen"] });

    expect(screen.getByText("@jen")).toBeTruthy();
    // The seeded tile replaces the empty-state CTA outright.
    expect(screen.queryByText("Add references")).toBeNull();
  });

  it("resets the box when the server sends a different scene", () => {
    const { rerender } = renderBox({
      id: "scene-1",
      idx: 1,
      prompt: "",
      referenceTags: ["jen"],
    });
    expect(screen.getByText("@jen")).toBeTruthy();

    rerender(
      <UgcColumn
        projectId="proj-1"
        options={OPTIONS}
        selectedScene={{ id: "scene-2", idx: 2, prompt: "", referenceTags: ["mia"] }}
        budget={BUDGET}
        vendor="kie"
        audioEnabled={false}
        elements={ELEMENTS}
      />,
    );

    expect(screen.queryByText("@jen"), "scene-1's box survived the switch to scene-2").toBeNull();
    expect(screen.getByText("@mia")).toBeTruthy();
  });

  it("removes a tile on its own × button, by aria-label", () => {
    renderBox({ id: "scene-1", idx: 1, prompt: "", referenceTags: ["jen", "mia"] });

    fireEvent.click(screen.getByRole("button", { name: "Remove @jen" }));

    expect(screen.queryByText("@jen")).toBeNull();
    expect(screen.getByText("@mia")).toBeTruthy();
  });

  it("suggests saved elements outside the box and attaches a picked tag", async () => {
    const user = userEvent.setup();
    renderBox({ id: "scene-1", idx: 1, prompt: "", referenceTags: ["jen"] });

    await user.click(screen.getByRole("textbox"));
    await user.keyboard("@");

    expect(await screen.findByRole("option", { name: /@jen/i })).toBeTruthy();
    await user.click(screen.getByRole("option", { name: /@mia/i }));
    expect(screen.getByRole("button", { name: "Remove @mia" })).toBeTruthy();
  });

  it("attaches directly typed personal tags without an Add step", () => {
    const { container } = renderBox(null);

    fireEvent.change(screen.getByLabelText(/prompt/i), {
      target: { value: "@jen and @mia are here" },
    });

    expect(screen.getByRole("button", { name: "Remove @jen" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove @mia" })).toBeTruthy();
    expect(
      [...container.querySelectorAll('input[name="referenceTag"]')].map(
        (input) => (input as HTMLInputElement).value,
      ),
    ).toEqual(["jen", "mia"]);
    expect(
      screen.getByRole("button", { name: /^generate/i }).hasAttribute("disabled"),
      "Generate stayed off after valid personal tags joined the box",
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Remove @jen" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain("jen and @mia");
    expect(
      [...container.querySelectorAll('input[name="referenceTag"]')].map(
        (input) => (input as HTMLInputElement).value,
      ),
    ).toEqual(["mia"]);
  });

  it("dims a box tile whose tag is not currently in the prompt", () => {
    renderBox({ id: "scene-1", idx: 1, prompt: "a woman walks in", referenceTags: ["jen"] });

    expect(screen.getByText("not in prompt")).toBeTruthy();
  });

  it("caps the box at MAX_REFERENCES and disables Add once full", () => {
    const tenTags = Array.from({ length: 10 }, (_, i) => `ref${i}`);
    const tenElements: readonly ElementTag[] = tenTags.map((name, i) => ({
      id: `el-${i}`,
      name,
      category: "character",
      description: "a reference",
      previewUrl: `https://signed.example/${name}.jpg`,
      assetKind: "character_ref",
    }));

    renderBox({ id: "scene-1", idx: 1, prompt: "", referenceTags: tenTags }, tenElements);

    expect(screen.getByText("10/10")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true);
  });

  it("folds a full box to six chips behind '+N more', and shows every one when expanded", () => {
    const tenTags = Array.from({ length: 10 }, (_, i) => `ref${i}`);
    const tenElements: readonly ElementTag[] = tenTags.map((name, i) => ({
      id: `el-${i}`,
      name,
      category: "character",
      description: "a reference",
      previewUrl: `https://signed.example/${name}.jpg`,
      assetKind: "character_ref",
    }));

    renderBox({ id: "scene-1", idx: 1, prompt: "", referenceTags: tenTags }, tenElements);

    // Collapsed: the first six, and the other four only counted — a full box
    // must not push the prompt down the column.
    for (const name of tenTags.slice(0, 6)) expect(screen.getByText(`@${name}`)).toBeTruthy();
    for (const name of tenTags.slice(6)) expect(screen.queryByText(`@${name}`)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "+4 more" }));

    for (const name of tenTags) expect(screen.getByText(`@${name}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
  });

  it("refuses a prompt whose direct tags exceed the reference limit", () => {
    const nineTags = Array.from({ length: 9 }, (_, i) => `ref${i}`);
    const nineElements: readonly ElementTag[] = nineTags.map((name, i) => ({
      id: `el-${i}`,
      name,
      category: "character",
      description: "a reference",
      previewUrl: `https://signed.example/${name}.jpg`,
      assetKind: "character_ref",
    }));

    renderBox({ id: "scene-1", idx: 1, prompt: "", referenceTags: nineTags }, [
      ...nineElements,
      jen,
      mia,
    ]);
    fireEvent.change(screen.getByLabelText(/prompt/i), {
      target: { value: "@jen and @mia are here" },
    });

    expect(screen.getByText(/at most 10 references/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /regenerate scene/i }).hasAttribute("disabled")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Kling mode: a Start/End frame pair instead of the References box, no
// prompt autocomplete, and a Sound On/Off control the price actually reads.
// Triggered off option.nativeAudio (the model-table flag), never a string
// compare against "kling-3.0-pro" — see that field's own comment on
// UgcOption.
// ---------------------------------------------------------------------------

describe("Kling mode", () => {
  const jen: ElementTag = {
    id: "el-jen",
    name: "jen",
    category: "character",
    description: "a woman in a cream shirt",
    previewUrl: "https://signed.example/jen.jpg",
    assetKind: "character_ref",
  };
  const mia: ElementTag = {
    id: "el-mia",
    name: "mia",
    category: "character",
    description: "a woman with dark hair",
    previewUrl: "https://signed.example/mia.jpg",
    assetKind: "character_ref",
  };
  /** A non-image reference — must never be pickable for a Kling frame. */
  const voiceClip: ElementTag = {
    id: "el-voice",
    name: "narrator",
    category: "audio",
    description: "a calm voice",
    previewUrl: "https://signed.example/narrator.mp3",
    assetKind: "audio",
  };
  const ELEMENTS: readonly ElementTag[] = [jen, mia, voiceClip];

  const KLING_OPTION: UgcOption = {
    modelId: "kling-3.0-pro",
    label: "Kling 3.0",
    resolution: "720p",
    durationsS: [3, 4, 5, 6],
    creditsPerSecond: 20,
    unpaid: false,
    videoCreditsPerSecond: null,
    nativeAudio: true,
    soundCreditsPerSecond: 20,
    silentCreditsPerSecond: 14,
  };

  function renderKling(
    selectedScene: Parameters<typeof UgcColumn>[0]["selectedScene"] = null,
    elements: readonly ElementTag[] = ELEMENTS,
    audioEnabled = true,
  ) {
    return render(
      <UgcColumn
        projectId="proj-1"
        options={[KLING_OPTION]}
        selectedScene={selectedScene}
        budget={BUDGET}
        vendor="kie"
        audioEnabled={audioEnabled}
        elements={elements}
      />,
    );
  }

  /** Fills a frame slot via the shared picker: open the slot, pick the element, use it. */
  async function pickFrame(
    user: ReturnType<typeof userEvent.setup>,
    slotLabel: "start frame" | "end frame",
    name: string,
  ): Promise<void> {
    await user.click(screen.getByRole("button", { name: new RegExp(`^${slotLabel}`, "i") }));
    await user.click(
      await screen.findByRole("button", { name: new RegExp(`^show @${name}$`, "i") }),
    );
    await user.click(await screen.findByRole("button", { name: /^use element$/i }));
  }

  it("shows Start/End frame slots and hides the References box and the settings-row Upload trigger", () => {
    renderKling();

    expect(screen.getByRole("button", { name: /^start frame/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /end frame/i })).toBeTruthy();
    expect(screen.queryByText(/^references$/i, { selector: "label" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^add references$/i })).toBeNull();
    // The settings row's own "Upload" trigger — see ugc-column.tsx's own
    // comment on why a second "Add references" control makes no sense once
    // there is no box for it to add to.
    expect(screen.queryByRole("button", { name: /^upload$/i })).toBeNull();
  });

  it("seeds the Start frame from the scene's first PICTURE, never a voice clip sorted ahead of it", () => {
    // referenceTags arrive ordered by kind, so "audio" sorts before "image".
    // The regression: a Seedance scene switched to Kling put its voice clip
    // in the Start slot.
    renderKling({
      id: "scene-1",
      idx: 1,
      prompt: "",
      modelId: "seedance-2.5",
      referenceTags: ["narrator", "jen", "mia"],
    });

    expect(screen.getByText("@jen")).toBeTruthy();
    expect(screen.queryByText("@narrator")).toBeNull();
    // A Seedance scene's second picture is a plain reference, not an end
    // frame, so it is not promoted into the End slot.
    expect(screen.queryByText("@mia")).toBeNull();
  });

  it("shows Seedance's References box and Upload trigger unchanged, not the Frame slots", () => {
    render(
      <UgcColumn
        projectId="proj-1"
        options={OPTIONS}
        selectedScene={null}
        budget={BUDGET}
        vendor="kie"
        audioEnabled={false}
        elements={[]}
      />,
    );

    expect(screen.getByText(/^references$/i, { selector: "label" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^start frame/i })).toBeNull();
  });

  it("picker's Elements-only frame slot offers no Uploads tab and no audio/video elements", async () => {
    const user = userEvent.setup();
    renderKling();

    await user.click(screen.getByRole("button", { name: /^start frame/i }));
    await screen.findByRole("dialog");

    expect(screen.queryByRole("tab", { name: /uploads/i })).toBeNull();
    expect(screen.queryByRole("tab", { name: /elements/i })).toBeNull();
    // jen and mia are pictures and show; narrator is audio and must not.
    expect(screen.getByRole("button", { name: /^show @jen$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^show @mia$/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /narrator/i })).toBeNull();
  });

  it("Use element fills the Start slot, not the End slot", async () => {
    const user = userEvent.setup();
    renderKling();

    await pickFrame(user, "start frame", "jen");

    expect(screen.getByRole("button", { name: /^remove start frame$/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^remove end frame$/i })).toBeNull();
    expect(screen.getByText("@jen")).toBeTruthy();
  });

  it("Use element fills the End slot, not the Start slot", async () => {
    const user = userEvent.setup();
    renderKling();

    await pickFrame(user, "end frame", "mia");

    expect(screen.getByRole("button", { name: /^remove end frame$/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^remove start frame$/i })).toBeNull();
    expect(screen.getByText("@mia")).toBeTruthy();
  });

  it("removing a filled slot clears it back to the dashed target", async () => {
    const user = userEvent.setup();
    renderKling();

    await pickFrame(user, "start frame", "jen");
    await user.click(screen.getByRole("button", { name: /^remove start frame$/i }));

    expect(screen.getByRole("button", { name: /^start frame/i })).toBeTruthy();
    expect(screen.queryByText("@jen")).toBeNull();
  });

  it("Generate enables for a prompt without either frame", () => {
    renderKling();
    fireEvent.change(screen.getByLabelText(/prompt/i), {
      target: { value: "a dog skateboarding" },
    });

    expect(screen.getByRole("button", { name: /^generate/i }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(/references are optional/i)).toBeTruthy();
  });

  it("Generate enables once a Start frame is picked — an End frame is never required", async () => {
    const user = userEvent.setup();
    renderKling();
    fireEvent.change(screen.getByLabelText(/prompt/i), {
      target: { value: "a dog skateboarding" },
    });
    await pickFrame(user, "start frame", "jen");

    expect(screen.getByRole("button", { name: /^generate ·/i }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("an @tag in a Kling prompt refuses Generate with a named reason, not the References box's outside-the-box line", async () => {
    // Kling takes only start/end frames; an '@tag' goes out as a plain word
    // the editor never typed and, when it names a video element, broke
    // Kling's own pricing (no video-input rate). So this is a REFUSAL now,
    // not the old informational "sent as plain words" note.
    const user = userEvent.setup();
    renderKling();
    await pickFrame(user, "start frame", "jen");
    fireEvent.change(screen.getByLabelText(/prompt/i), {
      target: { value: "make the @jen dance" },
    });

    expect(screen.getByText(/can.t use @tags/i).textContent).toMatch(/@jen/);
    expect(screen.queryByText(/doesn.t read @tags/i)).toBeNull();
    expect(screen.queryByText(/isn't in this scene.s references/i)).toBeNull();
    expect(screen.queryByText(/aren't in this scene.s references/i)).toBeNull();
    expect(screen.getByRole("button", { name: /^generate/i }).hasAttribute("disabled")).toBe(true);
  });

  it("Sound On (the default) quotes the sound rate; Sound Off quotes the silent rate", async () => {
    const user = userEvent.setup();
    renderKling();
    await pickFrame(user, "start frame", "jen");

    // Sound On by default: 20 cr/s x 4s (the pinned duration) = 80.
    expect(screen.getByRole("button", { name: /^generate · \$0\.40$/i })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /^sound on$/i }));

    // Sound Off: 14 cr/s x 4s = 56.
    expect(screen.getByRole("button", { name: /^generate · \$0\.28$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^sound off$/i })).toBeTruthy();
  });

  it("hides the Sound control, and forces sound off, when AUDIO_ENABLED is globally off", async () => {
    const user = userEvent.setup();
    renderKling(null, ELEMENTS, false);
    await pickFrame(user, "start frame", "jen");

    expect(screen.queryByRole("button", { name: /^sound on$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^sound off$/i })).toBeNull();
    // The disabled chip reads just "Sound off"; the why is on its tooltip.
    expect(screen.getByTitle(/audio is off for every render right now/i)).toBeTruthy();
    // Priced off the SILENT rate (14 cr/s x 4s = 56), not the sound one —
    // the control being hidden must not leave the price still assuming sound.
    expect(screen.getByRole("button", { name: /^generate · \$0\.28$/i })).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/prompt/i), {
      target: { value: "a dog skateboarding" },
    });
    await user.click(screen.getByRole("button", { name: /^generate ·/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^confirm/i }));

    await waitFor(() => expect(generateClip).toHaveBeenCalledTimes(1));
    const submitted = vi.mocked(generateClip).mock.calls[0]?.[0] as FormData;
    expect(submitted.get("sound")).toBe("0");
  });

  it("disables Regenerate too when an operator edits a Kling scene's prompt to add an @tag", () => {
    renderKling({
      id: "scene-1",
      idx: 1,
      prompt: "a dog skateboarding",
      modelId: "kling-3.0-pro",
      referenceTags: ["jen", "mia"],
    });

    expect(screen.getByRole("button", { name: /regenerate/i }).hasAttribute("disabled")).toBe(
      false,
    );

    fireEvent.change(screen.getByLabelText(/prompt/i), {
      target: { value: "a dog skateboarding with @jen" },
    });

    expect(screen.getByText(/can.t use @tags/i).textContent).toMatch(/@jen/);
    expect(screen.getByRole("button", { name: /regenerate/i }).hasAttribute("disabled")).toBe(true);
  });

  it("seeds Start/End from a Kling scene's own referenceTags, in ordinal order", () => {
    renderKling({
      id: "scene-1",
      idx: 1,
      prompt: "a dog skateboarding",
      modelId: "kling-3.0-pro",
      referenceTags: ["jen", "mia"],
    });

    expect(screen.getByText("@jen")).toBeTruthy();
    expect(screen.getByText("@mia")).toBeTruthy();
    // Regenerate, not Generate, once a scene is selected — and it must not
    // be disabled by a missing Start frame it already has.
    expect(screen.getByRole("button", { name: /regenerate/i }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("submits startElementId/endElementId and the sound choice, never the box's referencesBox marker", async () => {
    const user = userEvent.setup();
    renderKling();
    fireEvent.change(screen.getByLabelText(/prompt/i), {
      target: { value: "a dog skateboarding" },
    });
    await pickFrame(user, "start frame", "jen");
    await pickFrame(user, "end frame", "mia");

    await user.click(screen.getByRole("button", { name: /^generate ·/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^confirm/i }));

    await waitFor(() => expect(generateClip).toHaveBeenCalledTimes(1));
    const submitted = vi.mocked(generateClip).mock.calls[0]?.[0] as FormData;
    expect(submitted.get("startElementId")).toBe("el-jen");
    expect(submitted.get("endElementId")).toBe("el-mia");
    expect(submitted.get("sound")).toBe("1");
    expect(submitted.get("referencesBox")).toBeNull();
    expect(submitted.getAll("referenceTag")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The MODEL PICKER follows the scene, the same way prompt/boxTags/frames do
// (the `if (syncKey !== syncedTo)` block in ugc-column.tsx). Left on the
// previous scene's model, a Kling->Seedance switch opened the Seedance scene
// in Kling mode: Frame slots instead of the References box, and "Kling
// doesn't read @tags" over a prompt that was never Kling's.
//
// The pinned pair (seedance-2.5/480p) is what a fresh mount opens on when it
// is on offer, regardless of the scene — see "UgcColumn pins its settings
// instead of following the scene" above. That pin is computed once, from
// `options`, at mount. So a test that wants to OBSERVE the picker at a
// non-pinned model on first render has to mount with the pinned pair absent
// from `options`, then add it back on rerender — exactly the shape these
// tests use.
// ---------------------------------------------------------------------------
describe("the model picker follows the selected scene", () => {
  const KLING_OPTION: UgcOption = {
    modelId: "kling-3.0-pro",
    label: "Kling 3.0",
    resolution: "720p",
    durationsS: [3, 4, 5, 6],
    creditsPerSecond: 20,
    unpaid: false,
    videoCreditsPerSecond: null,
    nativeAudio: true,
    soundCreditsPerSecond: 20,
    silentCreditsPerSecond: 14,
  };
  // options[1] of the shared OPTIONS fixture: seedance-2.5/480p, exactly the
  // PINNED_MODEL_ID/PINNED_RESOLUTION pair, so a mount that offers it always
  // opens on it — used deliberately in test (b) and (c) for that reason.
  const SEEDANCE_OPTION = OPTIONS[1]!;

  function isKlingMode(): boolean {
    return screen.queryByRole("button", { name: /^start frame/i }) !== null;
  }

  it("Kling scene -> Seedance scene: the picker follows, References box replaces Frame slots", () => {
    const { rerender } = render(
      <UgcColumn
        projectId="proj-1"
        options={[KLING_OPTION]}
        selectedScene={{
          id: "scene-1",
          idx: 1,
          prompt: "a dog skateboarding",
          modelId: "kling-3.0-pro",
          resolution: "720p",
        }}
        budget={BUDGET}
        vendor="kie"
        audioEnabled={false}
        elements={[]}
      />,
    );

    // Sanity: this mount really is in Kling mode before the switch.
    expect(screen.getByRole("button", { name: /^start frame/i })).toBeTruthy();
    expect(screen.queryByText(/^references$/i, { selector: "label" })).toBeNull();

    rerender(
      <UgcColumn
        projectId="proj-1"
        options={[KLING_OPTION, SEEDANCE_OPTION]}
        selectedScene={{
          id: "scene-2",
          idx: 2,
          prompt: "a cat opens a door",
          modelId: SEEDANCE_OPTION.modelId,
          resolution: SEEDANCE_OPTION.resolution,
        }}
        budget={BUDGET}
        vendor="kie"
        audioEnabled={false}
        elements={[]}
      />,
    );

    const model = screen.getByLabelText("Model") as HTMLSelectElement;
    expect(model.selectedOptions[0]?.textContent).toBe("Seedance 2.5 · 480p");
    expect(screen.getByText(/^references$/i, { selector: "label" })).toBeTruthy();
    expect(screen.getByText("Add references")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^start frame/i })).toBeNull();
  });

  it("Seedance scene -> Kling scene: the picker follows, Frame slots replace the References box", () => {
    const { rerender } = render(
      <UgcColumn
        projectId="proj-1"
        options={[SEEDANCE_OPTION]}
        selectedScene={{
          id: "scene-1",
          idx: 1,
          prompt: "a cat opens a door",
          modelId: SEEDANCE_OPTION.modelId,
          resolution: SEEDANCE_OPTION.resolution,
        }}
        budget={BUDGET}
        vendor="kie"
        audioEnabled={false}
        elements={[]}
      />,
    );

    // Sanity: this mount really is in Seedance mode before the switch.
    expect(screen.getByText(/^references$/i, { selector: "label" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^start frame/i })).toBeNull();

    rerender(
      <UgcColumn
        projectId="proj-1"
        options={[SEEDANCE_OPTION, KLING_OPTION]}
        selectedScene={{
          id: "scene-2",
          idx: 2,
          prompt: "a dog skateboarding",
          modelId: "kling-3.0-pro",
          resolution: "720p",
        }}
        budget={BUDGET}
        vendor="kie"
        audioEnabled={false}
        elements={[]}
      />,
    );

    const model = screen.getByLabelText("Model") as HTMLSelectElement;
    expect(model.selectedOptions[0]?.textContent).toBe("Kling 3.0 · 480p");
    expect(screen.getByRole("button", { name: /^start frame/i })).toBeTruthy();
    expect(screen.queryByText(/^references$/i, { selector: "label" })).toBeNull();
  });

  it("a manual pick survives a NEW scene (no modelId to follow)", () => {
    const { rerender } = render(
      <UgcColumn
        projectId="proj-1"
        options={[SEEDANCE_OPTION, KLING_OPTION]}
        selectedScene={{
          id: "scene-1",
          idx: 1,
          prompt: "a cat opens a door",
          modelId: SEEDANCE_OPTION.modelId,
          resolution: SEEDANCE_OPTION.resolution,
        }}
        budget={BUDGET}
        vendor="kie"
        audioEnabled={false}
        elements={[]}
      />,
    );

    // The operator overrides the pinned Seedance pick with Kling, for this
    // one clip — the picker is a default, not a law (ugc-column.tsx's own
    // comment on modelIdx).
    const model = screen.getByLabelText("Model") as HTMLSelectElement;
    fireEvent.change(model, { target: { value: "1" } });
    expect(isKlingMode()).toBe(true);

    // A NEW scene: selectedScene drops to null, same as composing a fresh
    // clip. There is no modelId to follow, so the manual pick must survive.
    rerender(
      <UgcColumn
        projectId="proj-1"
        options={[SEEDANCE_OPTION, KLING_OPTION]}
        selectedScene={null}
        budget={BUDGET}
        vendor="kie"
        audioEnabled={false}
        elements={[]}
      />,
    );

    const modelAfter = screen.getByLabelText("Model") as HTMLSelectElement;
    expect(modelAfter.selectedOptions[0]?.textContent).toBe("Kling 3.0 · 480p");
    expect(isKlingMode()).toBe(true);
  });

  it("a version switch on the SAME scene re-syncs to the scene's model too — even over a manual override", () => {
    // syncKey is `${id}:${versionId}`, not just the scene id (see
    // ugc-column.tsx's own comment on why the version half is not optional:
    // a version snapshots its own prompt). That means switching versions of
    // one scene re-runs the whole sync block, including the picker-follows
    // fix — so an operator's manual model override for "this one clip" does
    // not survive a version switch either. Asserting that as current
    // behaviour, not endorsing it: a version switch is not the same
    // operator intent as picking a different scene, and re-snapping the
    // picker there arguably surprises the operator the same way the
    // original bug did. Flagging it rather than silently deciding it's fine.
    const { rerender } = render(
      <UgcColumn
        projectId="proj-1"
        options={[SEEDANCE_OPTION, KLING_OPTION]}
        selectedScene={{
          id: "scene-1",
          idx: 1,
          prompt: "a cat opens a door",
          modelId: SEEDANCE_OPTION.modelId,
          resolution: SEEDANCE_OPTION.resolution,
          versionId: "v1",
        }}
        budget={BUDGET}
        vendor="kie"
        audioEnabled={false}
        elements={[]}
      />,
    );

    const model = screen.getByLabelText("Model") as HTMLSelectElement;
    fireEvent.change(model, { target: { value: "1" } });
    expect(isKlingMode()).toBe(true);

    // Same scene id, a different version, same modelId as v1 — only the
    // syncKey changes.
    rerender(
      <UgcColumn
        projectId="proj-1"
        options={[SEEDANCE_OPTION, KLING_OPTION]}
        selectedScene={{
          id: "scene-1",
          idx: 1,
          prompt: "a cat opens a door, slower",
          modelId: SEEDANCE_OPTION.modelId,
          resolution: SEEDANCE_OPTION.resolution,
          versionId: "v2",
        }}
        budget={BUDGET}
        vendor="kie"
        audioEnabled={false}
        elements={[]}
      />,
    );

    const modelAfter = screen.getByLabelText("Model") as HTMLSelectElement;
    expect(modelAfter.selectedOptions[0]?.textContent).toBe("Seedance 2.5 · 480p");
    expect(isKlingMode()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE SELECT LIES AFTER A FAILED SUBMIT. React 19 resets a `<form action>`
// (a native form.reset()) after every action that returns, error included.
// A controlled <input>/<textarea> survives that because React keeps their
// `defaultValue` in step with `value`, but a controlled <select>'s <option>s
// carry no such default, so the native reset snaps the DOM display back to
// options[0] (Seedance) while modelIdx/the hidden inputs/the rest of the
// form stay on whatever was actually picked. The fix (ugc-column.tsx's
// `reset` listener on the select's form, queued to run just after the
// browser's own reset) is what this test is pinning.
//
// A REAL submit, not a handler called by hand: mounting/calling by hand
// proves nothing here — the whole bug is what the BROWSER does to the DOM
// after React's own action machinery runs, which only a real
// dispatchEvent-driven form.requestSubmit()/click cycle can exercise.
// ---------------------------------------------------------------------------

describe("the Model select survives React 19's form.reset() after a failed Generate", () => {
  const jen: ElementTag = {
    id: "el-jen",
    name: "jen",
    category: "character",
    description: "a woman in a cream shirt",
    previewUrl: "https://signed.example/jen.jpg",
    assetKind: "character_ref",
  };
  const KLING_OPTION: UgcOption = {
    modelId: "kling-3.0-pro",
    label: "Kling 3.0",
    resolution: "720p",
    durationsS: [3, 4, 5, 6],
    creditsPerSecond: 20,
    unpaid: false,
    videoCreditsPerSecond: null,
    nativeAudio: true,
    soundCreditsPerSecond: 20,
    silentCreditsPerSecond: 14,
  };
  // options[1] of the shared OPTIONS fixture: seedance-2.5/480p — options[0]
  // in the combined array below is Kling, so a reset that reverts to
  // options[0] shows THIS text, exactly the failure this test would catch.
  const SEEDANCE_OPTION = OPTIONS[1]!;

  async function submitAFailingKlingGenerate(): Promise<{
    user: ReturnType<typeof userEvent.setup>;
    select: HTMLSelectElement;
  }> {
    const user = userEvent.setup();
    render(
      <UgcColumn
        projectId="proj-1"
        options={[SEEDANCE_OPTION, KLING_OPTION]}
        selectedScene={null}
        budget={BUDGET}
        vendor="kie"
        audioEnabled
        elements={[jen]}
      />,
    );

    // Mounts on Seedance (options[0], the pinned pair) — the switch to
    // Kling below is the operator's own pick, exactly "the picker switched
    // to Kling" this test is about.
    const select = screen.getByLabelText("Model") as HTMLSelectElement;
    await user.selectOptions(select, "1");
    expect(select.selectedOptions[0]?.textContent).toBe("Kling 3.0 · 480p");

    fireEvent.change(screen.getByLabelText(/prompt/i), {
      target: { value: "a dog skateboarding" },
    });
    await user.click(screen.getByRole("button", { name: /^start frame/i }));
    await user.click(await screen.findByRole("button", { name: /^show @jen$/i }));
    await user.click(await screen.findByRole("button", { name: /^use element$/i }));

    vi.mocked(generateClip).mockResolvedValueOnce({ error: "Daily cap reached." });
    await user.click(screen.getByRole("button", { name: /^generate ·/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^confirm/i }));

    await waitFor(() => expect(generateClip).toHaveBeenCalledTimes(1));
    // The action has resolved and React 19 has run its post-action
    // form.reset() by the time this settles — nothing left to await.
    return { user, select };
  }

  it("keeps showing Kling in the select's DOM value and selected option text", async () => {
    const { select } = await submitAFailingKlingGenerate();

    expect(select.value, "the select's DOM value reverted to Seedance").toBe("1");
    expect(
      select.selectedOptions[0]?.textContent,
      "the visible option text reverted to Seedance",
    ).toBe("Kling 3.0 · 480p");
  });
});
