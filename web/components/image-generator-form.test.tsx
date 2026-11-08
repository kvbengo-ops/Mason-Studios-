// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ElementTag } from "@/lib/elements";
import type { ImageModelDescriptor } from "@/lib/models";
import { ImageAttemptPanel } from "./image-attempt-panel";
import { ImageGeneratorForm } from "./image-generator-form";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/ugc-prompt-editor", () => ({
  UgcPromptEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea
      aria-label="Prompt"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
vi.mock("@/components/ugc-reference-picker", () => ({ UgcReferencePicker: () => null }));
vi.mock("@/components/save-generated-element-button", () => ({
  SaveGeneratedElementButton: () => null,
}));
vi.mock("@/components/image-lightbox", () => ({
  ImageLightbox: ({ src }: { src: string }) => <span data-testid="preview">{src}</span>,
}));

const model: ImageModelDescriptor = {
  id: "seedream-5.0-pro",
  label: "Seedream 5.0 Pro",
  textToImageId: "seedream/5-pro-text-to-image",
  editId: "seedream/5-pro-image-to-image",
  costUsd: 0.035,
  observedSeconds: 91.9,
  editObservedSeconds: 149,
  aspectRatios: ["9:16"],
};

beforeEach(() => {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("Image Generator prompt draft persistence", () => {
  it("restores the prompt after the form unmounts and mounts again", async () => {
    const props = {
      action: vi.fn(),
      models: [model],
      disabledReason: null,
      projectId: null,
      elements: [],
    };
    const { unmount } = render(<ImageGeneratorForm {...props} />);
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "A portrait at dawn" } });

    const stored = JSON.parse(window.localStorage.getItem("image-generator:draft:personal")!);
    expect(stored.prompt).toBe("A portrait at dawn");
    unmount();

    render(<ImageGeneratorForm {...props} />);
    await waitFor(() =>
      expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe(
        "A portrait at dawn",
      ),
    );
  });
});

