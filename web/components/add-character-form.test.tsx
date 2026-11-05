// @vitest-environment jsdom
//
// Problem 2's regression coverage: the old markup asked for Name +
// Description twice (upload path, then an identical "OR" pair for
// generate), which read as a rendering bug. These tests cover that the
// fields now appear exactly once, and that submitting on either photo-
// source path calls the right server action with the fields that action
// actually needs.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
vi.mock("@/lib/stage-files", () => ({ stageFiles: vi.fn(async () => {}) }));

import { AddCharacterForm } from "./add-character-form";
import type { ActionResult } from "@/lib/action-result";

// jsdom has no DataTransfer implementation, and its file input's `.files`
// is a getter with no setter — real browsers special-case assignment
// there, jsdom doesn't. ReferenceDropzone's own submitFile
// (components/reference-dropzone.tsx) always re-wraps a chosen file
// through `new DataTransfer()` and reassigns `input.files` from it, on
// both the drag-and-drop AND plain-picker paths, so exercising either
// needs both gaps closed: a minimal DataTransfer stand-in, and a `files`
// descriptor on the specific input that actually accepts the reassignment
// (see the getFileInput helper below) rather than throwing.
beforeAll(() => {
  if (typeof globalThis.DataTransfer === "undefined") {
    class FakeDataTransfer {
      private readonly fileList: File[] = [];
      items = {
        add: (file: File): void => {
          this.fileList.push(file);
        },
      };
      get files(): FileList {
        return toFileList(this.fileList);
      }
    }
    // @ts-expect-error -- test-only polyfill, not a full DataTransfer
    globalThis.DataTransfer = FakeDataTransfer;
  }
});

function toFileList(files: File[]): FileList {
  const indexed: Record<number, File> = {};
  files.forEach((file, index) => {
    indexed[index] = file;
  });
  return {
    length: files.length,
    item: (index: number) => files[index] ?? null,
    [Symbol.iterator]: () => files[Symbol.iterator](),
    ...indexed,
  } as unknown as FileList;
}

/**
 * Grabs the ReferenceDropzone's hidden file input and gives it a `files`
 * property with a real setter — jsdom's native one is getter-only, which
 * is exactly what submitFile's own reassignment (see the header comment
 * above) throws on. The getter starts out backing whatever was last set,
 * same as a real input.
 */
function getFileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  let current: FileList = toFileList([]);
  Object.defineProperty(input, "files", {
    configurable: true,
    get: () => current,
    set: (next: FileList) => {
      current = next;
    },
  });
  return input;
}

afterEach(() => {
  cleanup();
});

describe("AddCharacterForm", () => {
  it("asks for Name and Description exactly once", () => {
    render(
      <AddCharacterForm
        uploadAction={vi.fn(async (_formData: FormData): Promise<ActionResult> => undefined)}
        generateAction={vi.fn(async (_formData: FormData): Promise<ActionResult> => undefined)}
        generateCostUsd={0.02}
      />,
    );

    expect(screen.getAllByLabelText(/^name\b/i)).toHaveLength(1);
    expect(screen.getAllByLabelText(/^description\b/i)).toHaveLength(1);
  });

  it("shows the generate price before it can be triggered", () => {
    render(
      <AddCharacterForm
        uploadAction={vi.fn(async (_formData: FormData): Promise<ActionResult> => undefined)}
        generateAction={vi.fn(async (_formData: FormData): Promise<ActionResult> => undefined)}
        generateCostUsd={0.02}
      />,
    );

    // Visible on the source-picker tab itself, before it's even selected.
    expect(screen.getByRole("radio", { name: /generate \(\$0\.02\)/i })).toBeTruthy();
  });

  it("submits through the upload action on the upload path", async () => {
    const user = userEvent.setup();
    const uploadAction = vi.fn(async (_formData: FormData): Promise<ActionResult> => undefined);
    const generateAction = vi.fn(async (_formData: FormData): Promise<ActionResult> => undefined);
    render(
      <AddCharacterForm
        uploadAction={uploadAction}
        generateAction={generateAction}
        generateCostUsd={0.02}
      />,
    );

    await user.type(screen.getByLabelText(/^name\b/i), "Jamie");
    await user.type(screen.getByLabelText(/^description\b/i), "A woman in her late 20s.");

    const file = new File(["fake-bytes"], "jamie.jpg", { type: "image/jpeg" });
    const fileInput = getFileInput();
    fileInput.files = toFileList([file]);
    fireEvent.change(fileInput);

    // ReferenceDropzone auto-submits the form the moment a file lands —
    // no explicit submit button on this path, matching the pre-existing
    // upload UX this form reuses.
    await waitFor(() => expect(uploadAction).toHaveBeenCalledTimes(1));
    expect(generateAction).not.toHaveBeenCalled();
    const submitted = uploadAction.mock.calls[0]?.[0] as FormData;
    expect(submitted.get("name")).toBe("Jamie");
    expect(submitted.get("description")).toBe("A woman in her late 20s.");
    // Not asserting the File's own name/bytes: jsdom's FormData(form)
    // reads a file input's real internal file-selection slot, which only
    // a genuine OS file-picker or drop event ever populates — the
    // `files` override above (needed just to stop submitFile's own
    // reassignment from throwing) doesn't reach it, a jsdom limitation
    // unrelated to this component. What's actually under test here is
    // routing: dropping a file calls uploadAction, not generateAction,
    // and carries the shared name/description fields — confirmed above.
    expect(submitted.get("file")).toBeInstanceOf(File);
  });

  it("submits through the generate action on the generate path, without a file field", async () => {
    const user = userEvent.setup();
    const uploadAction = vi.fn(async (_formData: FormData): Promise<ActionResult> => undefined);
    const generateAction = vi.fn(async (_formData: FormData): Promise<ActionResult> => undefined);
    render(
      <AddCharacterForm
        uploadAction={uploadAction}
        generateAction={generateAction}
        generateCostUsd={0.02}
      />,
    );

    await user.type(screen.getByLabelText(/^name\b/i), "Jamie");
    await user.type(screen.getByLabelText(/^description\b/i), "A woman in her late 20s.");
    await user.click(screen.getByRole("radio", { name: /generate \(\$0\.02\)/i }));
    await user.click(screen.getByRole("button", { name: /^generate reference photo/i }));

    expect(generateAction).toHaveBeenCalledTimes(1);
    expect(uploadAction).not.toHaveBeenCalled();
    const submitted = generateAction.mock.calls[0]?.[0] as FormData;
    expect(submitted.get("name")).toBe("Jamie");
    expect(submitted.get("description")).toBe("A woman in her late 20s.");
    // Switching away from the upload tab unmounts its file input entirely
    // — nothing stray gets sent alongside the generate call.
    expect(submitted.get("file")).toBeNull();
  });
});
