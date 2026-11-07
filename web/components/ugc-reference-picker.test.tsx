// @vitest-environment jsdom
//
// The object-URL lifecycle in here has one asymmetry that is easy to "tidy"
// into a bug, and the component says so in a comment: the save must NOT
// revoke the preview URL, because that exact string has just become the
// parent's `current.previewUrl` and is still painting the trigger's own
// thumbnail. Revoking it blanks that thumbnail the instant the dialog closes
// — a broken image with no error anywhere, and only after a save that
// otherwise worked. The asymmetry survived the two buttons being merged into
// one: saveElement deliberately does not call resetUploadState on the path
// that attaches.
//
// Everything else here leaks or blanks in the other direction, so both
// directions are asserted: replacing a file DOES revoke the one it replaces,
// and closing without picking DOES revoke.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ElementTag } from "@/lib/elements";

// EVERY REFUSAL IS A TOAST NOW, not a line under the dropzone. The line sat
// below the fold once a batch filled the panel, so the file that was left out
// went unmentioned exactly when there were enough files to lose one in.
//
// The two halves are joined into one string here on purpose: every assertion
// below then covers BOTH the title and the description, so a message that
// keeps its heading and loses the sentence explaining what to do about it
// fails rather than passing on the half that survived.
// A NOTICE (registerElement reporting an audio describe that failed) is
// surfaced through the bare `toast(message, opts)` call, same as action-
// form.tsx's own ActionNotice handling — real sonner's `toast` IS a callable
// function with `.error` (and others) hung off it, not a plain object, so
// the mock has to be shaped the same way or calling it directly throws
// "toast is not a function" the moment this file exercises that path.
//
// vi.hoisted, not a plain top-level const: vi.mock's factory below is
// hoisted above every other statement in this file, so a `const` declared
// the ordinary way is still in its temporal dead zone when the factory runs
// — the exact error this construction avoids.
const { toastError, toastNotice } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastNotice: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: Object.assign((message: string) => toastNotice(message), {
    error: (title: string, opts?: { description?: string }) =>
      toastError(`${title} — ${opts?.description ?? ""}`),
  }),
}));

vi.mock("@/lib/stage-files", () => ({ stageFiles: vi.fn(async () => {}) }));

vi.mock("@/actions/check-element-upload-name", () => ({
  checkElementUploadName: vi.fn(async () => null),
}));

vi.mock("@/actions/elements", () => ({
  registerElement: vi.fn(async () => undefined),
  updateElement: vi.fn(async () => undefined),
  deleteElement: vi.fn(async () => undefined),
}));

// The describe actions are mocked so the panel's "Describe again" can be
// pressed without a Claude call — and so the test below can say exactly what
// came back.
vi.mock("@/actions/ugc", () => ({
  redescribeElement: vi.fn(async () => ({ description: "a woman in a red coat, mid-stride" })),
  describeUploadedReference: vi.fn(async () => ({ description: "unused here" })),
}));

import { registerElement, updateElement } from "@/actions/elements";
import { UgcReferencePicker, type PickedReference } from "./ugc-reference-picker";

const ELEMENTS: readonly ElementTag[] = [
  {
    id: "el-1",
    name: "jen",
    category: "image",
    description: "the presenter",
    assetKind: "ref_frame" as const,
    previewUrl: "https://example.test/jen.jpg",
  },
  {
    id: "el-2",
    name: "bottle",
    category: "product",
    description: null,
    assetKind: "ref_frame" as const,
    previewUrl: "https://example.test/bottle.jpg",
  },
];

let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;

beforeEach(() => {
  let n = 0;
  vi.spyOn(window, "confirm").mockReturnValue(true);
  createObjectURL = vi.fn(() => `blob:fake/${++n}`);
  revokeObjectURL = vi.fn();
  // jsdom implements neither, so they are installed rather than spied on.
  Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, writable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, writable: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  // The Audio stub is global; leaving it installed would decide the duration
  // for every later test in the file.
  vi.unstubAllGlobals();
});

function renderPicker(current: PickedReference | null = null, allowVideoPrimary = false) {
  const onPick = vi.fn();
  const { unmount } = render(
    <UgcReferencePicker
      projectId="proj-1"
      elements={ELEMENTS}
      current={current}
      onPick={onPick}
      allowVideoPrimary={allowVideoPrimary}
    />,
  );
  return { onPick, unmount };
}

function anImage(name = "ref.png") {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

function anAudio(name = "voice.mp3") {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "audio/mpeg" });
}

function aVideo(name = "clip.mp4") {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "video/mp4" });
}

/**
 * A file that reports a size without holding the bytes.
 *
 * Allocating 16 MB of real Uint8Array per size test is seconds of wall clock
 * for a check that only ever reads `.size`.
 */
function big(name: string, type: string, size: number): File {
  const f = new File([new Uint8Array([1])], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

/**
 * Makes `new Audio()` answer with a fixed duration.
 *
 * jsdom implements no media element — it neither loads a src nor fires
 * loadedmetadata — so the component's probe would hang forever and the
 * duration rule would be the one rule with no test. `seconds: null` fires
 * the error path instead, which is the unmeasurable-file case.
 */
function stubAudioDuration(seconds: number | null): void {
  vi.stubGlobal(
    "Audio",
    class {
      duration = seconds ?? Number.NaN;
      preload = "";
      #listeners: Record<string, (() => void)[]> = {};
      addEventListener(event: string, fn: () => void): void {
        (this.#listeners[event] ??= []).push(fn);
      }
      set src(_value: string) {
        // Asynchronously, like the real one: the component adds both
        // listeners after setting nothing else, and a synchronous fire here
        // would run them before they exist.
        queueMicrotask(() => {
          for (const fn of this.#listeners[seconds === null ? "error" : "loadedmetadata"] ?? []) {
            fn();
          }
        });
      }
    },
  );
}

/**
 * Makes `document.createElement("video")` answer with a fixed duration —
 * videoDurationSeconds' own probe, same reason and same unmeasurable-file
 * convention (`seconds: null` fires `error` rather than `loadedmetadata`)
 * as stubAudioDuration above.
 *
 * SCOPED TO THE "video" TAG ONLY, unlike stubAudioDuration's global `Audio`
 * stub — document.createElement is what every OTHER element in this
 * component's own render tree goes through too, a real <video> preview
 * (the selected-element detail panel) included, so intercepting every tag
 * would pull the DOM out from under React mid-test. Every non-"video" call
 * falls straight through to the real implementation.
 *
 * MUST BE RESTORED BY THE CALLER (`.mockRestore()`) — a vi.spyOn survives
 * this file's shared `afterEach` (which clears mock call history and
 * un-stubs vi.stubGlobal, neither of which touches a spy's implementation)
 * untouched, and a stub left standing would answer for every "video" tag
 * every later test in this file renders.
 */
function stubVideoDuration(seconds: number | null) {
  const real = document.createElement.bind(document);
  return vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
    if (tagName !== "video") return real(tagName);
    const probe = {
      duration: seconds ?? Number.NaN,
      preload: "",
      listeners: {} as Record<string, (() => void)[]>,
      addEventListener(event: string, fn: () => void): void {
        (probe.listeners[event] ??= []).push(fn);
      },
      set src(_value: string) {
        queueMicrotask(() => {
          for (const fn of probe.listeners[seconds === null ? "error" : "loadedmetadata"] ?? []) {
            fn();
          }
        });
      },
    };
    return probe as unknown as HTMLVideoElement;
  }) as typeof document.createElement);
}

/** Opens the modal and returns the hidden file input inside it. */
async function openPicker(user: ReturnType<typeof userEvent.setup>, triggerName: RegExp) {
  await user.click(screen.getByRole("button", { name: triggerName }));
  const dialog = await screen.findByRole("dialog");
  const fileInput = dialog.querySelector('input[type="file"]');
  if (!(fileInput instanceof HTMLInputElement)) throw new Error("no file input in the dialog");
  return { dialog, fileInput };
}

async function submitPendingFiles(
  user: ReturnType<typeof userEvent.setup>,
  count = 1,
): Promise<void> {
  const fields = screen.getAllByRole("textbox", { name: /tag name for/i });
  for (const [index, field] of fields.entries()) {
    if (!(field instanceof HTMLInputElement) || field.value) continue;
    await user.type(field, `reference_${index + 1}`);
  }
  await user.click(
    screen.getByRole("button", {
      name: count > 1 ? new RegExp(`^upload ${count}$`, "i") : /^upload$/i,
    }),
  );
}