describe("Image Generator background completion", () => {
  it("does not submit or reserve a request key when confirmation is cancelled", () => {
    const action = vi.fn();
    render(
      <ImageGeneratorForm
        action={action}
        models={[model]}
        disabledReason={null}
        projectId={null}
        elements={[]}
      />,
    );
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "A portrait" } });
    fireEvent.submit(screen.getByRole("button", { name: "Generate" }).closest("form")!);
    expect(screen.getByRole("dialog").textContent).toContain("Seedream 5.0 Pro");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(action).not.toHaveBeenCalled();
    expect(
      JSON.parse(window.localStorage.getItem("image-generator:draft:personal")!).imageCount,
    ).toBe(1);
  });
  it("keeps Generate live while an image renders, and each press is its own image", async () => {
    // The first render never settles: the second press must not wait for it,
    // and must not reuse its key (that would hand back the first picture).
    const action = vi.fn((_formData: FormData) => new Promise<never>(() => {}));
    render(
      <ImageAttemptPanel initialAttempts={[]} reconcileAction={vi.fn()}>
        <ImageGeneratorForm
          action={action}
          models={[model]}
          disabledReason={null}
          projectId={null}
          elements={[]}
        />
      </ImageAttemptPanel>,
    );
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "A portrait" } });

    for (let press = 1; press <= 2; press += 1) {
      const generate = screen.getByRole("button", { name: "Generate" }) as HTMLButtonElement;
      expect(generate.disabled).toBe(false);
      fireEvent.click(generate);
      fireEvent.click(screen.getByRole("button", { name: "Confirm generation" }));
      await waitFor(() => expect(action).toHaveBeenCalledTimes(press));
    }

    const keys = action.mock.calls.map(([formData]) => formData.get("idempotencyKey"));
    expect(new Set(keys).size).toBe(2);
    expect(screen.getByRole("button", { name: "Generate" }).textContent).toContain("2 generating");
  });

  it("generates four independently charged images from the same prompt", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async (_formData: FormData) => ({ error: "test refusal" }));
    render(
      <ImageGeneratorForm
        action={action}
        models={[model]}
        disabledReason={null}
        projectId={null}
        elements={[]}
      />,
    );
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "A portrait" } });
    await user.click(screen.getByRole("button", { name: "Images: 1" }));
    await user.click(screen.getByRole("menuitem", { name: "4 images" }));
    fireEvent.submit(screen.getByRole("button", { name: "Generate 4 images" }).closest("form")!);
    expect(screen.getByRole("dialog").textContent).toContain("Generate 4 images?");
    await user.click(screen.getByRole("button", { name: "Confirm generation" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(4));
    const formData = action.mock.calls.map(([data]) => data);
    expect(formData.map((data) => data.get("prompt"))).toEqual([
      "A portrait",
      "A portrait",
      "A portrait",
      "A portrait",
    ]);
    expect(new Set(formData.map((data) => data.get("idempotencyKey"))).size).toBe(4);
  });

  it("fills the prompt when the viewer asks to Reuse an image", async () => {
    render(
      <ImageAttemptPanel initialAttempts={[]} reconcileAction={vi.fn()}>
        <ImageGeneratorForm
          action={vi.fn()}
          models={[model]}
          disabledReason={null}
          projectId={null}
          elements={[]}
        />
      </ImageAttemptPanel>,
    );
    act(() => {
      window.dispatchEvent(
        new CustomEvent("image-reuse", {
          detail: { prompt: "A fox @mara_ref", modelId: model.id, aspectRatio: "9:16" },
        }),
      );
    });
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("A fox @mara_ref");
  });

  it("shows a tagged picture as a chip in a References box, and removing it removes the tag", () => {
    const mara = {
      id: "el-1",
      name: "mara_ref",
      category: "image",
      assetKind: "ref_frame",
      previewUrl: "https://x/mara.png",
    } as unknown as ElementTag;
    render(
      <ImageAttemptPanel initialAttempts={[]} reconcileAction={vi.fn()}>
        <ImageGeneratorForm
          action={vi.fn()}
          models={[model]}
          disabledReason={null}
          projectId={null}
          elements={[mara]}
        />
      </ImageAttemptPanel>,
    );
    expect(screen.queryByText("References")).toBeNull();

    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "A fox with @mara_ref" },
    });
    expect(screen.getByText("References").textContent).toContain("1/10");
    expect(screen.getByText("@mara_ref")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove @mara_ref reference" }));
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).not.toContain(
      "@mara_ref",
    );
    expect(screen.queryByText("References")).toBeNull();
  });

  it("offers a Resolution menu where kie documents tiers, with unmeasured ones disabled", async () => {
    const user = userEvent.setup();
    render(
      <ImageAttemptPanel initialAttempts={[]} reconcileAction={vi.fn()}>
        <ImageGeneratorForm
          action={vi.fn()}
          models={[{ ...model, resolutions: ["1K", "2K", "4K"] }]}
          disabledReason={null}
          projectId={null}
          elements={[]}
        />
      </ImageAttemptPanel>,
    );
    await user.click(screen.getByRole("button", { name: "Resolution: 1K" }));
    const twoK = screen.getByRole("menuitem", { name: /2K/ });
    expect(twoK.getAttribute("aria-disabled")).toBe("true");
    expect(twoK.textContent).toContain("Pricing pending");
    expect(screen.getByRole("menuitem", { name: /1K/ }).getAttribute("aria-disabled")).toBeNull();
  });

  it("has no Resolution menu for a model with no tiers", () => {
    render(
      <ImageAttemptPanel initialAttempts={[]} reconcileAction={vi.fn()}>
        <ImageGeneratorForm
          action={vi.fn()}
          models={[model]}
          disabledReason={null}
          projectId={null}
          elements={[]}
        />
      </ImageAttemptPanel>,
    );
    expect(screen.queryByRole("button", { name: /Resolution:/ })).toBeNull();
  });

  it("warns in the confirm dialog when an @tag matches no saved element, without blocking", () => {
    render(
      <ImageAttemptPanel initialAttempts={[]} reconcileAction={vi.fn()}>
        <ImageGeneratorForm
          action={vi.fn()}
          models={[model]}
          disabledReason={null}
          projectId={null}
          elements={[]}
        />
      </ImageAttemptPanel>,
    );
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "A fox by @ghost" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    expect(screen.getByRole("dialog").textContent).toContain(
      "@ghost doesn't match any saved element",
    );
    expect(
      (screen.getByRole("button", { name: "Confirm generation" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("shows no warning when every @tag is a saved picture", () => {
    const mara = {
      id: "el-1",
      name: "mara_ref",
      category: "image",
      assetKind: "ref_frame",
      previewUrl: "https://x/mara.png",
    } as unknown as ElementTag;
    render(
      <ImageAttemptPanel initialAttempts={[]} reconcileAction={vi.fn()}>
        <ImageGeneratorForm
          action={vi.fn()}
          models={[model]}
          disabledReason={null}
          projectId={null}
          elements={[mara]}
        />
      </ImageAttemptPanel>,
    );
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "A fox with @mara_ref" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    expect(screen.getByRole("dialog").textContent).not.toContain("doesn't match");
  });
});