describe("UgcReferencePicker hands the preview URL over rather than revoking it", () => {
  it("does not revoke the URL it just gave the parent", async () => {
    // The whole reason the attaching path does not call resetUploadState():
    // that URL is now the trigger's thumbnail. Revoking it here is a blank
    // image with no error, visible only after a save that otherwise worked.
    const user = userEvent.setup();
    const { onPick } = renderPicker();

    const { fileInput } = await openPicker(user, /^upload$/i);
    await user.upload(fileInput, anImage());
    await submitPendingFiles(user);

    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    const picked = onPick.mock.calls[0]?.[0] as PickedReference;
    expect(picked.kind).toBe("upload");

    expect(
      revokeObjectURL,
      "the URL handed to the parent was revoked — the trigger's thumbnail is now blank",
    ).not.toHaveBeenCalledWith(picked.previewUrl);
  });

  it("keeps both when a second file is chosen, and revokes neither", async () => {
    // THIS USED TO ASSERT THE OPPOSITE, and the opposite used to be right: a
    // second pick REPLACED the first, so not revoking the old URL leaked a
    // blob on every re-pick.
    //
    // A second pick now APPENDS. An operator filling a library is gathering,
    // not correcting, and revoking the first URL here would blank the preview
    // of a file that is still in the batch and still about to upload.
    const user = userEvent.setup();
    renderPicker();

    const { fileInput } = await openPicker(user, /^upload$/i);
    await user.upload(fileInput, anImage("first.png"));
    const first = createObjectURL.mock.results[0]?.value as string;

    await user.upload(fileInput, anImage("second.png"));

    expect(await screen.findByText("second.png")).toBeTruthy();
    expect(screen.getByText("first.png")).toBeTruthy();
    expect(revokeObjectURL).not.toHaveBeenCalledWith(first);
  });

  it("revokes only the file removed from the batch", async () => {
    // The leak this replaces. Removing one row must free its own URL and
    // leave every other preview painting.
    const user = userEvent.setup();
    renderPicker();

    const { fileInput } = await openPicker(user, /^upload$/i);
    await user.upload(fileInput, anImage("keep.png"));
    const kept = createObjectURL.mock.results[0]?.value as string;
    await user.upload(fileInput, anImage("drop-me.png"));
    const dropped = createObjectURL.mock.results[1]?.value as string;

    await user.click(await screen.findByRole("button", { name: /remove drop-me/i }));

    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith(dropped));
    expect(revokeObjectURL).not.toHaveBeenCalledWith(kept);
  });

  it("revokes when the dialog is closed without picking anything", async () => {
    const user = userEvent.setup();
    renderPicker();

    const { fileInput } = await openPicker(user, /^upload$/i);
    await user.upload(fileInput, anImage());
    const url = createObjectURL.mock.results[0]?.value as string;

    await user.keyboard("{Escape}");

    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith(url));
  });
});

describe("UgcReferencePicker's two ways in stay distinct", () => {
  // Distinct in WHAT THEY HAND BACK, which is the part that matters to the
  // parent: an upload arrives as a File it must still upload itself, an
  // element arrives as an id whose image the server already holds. They are
  // no longer distinct in how many presses they take — saving and attaching
  // were merged into one button.
  it("hands back the FILE itself for an upload, even though it also saves", async () => {
    const user = userEvent.setup();
    const { onPick } = renderPicker();

    const { fileInput } = await openPicker(user, /^upload$/i);
    await user.upload(fileInput, anImage("shot.png"));
    await submitPendingFiles(user);

    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    const picked = onPick.mock.calls[0]?.[0] as PickedReference;
    if (picked.kind !== "upload") throw new Error("expected an upload");
    expect(picked.file.name).toBe("shot.png");
    expect(picked.name).toBe("shot.png");
  });

  // THE ELEMENT PICK IS GONE, and its test with it. Clicking a saved
  // reference used to hand the parent an elementId and close the dialog; the
  // Elements tab is a library manager now, and a reference reaches a clip by
  // being typed as @name in the prompt — which is the prompt editor's
  // autocomplete, tested in ugc-prompt-editor.test.tsx.
  //
  // PickedReference still carries the "element" branch, because the parent
  // renders one when a project already has an element-backed reference. What
  // no longer exists is this component producing it.

  it("cannot be saved, and cannot attach, before a file is chosen", async () => {
    // Guarded twice on purpose. The button is disabled, so a real operator
    // cannot reach it — and saveElement still checks for the file before
    // calling onPick, because the disabled attribute is markup and the
    // handler is the thing that spends.
    const user = userEvent.setup();
    const { onPick } = renderPicker();

    await openPicker(user, /^upload$/i);
    const save = screen.getByRole("button", { name: /^upload$/i });
    expect(save.hasAttribute("disabled")).toBe(true);

    await user.click(save);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("attaches the file AND registers the element from one press", async () => {
    // The merge itself. Before this, pressing the save left the clip
    // unattached and the dialog open, and the operator had no sign that half
    // the job was still undone.
    const user = userEvent.setup();
    const { onPick } = renderPicker();

    const { fileInput } = await openPicker(user, /^upload$/i);
    await user.upload(fileInput, anImage("lena.png"));
    await submitPendingFiles(user);

    await waitFor(() => expect(registerElement).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("$0.0150"));

    const picked = onPick.mock.calls[0]?.[0] as PickedReference;
    if (picked.kind !== "upload") throw new Error("expected an upload");
    expect(picked.file.name).toBe("lena.png");

    // AND IT STAYS OPEN. It used to close, which was right when an upload was
    // one file and the save WAS the pick. Filling a library is a different
    // act: closing on the last save takes the operator away from the tab they
    // are working in, with no sight of what landed and no way to add more.
    // What tells them the job is done is the line that says so.
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(await screen.findByText(/1 reference saved/i)).toBeTruthy();
  });

  it("toasts a notice, and still saves, when registerElement reports a failed describe", async () => {
    // registerElement's own tests (actions/elements.test.ts) pin the server
    // half: an audio upload that could not be described comes back an
    // ActionNotice, never an ActionResult error — the upload worked, only
    // the describe did not. This is the client half: a notice must reach
    // the operator (toast, the same "not toast.error" treatment action-
    // form.tsx gives every ActionNotice) and must NOT be treated as a
    // reason to hold the file back or leave it in the retry queue.
    stubAudioDuration(6);
    vi.mocked(registerElement).mockResolvedValueOnce({
      notice:
        "@new_audio1 saved, but its voice could not be described — press Describe on its card to try again.",
    });
    const user = userEvent.setup();
    const { onPick } = renderPicker();

    const { fileInput } = await openPicker(user, /^upload$/i);
    await user.upload(fileInput, anAudio("lena.mp3"));
    await submitPendingFiles(user);

    // THIS TEST USED TO ASSERT THE OPPOSITE, and it was wrong about the
    // server the whole time. It required onPick to fire with lena.mp3 —
    // attaching the voice to the clip as its conditioning frame. generateClip
    // refuses exactly that: a raw file upload is checked against
    // ACCEPTED_IMAGE_TYPES and an audio/mpeg comes back "audio/mpeg is not a
    // JPG, PNG or WebP", so the attach this asserted could never have
    // produced a render. The test only ever exercised the client half.
    //
    // A voice DOES reach a clip — as a saved element by @name, the path
    // actions/ugc.test.ts's "copies a picked voice as audio" covers, which
    // goes through elementId and skips the image check entirely. That is the
    // route, and it is unaffected here.
    //
    // What this test is actually for survives untouched: a describe failure
    // is a notice, not an error, and it must not hold the file back.
    await waitFor(() => expect(registerElement).toHaveBeenCalled());
    expect(
      onPick,
      "attached an MP3 as the conditioning frame — the server refuses that upload outright",
    ).not.toHaveBeenCalled();

    expect(toastNotice).toHaveBeenCalledWith(
      expect.stringMatching(/could not be described.*Describe/i),
    );
    // NOT toastError — a describe failure that still saved the upload is
    // not the same event as a refusal, and dressing it as one would teach
    // an operator to distrust an upload that landed fine.
    expect(toastError).not.toHaveBeenCalled();
  });
});

// Money, not validity — see attachVideoDuration's own comment. Unlike
// audio, a video reference is never rejected for its length; what these
// pin is that the MEASUREMENT actually reaches registerElement, since that
// is the one channel assets.duration_s (and therefore this element's own
// share of a future scene's Price x (input + output) bill) can be written
// from at all.
describe("UgcReferencePicker measures a video reference's duration for pricing", () => {
  it("hands a measured duration to the direct Gemini primary reference", async () => {
    const spy = stubVideoDuration(7.5);
    try {
      const user = userEvent.setup();
      const { onPick } = renderPicker(null, true);

      const { fileInput } = await openPicker(user, /^upload$/i);
      await user.upload(fileInput, aVideo());
      await submitPendingFiles(user);

      await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
      const picked = onPick.mock.calls[0]?.[0] as PickedReference | undefined;
      expect(picked?.kind).toBe("upload");
      if (picked?.kind !== "upload") throw new Error("expected an uploaded video reference");
      expect(picked.durationS).toBe(7.5);
    } finally {
      spy.mockRestore();
    }
  });

  it("sends the measured duration on to registerElement as durationS", async () => {
    const spy = stubVideoDuration(7.5);
    try {
      const user = userEvent.setup();
      renderPicker();

      const { fileInput } = await openPicker(user, /^upload$/i);
      await user.upload(fileInput, aVideo());
      await submitPendingFiles(user);

      await waitFor(() => expect(registerElement).toHaveBeenCalledTimes(1));
      const sent = vi.mocked(registerElement).mock.calls[0]?.[0] as FormData;
      expect(sent.get("durationS")).toBe("7.5");
    } finally {
      spy.mockRestore();
    }
  });

  it("leaves durationS unset — never 0, never an empty string — when the browser cannot measure the file", async () => {
    // registerElement reads a missing field as null (Number(null-ish) is
    // NaN), and estimate.ts's estimateCost turns THAT null into an
    // unbounded over-quote — see clipCostUsd's own comment for why that is
    // the safe direction. Sending "0" here instead would silently claim the
    // reference has no length and under-quote the render it is attached to.
    const spy = stubVideoDuration(null);
    try {
      const user = userEvent.setup();
      renderPicker();

      const { fileInput } = await openPicker(user, /^upload$/i);
      await user.upload(fileInput, aVideo());
      await submitPendingFiles(user);

      await waitFor(() => expect(registerElement).toHaveBeenCalledTimes(1));
      const sent = vi.mocked(registerElement).mock.calls[0]?.[0] as FormData;
      expect(sent.get("durationS")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("never sends durationS for a picture — the field is video-only", async () => {
    const spy = stubVideoDuration(7.5);
    try {
      const user = userEvent.setup();
      renderPicker();

      const { fileInput } = await openPicker(user, /^upload$/i);
      await user.upload(fileInput, anImage());
      await submitPendingFiles(user);

      await waitFor(() => expect(registerElement).toHaveBeenCalledTimes(1));
      const sent = vi.mocked(registerElement).mock.calls[0]?.[0] as FormData;
      expect(sent.get("durationS")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("UgcReferencePicker's trigger", () => {
  it("says Upload whether or not something is already attached", () => {
    // It used to read "Add references" / "Change reference", which described
    // attaching a conditioning frame. What the control does now is put
    // pictures into the library.
    const { unmount } = render(
      <UgcReferencePicker projectId="proj-1" elements={ELEMENTS} current={null} onPick={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /^upload$/i })).toBeTruthy();
    unmount();

    render(
      <UgcReferencePicker
        projectId="proj-1"
        elements={ELEMENTS}
        current={{ kind: "element", elementId: "el-1", name: "jen", previewUrl: "x" }}
        onPick={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /^upload$/i })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The Voice category.
//
// "Voice" on a save control reads as a promise: name a voice, and something
// downstream uses it. Nothing does. kie has no known audio input, Seedance has
// no audio at all, and /ugc renders silent — so a voice element is an image
// with a category, held for whenever audio lands.
//
// That was a deliberate decision, and actions/elements.ts documented it by
// citing "ugc-column.tsx's InfoHint" as where the operator gets told. There is
// no such hint; that file has never contained the word audio. The reasoning was
// sound and the telling was never built, which is the failure mode worth a test:
// nothing about a missing sentence breaks a build.
// ---------------------------------------------------------------------------

// THE VOICE PLACEHOLDER NOTE HAS NO HOME RIGHT NOW, and this comment is the
// record of that rather than a quiet deletion.
//
// Two tests used to live here: choosing Voice in the upload form's category
// select surfaced "Seedance does accept audio; we have nowhere to store it
// yet", and the other two categories did not. That select is gone — an upload
// is saved as "character" and re-categorised on the Elements tab — so the
// sentence has nowhere to appear and the tests assert against markup that no
// longer exists.
//
// What is still true is what made the note worth writing: a voice element
// stores an IMAGE, because assets.kind has no audio member, so it steers a
// render exactly as much as a character reference does and no more. The Voice
// filter pill on the Elements tab still offers the category. When the edit
// controls land on that tab, the note belongs beside its category selector.

// The drop half of the upload control. It has a failure mode a click can never
// reach: `accept` on an <input> filters the browse dialog and nothing else, so
// anything at all can be dragged onto the box and arrives perfectly happily.
describe("UgcReferencePicker accepts a dropped image", () => {
  /** The dropzone is the button that names the gesture. */
  function dropzone(): HTMLElement {
    // The label changes once files are chosen ("N chosen. Drop more here…"),
    // so this matches the part that survives both states rather than the
    // empty-state wording, which a batch test leaves behind on its first drop.
    return screen.getByRole("button", { name: /click to browse/i });
  }

  function drop(target: HTMLElement, files: File[]): void {
    fireEvent.drop(target, { dataTransfer: { files, types: ["Files"] } });
  }

  it("takes a dropped image and shows it as the chosen file", async () => {
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user, /^upload$/i);

    drop(dropzone(), [anImage("dragged.png")]);

    expect(await screen.findByText("dragged.png")).toBeTruthy();
    // And the save is now reachable, which is the whole point of the drop.
    const save = screen.getByRole("button", { name: /^upload$/i });
    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));
  });

  it("refuses a dropped file that is not an image, and says so", async () => {
    // The case `accept` cannot catch. Before the explicit check, this dropped
    // silently: nothing appeared, nothing complained.
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user, /^upload$/i);

    drop(dropzone(), [new File(["%PDF"], "brief.pdf", { type: "application/pdf" })]);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        // The rules ride along on every refusal, so the assertion covers both
        // halves: what was wrong, and the whole shape of what is allowed.
        //
        // Asserted clause by clause rather than as one pinned sentence. The
        // pinned version went red when 0093 added MP4 to the rules — a
        // refusal that had become MORE accurate — while a version that
        // silently DROPPED a clause would have stayed green, since a shorter
        // sentence still fails a full-sentence match the same way. Each kind
        // the uploader accepts has to be named here with its own ceiling,
        // because this toast is the only place the operator is ever told.
        expect.stringMatching(/Nothing there can be used as a reference/),
      ),
    );
    const said = toastError.mock.calls.at(-1)?.[0] as string;
    expect(said).toMatch(/Pictures JPG, PNG or WebP up to 10\.0MB/);
    expect(said).toMatch(/voice clips MP3 or WAV, 2-30 seconds, up to 15\.0MB/);
    expect(said).toMatch(/MP4 videos up to 15\.0MB/);
    expect(said).toMatch(/5 at a time/);
    expect(screen.getByRole("button", { name: /^upload$/i }).hasAttribute("disabled")).toBe(true);
  });

  it("keeps every dropped file, in order, and says which one this clip uses", async () => {
    // Filling the library was one full trip through this dialog per
    // reference: drop, wait for the describe, close, repeat. Five operators
    // had put 35 elements in that way, which is what a batch is for.
    //
    // Order is not cosmetic — the FIRST file is the one attached to this
    // clip and the rest are library-only, so both have to survive the drop
    // and stay in the order they arrived.
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user, /^upload$/i);

    drop(dropzone(), [anImage("first.png"), anImage("second.png")]);

    expect(await screen.findByText("first.png")).toBeTruthy();
    expect(screen.getByText("second.png")).toBeTruthy();
    expect(screen.getByRole("button", { name: /upload 2/i })).toBeTruthy();
  });

  it("skips a file it cannot take rather than refusing the whole drop", async () => {
    // Dragging a folder's worth of files is the point of a batch. Refusing
    // all eight because one was a PDF would make the operator find and remove
    // it by hand — and saying nothing about the one left out is how someone
    // later wonders why the library is short.
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user, /^upload$/i);

    drop(dropzone(), [
      anImage("good.png"),
      new File(["%PDF"], "brief.pdf", { type: "application/pdf" }),
    ]);

    expect(await screen.findByText("good.png")).toBeTruthy();
    expect(toastError).toHaveBeenCalledWith(
      expect.stringMatching(/Skipped 1 of 2 files — .*The rest were added/),
    );
  });

  it("refuses a picture over the size ceiling without uploading it", async () => {
    // THE SERVER ALREADY SAID NO to this, and still does — but only after the
    // whole file had gone up through a Server Action, which for a 12 MB
    // picture is the entire upload spent to be told the size. The size is
    // known the moment the file is chosen.
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user, /^upload$/i);

    drop(dropzone(), [big("huge.png", "image/png", 12 * 1024 * 1024)]);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        expect.stringMatching(
          /huge\.png is too big — It is 12\.0MB\. A picture has to be under 10\.0MB/,
        ),
      ),
    );
    // And it never joined the batch, so Upload has nothing to send.
    expect(screen.queryByText("huge.png")).toBeNull();
    expect(screen.getByRole("button", { name: /^upload$/i }).hasAttribute("disabled")).toBe(true);
  });

  it("refuses a voice clip over kie's own ceiling, which is a different number", async () => {
    // 15 MB against a picture's 10. One shared limit would have to be wrong
    // about one of the two kinds.
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user, /^upload$/i);

    drop(dropzone(), [big("long.mp3", "audio/mpeg", 16 * 1024 * 1024)]);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        expect.stringMatching(
          /long\.mp3 is too big — It is 16\.0MB\. A voice clip has to be under 15\.0MB/,
        ),
      ),
    );
    expect(screen.queryByText("long.mp3")).toBeNull();
  });

  it("skips a file that is already in the batch", async () => {
    // TWO DRAGS OF ONE FOLDER is the way this happens, and the batch does not
    // merge them: it saves two elements, pays for two Claude descriptions,
    // and leaves two @tags naming the same face with nothing to tell them
    // apart. Observed in a real batch — two rows, one filename.
    const user = userEvent.setup();
    renderPicker();
    const { fileInput } = await openPicker(user, /^upload$/i);

    // Not the same object twice: a second browse produces a NEW File for the
    // same bytes, which is exactly why identity has to be name/size/mtime.
    const first = anImage("lena.png");
    const second = anImage("lena.png");
    Object.defineProperty(second, "lastModified", { value: first.lastModified });

    await user.upload(fileInput, first);
    await user.upload(fileInput, second);

    expect(await screen.findByText("lena.png")).toBeTruthy();
    expect(screen.getAllByText("lena.png")).toHaveLength(1);
    expect(toastError).toHaveBeenCalledWith(
      expect.stringMatching(/That one is already listed — .*two @tags that cannot be told apart/),
    );
    // And the button still offers one upload, not two.
    expect(screen.getByRole("button", { name: /^upload$/i })).toBeTruthy();
  });

  it("keeps five of a bigger drop and says how many it kept", async () => {
    // Silently keeping five of eight is how someone later wonders which three
    // are missing from the library.
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user, /^upload$/i);

    drop(
      dropzone(),
      [1, 2, 3, 4, 5, 6, 7].map((n) => anImage(`shot${n}.png`)),
    );

    expect(await screen.findByText("shot5.png")).toBeTruthy();
    expect(screen.queryByText("shot6.png")).toBeNull();
    expect(toastError).toHaveBeenCalledWith(
      expect.stringMatching(
        /Only 5 files at a time — Kept the first 5 of 7\. .*drag the other 2 in/,
      ),
    );
  });

  it("drops a voice clip shorter than two seconds, rather than warning about it", async () => {
    // THIS USED TO STAY IN THE BATCH under a red line. kie refuses a clip
    // outside 2-30s with certainty, and it refuses it after the render is
    // submitted — so leaving it selected bought a slower no, at the price of
    // a render.
    stubAudioDuration(1.2);
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user, /^upload$/i);

    drop(dropzone(), [anAudio("blip.mp3")]);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        expect.stringMatching(
          /blip\.mp3 is too short — It is 1\.2 seconds\. A voice clip has to be between 2 and 30 seconds/,
        ),
      ),
    );
    await waitFor(() => expect(screen.queryByText("blip.mp3")).toBeNull());
  });

  it("keeps a clip whose length cannot be read at all", async () => {
    // The half of the old reasoning that survives: a browser that cannot
    // decode a container is not evidence the file is bad, and refusing on
    // that guess blocks an upload kie would have taken.
    stubAudioDuration(null);
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user, /^upload$/i);

    drop(dropzone(), [anAudio("odd.wav")]);

    expect(await screen.findByText("odd.wav")).toBeTruthy();
    await waitFor(() => expect(toastError).not.toHaveBeenCalled());
  });

  it("removes one file from the batch without touching the others", async () => {
    // A wrong file among five should cost one click, not a re-drag of the
    // other four.
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user, /^upload$/i);

    drop(dropzone(), [anImage("keep.png"), anImage("drop-me.png")]);
    await screen.findByText("drop-me.png");

    await user.click(screen.getByRole("button", { name: /remove drop-me/i }));

    expect(screen.queryByText("drop-me.png")).toBeNull();
    expect(screen.getByText("keep.png")).toBeTruthy();
  });

  it("ignores an empty drop rather than clearing what is already chosen", async () => {
    const user = userEvent.setup();
    const { fileInput } = await (async () => {
      renderPicker();
      return openPicker(user, /^upload$/i);
    })();
    await user.upload(fileInput, anImage("kept.png"));
    expect(await screen.findByText("kept.png")).toBeTruthy();

    // Queried by its OTHER label: once a file is chosen the box stops
    // inviting a drop and starts naming what it holds.
    drop(dropzone(), []);

    expect(screen.getByText("kept.png")).toBeTruthy();
  });
});

// What the detail panel owes the operator once it became the only editor.
describe("UgcReferencePicker's detail panel", () => {
  async function openDetail(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await openPicker(user, /^upload$/i);
    await user.click(await screen.findByRole("tab", { name: /elements/i }));
    await user.click(await screen.findByRole("button", { name: /^show @jen$/i }));
  }

  it("shows the tag, the category and the description of the chosen reference", async () => {
    const user = userEvent.setup();
    renderPicker();
    await openDetail(user);

    expect((screen.getByLabelText(/^tag$/i) as HTMLInputElement).value).toBe("jen");
    expect(screen.getByLabelText(/^category$/i).textContent).toBe("Image");
    expect((screen.getByLabelText(/^description$/i) as HTMLTextAreaElement).value).toBe(
      "the presenter",
    );
  });

  it("puts a fresh AI description into the box the operator is looking at", async () => {
    // THE BUG THIS PINS. "Describe again" wrote only into the map the grid
    // reads, so the panel's textarea — a controlled field seeded on selection
    // — kept the old words. That is not merely invisible: the dirty check
    // compares the box against the NEW text, so the stale words started
    // counting as an unsaved edit, and Save would have written them back over
    // the description that had just been paid for.
    const user = userEvent.setup();
    renderPicker();
    await openDetail(user);

    await user.click(screen.getByRole("button", { name: /describe again/i }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("$0.0150"));

    await waitFor(() =>
      expect((screen.getByLabelText(/^description$/i) as HTMLTextAreaElement).value).toBe(
        "a woman in a red coat, mid-stride",
      ),
    );
  });

  it("does not describe when the cost prompt is declined", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const user = userEvent.setup();
    renderPicker();
    await openDetail(user);

    await user.click(screen.getByRole("button", { name: /describe again/i }));
    expect(redescribeElement).not.toHaveBeenCalled();
  });

  it("saves on its own a moment after typing stops", async () => {
    // There is no Save button any more. What replaced it is a 300ms debounce,
    // so the only thing telling an operator their edit was kept is the status
    // line — and the only thing telling US is that updateElement was called
    // without anybody pressing anything.
    const user = userEvent.setup();
    renderPicker();
    await openDetail(user);

    await user.type(screen.getByLabelText(/^description$/i), " and a mug");

    await waitFor(() => expect(updateElement).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const sent = vi.mocked(updateElement).mock.calls[0]?.[0] as FormData;
    expect(String(sent.get("description"))).toContain("and a mug");
    expect(await screen.findByText(/^saved$/i)).toBeTruthy();
  });

  it("accepts the @ the field invites, rather than silently refusing to save", async () => {
    // FOUND IN PRODUCTION, within an hour of shipping. Every place the name
    // is shown wears an '@' — the grid, the label, the rename hint — so an
    // operator types "@lena2" into the Tag field. The name pattern has no '@'
    // in it, so autosave held everything back and the panel sat at "Unsaved"
    // with nothing to explain it.
    const user = userEvent.setup();
    renderPicker();
    await openDetail(user);

    const tag = screen.getByLabelText(/^tag$/i);
    await user.clear(tag);
    await user.type(tag, "@lena2");

    await waitFor(() => expect(updateElement).toHaveBeenCalled(), { timeout: 3000 });
    const sent = vi.mocked(updateElement).mock.calls.at(-1)?.[0] as FormData;
    // Stored without it: the '@' is how a tag is WRITTEN, never part of the
    // name, and a stored "@lena2" would make the prompt tag "@@lena2".
    expect(String(sent.get("name"))).toBe("lena2");
  });

  it("stops retrying a save the server refused", async () => {
    // FOUND IN PRODUCTION. Renaming a reference onto a name that already
    // exists is refused — and the autosave effect re-ran the moment
    // `savingEdit` dropped back to false, found the panel still dirty, and
    // scheduled the same doomed save 500ms later. One server round trip every
    // half second for as long as the dialog stayed open, behind an error
    // message that looked static.
    const user = userEvent.setup();
    // Once, not for every call: vi.clearAllMocks() in afterEach resets the
    // recorded calls but KEEPS the implementation, so a persistent
    // mockResolvedValue here would hand this error to every later test in the
    // file — which it did, and four of them failed for a reason that had
    // nothing to do with them.
    vi.mocked(updateElement).mockResolvedValueOnce({
      error: "You already have a reference named that.",
    });
    renderPicker();
    await openDetail(user);

    await user.type(screen.getByLabelText(/^description$/i), "!");
    await waitFor(() => expect(updateElement).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(await screen.findByText(/already have a reference named/i)).toBeTruthy();

    // Four debounce windows. A retry loop would have fired several by now.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(updateElement).toHaveBeenCalledTimes(1);
  });

  it("offers the save again as soon as the operator changes something", async () => {
    // The complement, and the reason the refusal is keyed by VALUE rather
    // than remembered as a boolean: editing anything is the only remedy an
    // operator has, so it must actually re-arm the save.
    const user = userEvent.setup();
    // Once, not for every call: vi.clearAllMocks() in afterEach resets the
    // recorded calls but KEEPS the implementation, so a persistent
    // mockResolvedValue here would hand this error to every later test in the
    // file — which it did, and four of them failed for a reason that had
    // nothing to do with them.
    vi.mocked(updateElement).mockResolvedValueOnce({
      error: "You already have a reference named that.",
    });
    renderPicker();
    await openDetail(user);

    await user.type(screen.getByLabelText(/^description$/i), "!");
    await waitFor(() => expect(updateElement).toHaveBeenCalledTimes(1), { timeout: 3000 });

    await user.type(screen.getByLabelText(/^description$/i), "?");
    await waitFor(() => expect(updateElement).toHaveBeenCalledTimes(2), { timeout: 3000 });
  });

  it("says why nothing is saving when the tag is the reason", async () => {
    // "Unsaved" alone is a dead end here — no amount of editing the
    // description will make it save, and the reason is three fields away.
    const user = userEvent.setup();
    renderPicker();
    await openDetail(user);

    const tag = screen.getByLabelText(/^tag$/i);
    await user.clear(tag);
    await user.type(tag, "two words");

    expect(await screen.findByText(/a tag needs letters, numbers/i)).toBeTruthy();
    expect(updateElement).not.toHaveBeenCalled();
  });

  it("does not autosave a tag a prompt could never reference", async () => {
    // A rename rewrites the tag inside every prompt already written, and the
    // debounce fires on PAUSES — so a half-typed name is a real rename with a
    // real rewrite behind it. An empty or malformed one is held back instead:
    // the panel says Unsaved until the name is something @name can find.
    const user = userEvent.setup();
    renderPicker();
    await openDetail(user);

    const tag = screen.getByLabelText(/^tag$/i);
    await user.clear(tag);

    // An empty tag gets the same explanation a malformed one does, rather
    // than a bare "Unsaved" the operator cannot act on.
    expect(await screen.findByText(/a tag needs letters, numbers/i)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(updateElement).not.toHaveBeenCalled();
  });

  it("warns that a rename follows itself into prompts already written", async () => {
    // The panel says so before the press, because the rewrite is invisible
    // afterwards and a rename that silently edited someone's prompts would be
    // worse than one that did not.
    const user = userEvent.setup();
    renderPicker();
    await openDetail(user);

    expect(screen.queryByText(/rewrites @jen in prompts/i)).toBeNull();

    await user.type(screen.getByLabelText(/^tag$/i), "ny");

    expect(await screen.findByText(/rewrites @jen in prompts/i)).toBeTruthy();
  });
});

// A voice element is the one row in this list with nothing to look at, and
// every control in the panel was written on the assumption there is. Each
// assertion below is a thing that WAS broken in production on 2026-09-04:
// the panel painted an <img> at an MP3 and showed the browser's broken-image
// glyph.
describe("UgcReferencePicker's detail panel, for a voice", () => {
  const WITH_VOICE: readonly ElementTag[] = [
    ...ELEMENTS,
    {
      id: "el-3",
      name: "lena_voice",
      category: "audio",
      description: null,
      assetKind: "audio" as const,
      previewUrl: "https://example.test/lena.mp3",
    },
  ];

  async function openVoice(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    render(
      <UgcReferencePicker
        projectId="proj-1"
        elements={WITH_VOICE}
        current={null}
        onPick={vi.fn()}
      />,
    );
    await openPicker(user, /^upload$/i);
    await user.click(await screen.findByRole("tab", { name: /elements/i }));
    // "— no description" is appended to the accessible name for an audio
    // element with no description (see the grid's own comment on why this
    // fixture — description: null — earns that label rather than a plain
    // "Show @lena_voice").
    await user.click(
      await screen.findByRole("button", { name: /^show @lena_voice — no description$/i }),
    );
  }

  it("offers the clip to play instead of painting it as an image", async () => {
    const user = userEvent.setup();
    await openVoice(user);

    const player = screen.getByLabelText(/^play @lena_voice$/i);
    expect(player.tagName).toBe("AUDIO");
    expect(player.getAttribute("src")).toBe("https://example.test/lena.mp3");

    // And the mp3 is not ALSO hanging off an <img> somewhere in the panel —
    // that is the broken glyph, and it renders whether or not a player exists.
    const imgs = [...document.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    expect(imgs).not.toContain("https://example.test/lena.mp3");
  });

  it("states the category rather than offering it, for a sound file or any other", async () => {
    // THIS USED TO BE A DISABLED SELECT, locked for audio only. The lock was
    // right and its reasoning covered pictures too: the category is decided
    // by the file's own kind at upload, and the only edit the select ever
    // allowed was the wrong one — a clip filed as Image goes to the wrong one
    // of kie's two arrays. So there is no control here at all now.
    const user = userEvent.setup();
    await openVoice(user);

    expect(screen.getByLabelText(/^category$/i).textContent).toBe("Audio");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("offers to describe it, same as a picture", async () => {
    // USED TO BE REFUSED HERE: describeReferenceImage sends the bytes to
    // Claude AS AN IMAGE, and pointed at an MP3 that is either a vendor
    // error or a confident paragraph about a picture that does not exist —
    // billed, and then read as the truth about a voice. redescribeElement
    // (actions/ugc.ts) now branches on assets.kind and sends audio to kie's
    // Gemini pass (lib/kie-audio-describe.ts) instead, which actually
    // listens to the clip — so the button belongs here again.
    const user = userEvent.setup();
    await openVoice(user);

    expect(screen.queryByRole("button", { name: /describe/i })).not.toBeNull();
  });

  it("still lets the operator type a note about it", async () => {
    // A typed correction is still the only way to fix one wrong detail in a
    // generated paragraph without re-rolling the whole thing — the field
    // stays live and editable whether the text in it came from a press of
    // Describe or from typing.
    const user = userEvent.setup();
    await openVoice(user);

    const description = screen.getByLabelText(/^description$/i) as HTMLTextAreaElement;
    expect(description.disabled).toBe(false);
    await user.type(description, "Lena, warm read");
    expect(description.value).toBe("Lena, warm read");
  });

  it("does not claim this text is just a private note — it is sent to the model", async () => {
    // The placeholder used to read "A note for yourself — whose voice is
    // this? The clip itself is what gets sent." That was false the whole
    // time resolveElementTags (actions/ugc.ts) has existed: it substitutes
    // ANY element's description into a prompt regardless of kind. It was
    // only ever harmless because every audio element's description was
    // empty — lib/kie-audio-describe.ts is what ends that.
    const user = userEvent.setup();
    await openVoice(user);

    const description = screen.getByLabelText(/^description$/i) as HTMLTextAreaElement;
    expect(description.placeholder).not.toMatch(/note for yourself/i);
    expect(description.placeholder).toMatch(/sent to the model/i);
  });

  // THE PERSISTENT STATE, not the just-uploaded one — this fixture's
  // description is null because nobody ever wrote one, not because a
  // describe just failed in this session. No new column pays for it: it is
  // the same absence an element could always land in, shown honestly instead
  // of as a blank field that looks finished.
  it("shows a visible not-described state, not a silent empty box, in the grid and the panel", async () => {
    const user = userEvent.setup();
    await openVoice(user);

    // The grid card itself — findable by the same "no description" suffix
    // openVoice's own click already relies on, plus the visible label text
    // a sighted operator scanning the grid actually reads.
    expect(screen.getByText("Not described")).toBeTruthy();

    // The detail panel: an amber banner naming the actual consequence
    // (bindUITags leaves a hole in the prompt), not a bare placeholder that
    // reads the same whether nobody ever described this or a describe just
    // failed.
    expect(screen.getByText(/not described yet.*hole where the voice should be/i)).toBeTruthy();

    // And the Describe button is not styled the same as it would be for an
    // already-described element — ghost would read as "optional, purely
    // cosmetic", which is the wrong message for the one press standing
    // between this element and steering no render at all.
    const describeButton = screen.getByRole("button", { name: /^describe$/i });
    expect(describeButton.className).toMatch(/border-amber-500/);
  });
});

// The caption is a control, not decoration.
//
// THE BUG THIS PINS, found by hand on 2026-09-04: the file input's accept
// attribute and the server guard both took MP3 and WAV from the day the
// feature landed, and this dialog still read "JPG, PNG or WebP · one image at
// a time". Nothing was broken — an operator simply read the line, concluded
// voice was unsupported, and did not try. A feature nobody attempts is
// indistinguishable from one that does not exist.
//
// So the invariant is not "the copy is nice", it is: WHAT THE INPUT ACCEPTS,
// THE CAPTION NAMES.
describe("UgcReferencePicker's Image/Audio filters read the asset, not the label", () => {
  // The label has meant different things at different times — character and
  // product before 0081, image and audio after — and rows saved under the old
  // words are not rewritten by the migration. Filtering on the label left
  // every one of them reachable only under All: @bottle is a picture filed as
  // "product", and an operator looking for it under Image was told there was
  // nothing there.
  //
  // It also closes the window around the migration itself: a clip uploaded
  // between 0081 running and this code deploying is written as 'voice' by the
  // old path, and would otherwise sit outside the Audio filter forever.
  const MIXED: readonly ElementTag[] = [
    ...ELEMENTS,
    {
      id: "el-3",
      name: "anny",
      // The pre-0081 word, on a row whose asset is unambiguously a sound.
      category: "voice",
      description: "a soft read",
      assetKind: "audio" as const,
      previewUrl: "https://example.test/anny.mp3",
    },
  ];

  async function openElements(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    render(
      <UgcReferencePicker projectId="proj-1" elements={MIXED} current={null} onPick={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /^upload$/i }));
    await user.click(await screen.findByRole("tab", { name: /elements/i }));
  }

  it("shows a picture saved as 'product' under Image", async () => {
    const user = userEvent.setup();
    await openElements(user);

    await user.click(screen.getByRole("button", { name: /^image$/i }));

    expect(await screen.findByRole("button", { name: /^show @bottle$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^show @jen$/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^show @anny$/i })).toBeNull();
  });

  it("shows a clip saved as 'voice' under Audio", async () => {
    const user = userEvent.setup();
    await openElements(user);

    await user.click(screen.getByRole("button", { name: /^audio$/i }));

    expect(await screen.findByRole("button", { name: /^show @anny$/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^show @jen$/i })).toBeNull();
  });
});

describe("UgcReferencePicker says what it will actually take", () => {
  it("names both kinds, and the input accepts both", async () => {
    const user = userEvent.setup();
    renderPicker();
    const { dialog, fileInput } = await openPicker(user, /^upload$/i);

    const accept = fileInput.getAttribute("accept") ?? "";
    expect(accept, "the input stopped accepting audio").toContain("audio/mpeg");
    expect(accept).toContain("image/png");

    // Read as one string: the two limits live on separate lines precisely
    // because they differ, and a test that checked one line would pass with
    // the other missing.
    const text = dialog.textContent ?? "";
    expect(text, "the caption no longer mentions pictures").toMatch(/JPG, PNG or WebP/i);
    expect(text, "the caption no longer mentions voice — the 09-04 bug").toMatch(/MP3 or WAV/i);
  });

  it("gives each kind its own size limit rather than one shared number", async () => {
    // 10 MB for a picture against kie's 15 MB for a clip. A single "Maximum
    // size" line would have to be wrong about one of them, and being wrong in
    // the generous direction means an upload refused by the server after the
    // operator was told it would fit.
    const user = userEvent.setup();
    renderPicker();
    const { dialog } = await openPicker(user, /^upload$/i);

    const text = dialog.textContent ?? "";
    expect(text).toMatch(/10\.0MB/);
    expect(text).toMatch(/15\.0MB/);
    // And the vendor's duration window, which is the one limit a file can
    // break while being the right type and well under the size ceiling.
    expect(text).toMatch(/2-\s*30 seconds/);
  });
});

// THE THIRD PLACE AN MP3 WAS PAINTED AS A PICTURE.
//
// The grid tile and the detail panel were both fixed when voice landed; this
// one — the preview of the file you have just chosen and not yet uploaded —
// was missed, and it is the FIRST thing an operator sees after picking a
// clip. A broken-image glyph there reads as "your upload failed" at the exact
// moment nothing has failed at all.
//
// Keyed off the file, not the object URL: URL.createObjectURL is called for
// both kinds and its result says nothing about what is inside.
describe("UgcReferencePicker previews a chosen voice clip without an <img>", () => {
  function anAudioFile(name = "lena.mp3") {
    return new File([new Uint8Array([0x49, 0x44, 0x33])], name, { type: "audio/mpeg" });
  }

  it("shows an icon, and hangs no object URL off an image element", async () => {
    const user = userEvent.setup();
    renderPicker();
    const { dialog, fileInput } = await openPicker(user, /^upload$/i);

    fireEvent.change(fileInput, { target: { files: [anAudioFile()] } });

    // The filename appears either way — that is not the assertion. The
    // assertion is that nothing tried to render the audio as an image.
    expect(await screen.findByText("lena.mp3")).toBeDefined();
    const srcs = [...dialog.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    for (const result of createObjectURL.mock.results) {
      expect(
        srcs,
        "an <img> is pointed at the chosen file — this is the broken-glyph bug",
      ).not.toContain(result.value);
    }
  });

  it("still previews a chosen picture as a picture", async () => {
    // The other direction, because a fix that blanked every preview would
    // pass the test above and be worse than the bug.
    const user = userEvent.setup();
    renderPicker();
    const { dialog, fileInput } = await openPicker(user, /^upload$/i);

    fireEvent.change(fileInput, { target: { files: [anImage("face.png")] } });

    await screen.findByText("face.png");
    expect(dialog.querySelectorAll("img").length).toBeGreaterThan(0);
  });
});

// THE BUG THIS PINS, hit in production on 2026-09-04 within minutes of the
// voice feature going live.
//
// The grid renders the CATEGORY-FILTERED list. The panel used to resolve the
// selected id against the UNFILTERED one. So the two could disagree: press
// Voice, see a single voice tile in the grid, and have the panel still
// showing the character element selected a moment earlier — same dialog, same
// screen, two different elements.
//
// What that cost: the operator renamed what was plainly in front of them, and
// a picture they could not see took the name. "nag rename ako ng tag na voice
// ... yung image yung na rename?" Nothing errored. The rename worked
// perfectly, on the wrong row.
describe("UgcReferencePicker never edits an element the grid is not showing", () => {
  const MIXED: readonly ElementTag[] = [
    {
      id: "el-img",
      name: "lena1",
      category: "image",
      description: "the presenter",
      assetKind: "ref_frame" as const,
      previewUrl: "https://example.test/lena.jpg",
    },
    {
      id: "el-voice",
      name: "new1",
      category: "audio",
      description: null,
      assetKind: "audio" as const,
      previewUrl: "https://example.test/new1.mp3",
    },
  ];

  async function openWith(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    render(
      <UgcReferencePicker projectId="proj-1" elements={MIXED} current={null} onPick={vi.fn()} />,
    );
    await openPicker(user, /^upload$/i);
    await user.click(await screen.findByRole("tab", { name: /elements/i }));
  }

  it("drops the selection when the filter hides it, rather than editing it invisibly", async () => {
    const user = userEvent.setup();
    await openWith(user);

    // Select the character, then filter to Voice — which does not contain it.
    await user.click(await screen.findByRole("button", { name: /^show @lena1$/i }));
    expect((screen.getByLabelText(/^tag$/i) as HTMLInputElement).value).toBe("lena1");

    await user.click(screen.getByRole("button", { name: /^audio$/i }));

    // The panel must not still be holding lena1. Anything else — the empty
    // state, or the voice — is fine; editing an element the grid is not
    // showing is not.
    expect(
      screen.queryByDisplayValue("lena1"),
      "the panel is still editing a character the Voice filter has hidden",
    ).toBeNull();
  });

  it("still edits the right element when the filter contains it", async () => {
    // The other direction, because clearing the selection unconditionally
    // would pass the test above and make the filters useless.
    const user = userEvent.setup();
    await openWith(user);

    await user.click(screen.getByRole("button", { name: /^audio$/i }));
    // Same "no description" suffix as lena_voice above — new1 is audio with
    // description: null too.
    await user.click(await screen.findByRole("button", { name: /^show @new1 — no description$/i }));

    expect((screen.getByLabelText(/^tag$/i) as HTMLInputElement).value).toBe("new1");
    // And it is the voice: locked category, no describe button.
    expect(screen.getByLabelText(/^category$/i).textContent).toBe("Audio");
  });
});

// The three end-of-batch toasts (see reportUploadOutcome in
// ugc-reference-picker.tsx) and the guarantee they survive the dialog
// closing mid-save. These are deliberately NOT assertions about the inline
// "N references saved" banner or the per-row bars — both of those already
// have coverage above and both disappear the instant Radix unmounts
// DialogContent, which is the entire reason this second, toast-based
// channel exists.
describe("UgcReferencePicker's end-of-batch toast", () => {
  it("says every file saved when the whole batch lands", async () => {
    vi.mocked(registerElement).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPicker();

    const { fileInput } = await openPicker(user, /^upload$/i);
    await user.upload(fileInput, [anImage("a.png"), anImage("b.png")]);
    await submitPendingFiles(user, 2);

    await waitFor(() => expect(registerElement).toHaveBeenCalledTimes(2));
    // toastNotice is the mock for the bare `toast(message)` call — the same
    // shape reportUploadOutcome's all-saved branch uses.
    await waitFor(() => expect(toastNotice).toHaveBeenCalledWith("2 references saved."));
  });

  it("names the failed file when part of the batch lands", async () => {
    vi.mocked(registerElement)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ error: "too big" });
    const user = userEvent.setup();
    renderPicker();

    const { fileInput } = await openPicker(user, /^upload$/i);
    await user.upload(fileInput, [anImage("first.png"), anImage("second.png")]);
    await submitPendingFiles(user, 2);

    await waitFor(() => expect(registerElement).toHaveBeenCalledTimes(2));
    // NAMES THE FILE, not just a count — see reportUploadOutcome's own doc
    // comment for why a bare "1 of 2 saved" is not enough on its own.
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "1 of 2 saved — second.png could not be saved: too big",
      ),
    );
  });

  it("says the whole batch failed, and names both files, when nothing lands", async () => {
    vi.mocked(registerElement)
      .mockResolvedValueOnce({ error: "too big" })
      .mockResolvedValueOnce({ error: "unsupported format" });
    const user = userEvent.setup();
    renderPicker();

    const { fileInput } = await openPicker(user, /^upload$/i);
    await user.upload(fileInput, [anImage("a.png"), anImage("b.png")]);
    await submitPendingFiles(user, 2);

    await waitFor(() => expect(registerElement).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Could not save any of 2 files — a.png and b.png all failed to upload.",
      ),
    );
  });

  it("still fires the batch toast after the dialog is closed mid-save", async () => {
    // The bug this whole change exists for: closing the dialog does not
    // (and per the brief, must not) stop the loop, so the loop's own outcome
    // toast is the one thing guaranteed to reach the operator regardless.
    // Deferred promises stand in for the in-flight registerElement calls so
    // this test can close the dialog BETWEEN them, the way an operator
    // closing right after pressing Upload actually would.
    let resolveFirst: (value: Awaited<ReturnType<typeof registerElement>>) => void = () => {};
    let resolveSecond: (value: Awaited<ReturnType<typeof registerElement>>) => void = () => {};
    vi.mocked(registerElement)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const user = userEvent.setup();
    const { unmount } = renderPicker();

    const { fileInput } = await openPicker(user, /^upload$/i);
    await user.upload(fileInput, [anImage("a.png"), anImage("b.png")]);
    await submitPendingFiles(user, 2);
    await waitFor(() => expect(registerElement).toHaveBeenCalledTimes(1));

    // The dialog (and everything under it, including the component running
    // this loop) is gone now — this is the harshest version of "closed mid-
    // batch", stronger than merely toggling the Dialog's own `open` prop,
    // and it is exactly what Radix does to DialogContent on close.
    unmount();

    // Settled in two steps, not one: resolveSecond is only assigned once the
    // loop actually reaches its second registerElement call, which only
    // happens after this first resolution has been awaited. Firing both in
    // the same tick would resolve a promise (registerElement's second call)
    // that does not exist yet.
    await act(async () => {
      resolveFirst(undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(registerElement).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveSecond({ error: "expired" });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("1 of 2 saved — b.png could not be saved: expired"),
    );
  });
});

/**
 * WHAT GETS ATTACHED TO THE CLIP, as opposed to what gets saved to the library.
 *
 * Every file in a batch is saved either way. Exactly one of them is also handed
 * to the parent as the clip's conditioning frame, and only a picture can be
 * one — kie is sent it as reference_image_urls and generateClip refuses
 * anything else outright.
 *
 * This picked files[0]. That was right while the dialog took pictures alone.
 * Once it took MP3s (0079) and then MP4s (0093), an operator whose batch led
 * with a voice or a video had that file attached as the frame, and the render
 * they had just asked for came back refused:
 *
 *   video/mp4 is not a JPG, PNG or WebP.
 *
 * Seen in production on 2026-09-10, on a video that had uploaded, described and
 * saved perfectly. The audio case had the identical hole and had never been
 * hit, because a voice is normally uploaded beside a picture rather than alone.
 */

describe("only a picture is attached to the clip", () => {
  it("attaches nothing when the batch is a video alone", async () => {
    // RESTORED AT THE END OF THIS TEST. stubVideoDuration's own comment
    // says an unrestored spy answers for every "video" tag every later
    // test in this file renders, and it means it: leaving one standing
    // here handed the detail panel's real <video> a probe object with no
    // DOM behind it, and the playback tests below failed on a stub they
    // never asked for.
    const videoStub = stubVideoDuration(7.5);
    const user = userEvent.setup();
    const { onPick } = renderPicker();

    const { fileInput } = await openPicker(user, /^upload$/i);
    await user.upload(fileInput, aVideo());
    await submitPendingFiles(user);

    // The file still reaches the library — the skip is about the FRAME, not
    // about dropping the upload. Asserted first so a video that never saved
    // at all cannot masquerade as a video that saved and was not attached.
    await waitFor(() => expect(registerElement).toHaveBeenCalled());
    expect(
      onPick,
      "attached an MP4 as the clip's conditioning frame — generateClip refuses it and the render never queues",
    ).not.toHaveBeenCalled();
    videoStub.mockRestore();
  });

  it("attaches nothing when the batch is a voice alone", async () => {
    stubAudioDuration(6);
    const user = userEvent.setup();
    const { onPick } = renderPicker();

    const { fileInput } = await openPicker(user, /^upload$/i);
    await user.upload(fileInput, anAudio());
    await submitPendingFiles(user);

    await waitFor(() => expect(registerElement).toHaveBeenCalled());
    expect(onPick).not.toHaveBeenCalled();
  });

  it("reaches past a leading video to attach the picture behind it", async () => {
    // ORDER IS THE TEST. A fix that only inspected files[0] and gave up would
    // pass both cases above and still refuse this operator's render.
    // RESTORED AT THE END OF THIS TEST. stubVideoDuration's own comment
    // says an unrestored spy answers for every "video" tag every later
    // test in this file renders, and it means it: leaving one standing
    // here handed the detail panel's real <video> a probe object with no
    // DOM behind it, and the playback tests below failed on a stub they
    // never asked for.
    const videoStub = stubVideoDuration(7.5);
    const user = userEvent.setup();
    const { onPick } = renderPicker();

    const { fileInput } = await openPicker(user, /^upload$/i);
    await user.upload(fileInput, [aVideo(), anImage()]);
    // "Upload 2", not "Upload" — the button counts the batch.
    await submitPendingFiles(user, 2);

    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    const picked = onPick.mock.calls[0]?.[0] as PickedReference;
    if (picked.kind !== "upload") throw new Error("expected an upload");
    expect(
      picked.file.name,
      "attached the video that happened to be dragged first, not the picture in the same batch",
    ).toBe("ref.png");
    videoStub.mockRestore();
  });

  it("attaches the picture when it leads, unchanged from before", async () => {
    // RESTORED AT THE END OF THIS TEST. stubVideoDuration's own comment
    // says an unrestored spy answers for every "video" tag every later
    // test in this file renders, and it means it: leaving one standing
    // here handed the detail panel's real <video> a probe object with no
    // DOM behind it, and the playback tests below failed on a stub they
    // never asked for.
    const videoStub = stubVideoDuration(7.5);
    const user = userEvent.setup();
    const { onPick } = renderPicker();

    const { fileInput } = await openPicker(user, /^upload$/i);
    await user.upload(fileInput, [anImage(), aVideo()]);
    await submitPendingFiles(user, 2);

    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    const picked = onPick.mock.calls[0]?.[0] as PickedReference;
    if (picked.kind !== "upload") throw new Error("expected an upload");
    expect(picked.file.name).toBe("ref.png");
    videoStub.mockRestore();
  });
});

/**
 * THE FILTER ROW, AND THE BUG THAT WAS HIDING BEHIND A MISSING PILL.
 *
 * The row offered All / Image / Audio, and the predicate behind it was a
 * two-way binary:
 *
 *   (el.assetKind === "audio") === (categoryFilter === "audio")
 *
 * correct for exactly two kinds. A video is not audio, and under the Image
 * pill the filter is not audio either, so `false === false` held and every
 * video listed itself as a picture. Nobody reported it because there was no
 * Video pill to contradict it.
 *
 * Which is why the pill alone would have been the wrong fix: it would have
 * put the same clip under Image AND Video. Both halves are asserted here,
 * and the Image case is the one that fails against a pill-only change.
 */
describe("the filter row tells the three kinds apart", () => {
  const mixed: ElementTag[] = [
    {
      id: "el-pic",
      name: "greta",
      category: "character",
      description: "a woman in a cream shirt",
      previewUrl: "https://signed.example/greta.jpg",
      // A PRE-0081 ROW: filed as "character", and still a picture. The
      // filter reads the asset, never the label — this fixture is what
      // stops that rule being quietly dropped.
      assetKind: "character_ref",
    },
    {
      id: "el-voice",
      name: "narrator",
      category: "audio",
      description: "a low warm read",
      previewUrl: "https://signed.example/voice.mp3",
      assetKind: "audio",
    },
    {
      id: "el-vid",
      name: "clip1",
      category: "video",
      description: "a woman sips from a mug",
      previewUrl: "https://signed.example/clip.mp4",
      assetKind: "video_ref",
    },
  ];

  async function openTo(user: ReturnType<typeof userEvent.setup>, pill: RegExp): Promise<void> {
    render(
      <UgcReferencePicker projectId="proj-1" elements={mixed} current={null} onPick={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /^upload$/i }));
    await user.click(screen.getByRole("tab", { name: /elements/i }));
    await user.click(screen.getByRole("button", { name: pill }));
  }

  it("offers a Video pill at all", async () => {
    const user = userEvent.setup();
    render(
      <UgcReferencePicker projectId="proj-1" elements={mixed} current={null} onPick={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /^upload$/i }));
    await user.click(screen.getByRole("tab", { name: /elements/i }));

    expect(screen.getByRole("button", { name: /^video$/i })).toBeTruthy();
  });

  it("shows only the video under Video", async () => {
    const user = userEvent.setup();
    await openTo(user, /^video$/i);

    expect(screen.getByText("@clip1")).toBeTruthy();
    expect(screen.queryByText("@greta")).toBeNull();
    expect(screen.queryByText("@narrator")).toBeNull();
  });

  it("does NOT show the video under Image — the bug the missing pill was hiding", async () => {
    const user = userEvent.setup();
    await openTo(user, /^image$/i);

    expect(screen.getByText("@greta")).toBeTruthy();
    expect(
      screen.queryByText("@clip1"),
      "an MP4 listed itself as a picture — the two-way predicate is back",
    ).toBeNull();
  });

  it("still shows a pre-0081 'character' row under Image", async () => {
    // The rule this replaces rather than repeals: the filter reads the
    // asset, not the label. A pill that matched on category would drop
    // every reference saved before 0081 out of Image entirely.
    const user = userEvent.setup();
    await openTo(user, /^image$/i);

    expect(screen.getByText("@greta")).toBeTruthy();
  });

  it("shows only the voice under Audio", async () => {
    const user = userEvent.setup();
    await openTo(user, /^audio$/i);

    expect(screen.getByText("@narrator")).toBeTruthy();
    expect(screen.queryByText("@clip1")).toBeNull();
    expect(screen.queryByText("@greta")).toBeNull();
  });

  it("shows all three under All", async () => {
    const user = userEvent.setup();
    await openTo(user, /^all$/i);

    expect(screen.getByText("@greta")).toBeTruthy();
    expect(screen.getByText("@narrator")).toBeTruthy();
    expect(screen.getByText("@clip1")).toBeTruthy();
  });
});

/**
 * A VIDEO REFERENCE CAN BE PLAYED, which it could not until 2026-09-10.
 *
 * A voice clip in this same panel has had `controls` since it shipped, on
 * the reasoning that listening is the only way to check a voice is the right
 * one. A video sat beside it as a frozen first frame carrying aria-hidden —
 * announced to nobody and operable by no one — while the operator was
 * expected to decide from it whether this was the clip they meant.
 */
describe("a selected video reference is playable", () => {
  const video: ElementTag[] = [
    {
      id: "el-vid",
      name: "clip1",
      category: "video",
      description: "a woman sips from a mug",
      previewUrl: "https://signed.example/clip.mp4",
      assetKind: "video_ref",
    },
  ];

  /**
   * Returns the panel's <video>, read off the DOCUMENT rather than render()'s
   * container: the dialog is portalled, so everything inside it lands outside
   * the container this component was rendered into.
   */
  async function selectTheVideo(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<HTMLVideoElement | null> {
    render(
      <UgcReferencePicker projectId="proj-1" elements={video} current={null} onPick={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /^upload$/i }));
    await user.click(await screen.findByRole("tab", { name: /elements/i }));
    // The grid renders each element as a "show @name" button — clicking the
    // bare text can land on a label rather than the control.
    await user.click(await screen.findByRole("button", { name: /^show @clip1$/i }));
    return document.querySelector("video");
  }

  it("gives it controls, the same way a voice has them", async () => {
    const user = userEvent.setup();
    const el = await selectTheVideo(user);

    expect(el, "the detail panel rendered no video at all").toBeTruthy();
    expect(el?.hasAttribute("controls"), "a video reference still cannot be played").toBe(true);
  });

  it("plays with sound, not muted", async () => {
    // `muted` was only ever there for the autoplay policy, and this element
    // has never autoplayed. Left on, pressing play on a clip of someone
    // talking gives silence — the same "does nothing, says nothing" shape
    // the controls are being added to fix.
    const user = userEvent.setup();
    const el = await selectTheVideo(user);

    // THE PROPERTY, NOT THE ATTRIBUTE. React sets `muted` as a DOM property
    // rather than an attribute, so hasAttribute("muted") reads false whether
    // or not the element is muted — this assertion passed against a muted
    // video until it was written this way, which is exactly the sort of
    // green-for-nothing test the mutation check exists to find.
    expect(el?.muted, "the panel plays a talking clip in silence").toBe(false);
  });

  it("keeps preload=metadata, so the tile is still its own thumbnail", async () => {
    // No poster attribute is needed or wanted: preload="metadata" paints the
    // first frame. Dropping it to "none" would leave a black square until
    // the operator pressed play, which is a worse panel than the one being
    // fixed.
    const user = userEvent.setup();
    const el = await selectTheVideo(user);

    expect(el?.getAttribute("preload")).toBe("metadata");
  });

  it("is announced, rather than hidden from assistive tech", async () => {
    const user = userEvent.setup();
    await selectTheVideo(user);

    expect(screen.getByLabelText(/play @clip1/i)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// "Use element" — the /ugc References box's own way into this picker's
// Elements tab. Only rendered when a caller passes onUseElement (the Image
// Generator, which uses this same component with `imagesOnly`, never does),
// and its three states — usable, already in the box, box full — are what the
// box relies on to keep an operator from adding what it cannot hold.
// ---------------------------------------------------------------------------

describe('UgcReferencePicker\'s "Use element" button', () => {
  async function openJenDetail(
    user: ReturnType<typeof userEvent.setup>,
    props: Partial<Parameters<typeof UgcReferencePicker>[0]> = {},
  ): Promise<void> {
    render(
      <UgcReferencePicker
        projectId="proj-1"
        elements={ELEMENTS}
        current={null}
        onPick={vi.fn()}
        {...props}
      />,
    );
    // "References" when onUseElement is passed, "Upload" otherwise.
    await user.click(screen.getByRole("button", { name: /^(upload|references)$/i }));
    await user.click(await screen.findByRole("tab", { name: /elements/i }));
    await user.click(await screen.findByRole("button", { name: /^show @jen$/i }));
  }

  it("is absent when the caller passes no onUseElement — the Image Generator's own shape", async () => {
    const user = userEvent.setup();
    await openJenDetail(user);

    expect(
      screen.queryByRole("button", {
        name: /use element|already in this scene|references are full/i,
      }),
    ).toBeNull();
  });

  it("hands the element to the parent and closes the dialog", async () => {
    const user = userEvent.setup();
    const onUseElement = vi.fn();
    await openJenDetail(user, { onUseElement, boxTags: [], boxLimit: 10 });

    await user.click(screen.getByRole("button", { name: /^use element$/i }));

    expect(onUseElement).toHaveBeenCalledTimes(1);
    expect(onUseElement.mock.calls[0]?.[0]).toMatchObject({ id: "el-1", name: "jen" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("adds the element and closes the dialog on a double-click of its card", async () => {
    const user = userEvent.setup();
    const onUseElement = vi.fn();
    await openJenDetail(user, { onUseElement, boxTags: [], boxLimit: 10 });

    await user.dblClick(screen.getByRole("button", { name: /^show @jen$/i }));

    expect(onUseElement).toHaveBeenCalledTimes(1);
    expect(onUseElement.mock.calls[0]?.[0]).toMatchObject({ id: "el-1", name: "jen" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("adds every Shift+clicked card with one Use N", async () => {
    const user = userEvent.setup();
    const onUseElement = vi.fn();
    await openJenDetail(user, { onUseElement, boxTags: [], boxLimit: 10 });

    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("button", { name: /^show @bottle$/i }));
    await user.keyboard("{/Shift}");
    await user.click(screen.getByRole("button", { name: /^use 2$/i }));

    expect(onUseElement.mock.calls.map((c) => c[0].name)).toEqual(["jen", "bottle"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says why, and adds nothing, when the double-clicked element is already in the box", async () => {
    const user = userEvent.setup();
    const onUseElement = vi.fn();
    toastNotice.mockClear();
    await openJenDetail(user, { onUseElement, boxTags: ["jen"], boxLimit: 10 });

    await user.dblClick(screen.getByRole("button", { name: /^show @jen$/i }));

    expect(onUseElement).not.toHaveBeenCalled();
    expect(toastNotice).toHaveBeenCalledWith(expect.stringMatching(/already in this scene/i));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("says why, and adds nothing, when the box is full", async () => {
    const user = userEvent.setup();
    const onUseElement = vi.fn();
    toastNotice.mockClear();
    const full = Array.from({ length: 10 }, (_, i) => `ref${i}`);
    await openJenDetail(user, { onUseElement, boxTags: full, boxLimit: 10 });

    await user.dblClick(screen.getByRole("button", { name: /^show @jen$/i }));

    expect(onUseElement).not.toHaveBeenCalled();
    expect(toastNotice).toHaveBeenCalledWith(expect.stringMatching(/references are full \(10\)/i));
  });

  it('reads "Already in this scene", disabled, when the box already holds this tag', async () => {
    const user = userEvent.setup();
    const onUseElement = vi.fn();
    await openJenDetail(user, { onUseElement, boxTags: ["jen"], boxLimit: 10 });

    const button = screen.getByRole("button", { name: /already in this scene/i });
    expect(button.hasAttribute("disabled")).toBe(true);

    await user.click(button);
    expect(onUseElement).not.toHaveBeenCalled();
  });

  it('is case-insensitive about "already in this scene", the same as findElementByTag', async () => {
    const user = userEvent.setup();
    await openJenDetail(user, { onUseElement: vi.fn(), boxTags: ["JEN"], boxLimit: 10 });

    expect(screen.getByRole("button", { name: /already in this scene/i })).toBeTruthy();
  });

  it('reads "References are full (N)", disabled, when the box is at its cap', async () => {
    const user = userEvent.setup();
    const onUseElement = vi.fn();
    // "jen" itself is not in this box, so the button's disabled reason is
    // unambiguously the cap and not "already in this scene".
    await openJenDetail(user, {
      onUseElement,
      boxTags: ["a", "b", "c"],
      boxLimit: 3,
    });

    const button = screen.getByRole("button", { name: /references are full \(3\)/i });
    expect(button.hasAttribute("disabled")).toBe(true);

    await user.click(button);
    expect(onUseElement).not.toHaveBeenCalled();
  });

  it("stays usable at one slot below the cap", async () => {
    const user = userEvent.setup();
    await openJenDetail(user, { onUseElement: vi.fn(), boxTags: ["a", "b"], boxLimit: 3 });

    const button = screen.getByRole("button", { name: /^use element$/i });
    expect(button.hasAttribute("disabled")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// elementsOnly — ugc-column.tsx's Kling Start/End frame slots. No Uploads
// tab, no Uploads tab TRIGGER, and no non-image element anywhere in the
// Elements grid this mode shows, under any filter — see restrictToImages'
// own comment on the component for why "all" alone used to leak this.
// ---------------------------------------------------------------------------

describe("UgcReferencePicker's elementsOnly mode", () => {
  const jen: ElementTag = {
    id: "el-1",
    name: "jen",
    category: "character",
    description: "the presenter",
    assetKind: "ref_frame",
    previewUrl: "https://example.test/jen.jpg",
  };
  const narrator: ElementTag = {
    id: "el-audio",
    name: "narrator",
    category: "audio",
    description: "a calm voice",
    assetKind: "audio",
    previewUrl: "https://example.test/narrator.mp3",
  };
  const clip: ElementTag = {
    id: "el-video",
    name: "clip1",
    category: "video",
    description: "b-roll",
    assetKind: "video_ref",
    previewUrl: "https://example.test/clip1.mp4",
  };
  const MIXED: readonly ElementTag[] = [jen, narrator, clip];

  it("has no Uploads tab and no Elements tab trigger — it opens straight on Elements", () => {
    render(
      <UgcReferencePicker
        projectId="proj-1"
        elements={MIXED}
        current={null}
        onPick={vi.fn()}
        elementsOnly
        hideTrigger
        open
        onOpenChange={vi.fn()}
        onUseElement={vi.fn()}
      />,
    );

    expect(screen.queryByRole("tab", { name: /uploads/i })).toBeNull();
    expect(screen.queryByRole("tab", { name: /elements/i })).toBeNull();
    // Straight on Elements without any tab to click for it.
    expect(screen.getByRole("button", { name: /^show @jen$/i })).toBeTruthy();
  });

  it("never lists audio or video, under any filter, even though the caller passed them in", () => {
    render(
      <UgcReferencePicker
        projectId="proj-1"
        elements={MIXED}
        current={null}
        onPick={vi.fn()}
        elementsOnly
        hideTrigger
        open
        onOpenChange={vi.fn()}
        onUseElement={vi.fn()}
      />,
    );

    // No Audio/Video filter pills at all — restrictToImages narrows the
    // filter row the same way imagesOnly always has.
    expect(screen.queryByRole("button", { name: /^audio$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^video$/i })).toBeNull();
    // And — the actual fix — neither element shows under "All" either,
    // which is the filter this dialog opens on.
    expect(screen.queryByRole("button", { name: /narrator/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /clip1/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^show @jen$/i })).toBeTruthy();
  });

  it("has no trigger of its own — hideTrigger is meaningless without it, and Kling's frame slots supply their own", () => {
    render(
      <UgcReferencePicker
        projectId="proj-1"
        elements={MIXED}
        current={null}
        onPick={vi.fn()}
        elementsOnly
        hideTrigger
        open={false}
        onOpenChange={vi.fn()}
        onUseElement={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /^upload$/i })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("imagesOnly's own fix: an audio/video element is invisible even without elementsOnly", async () => {
    // The Image Generator's own mode (/images/[id]) — imagesOnly alone, no
    // Kling involved — gets the same correction: before this, "All" showed
    // every kind regardless, and only the FILTER PILLS were narrowed.
    const user = userEvent.setup();
    render(
      <UgcReferencePicker
        projectId="proj-1"
        elements={MIXED}
        current={null}
        onPick={vi.fn()}
        imagesOnly
      />,
    );
    await user.click(screen.getByRole("button", { name: /^upload$/i }));
    await user.click(await screen.findByRole("tab", { name: /elements/i }));

    expect(screen.getByRole("button", { name: /^show @jen$/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /narrator/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /clip1/i })).toBeNull();
  });
});
