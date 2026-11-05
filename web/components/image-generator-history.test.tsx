// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ImageAttempt } from "@/actions/image-generator";
import { ImageAttemptPanel } from "./image-attempt-panel";
import { ImageGeneratorHistory } from "./image-generator-history";
import { IMAGE_REUSE_EVENT, type ImageReuseDetail } from "@/lib/image-reuse";

vi.mock("@/components/save-generated-element-button", () => ({
  SaveGeneratedElementButton: () => null,
}));

afterEach(cleanup);

const attempt = (runId: string, status: ImageAttempt["status"]): ImageAttempt => ({
  runId,
  idempotencyKey: `key-${runId}`,
  createdAt: "2026-10-30T00:00:00Z",
  status,
  model: "google/nano-banana",
  kieTaskId: null,
  reason: null,
  image: null,
  costUsd: null,
});

describe("ImageGeneratorHistory", () => {
  it("puts a placeholder tile on the wall for every image still rendering", () => {
    render(
      <ImageAttemptPanel
        initialAttempts={[
          attempt("a", "generating"),
          attempt("b", "queued"),
          attempt("c", "failed"),
        ]}
        reconcileAction={vi.fn(() => new Promise<never>(() => {}))}
      >
        <ImageGeneratorHistory
          initialPage={{ images: [], nextCursor: null }}
          loadMoreAction={vi.fn()}
          downloadAction={vi.fn()}
          detailsAction={vi.fn()}
          elements={[]}
        />
      </ImageAttemptPanel>,
    );

    // Two in flight, the failed one is not; and no "Nothing generated yet".
    const wall = screen.getByRole("region", { name: "Image history" });
    expect(within(wall).getAllByText(/^(Generating image|Queued image)$/)).toHaveLength(2);
    expect(screen.queryByText("Nothing generated yet")).toBeNull();
  });

  it("Reuse sends the image's prompt, model and ratio to the bar", async () => {
    const reuse = vi.fn();
    window.addEventListener(IMAGE_REUSE_EVENT, (event) =>
      reuse((event as CustomEvent<ImageReuseDetail>).detail),
    );
    render(
      <ImageAttemptPanel initialAttempts={[]} reconcileAction={vi.fn()}>
        <ImageGeneratorHistory
          initialPage={{
            images: [{ assetId: "a1", url: "https://x/a.png", createdAt: "2026-10-30T00:00:00Z" }],
            nextCursor: null,
          }}
          loadMoreAction={vi.fn()}
          downloadAction={vi.fn()}
          detailsAction={vi.fn(async () => ({
            prompt: "A fox @mara_ref",
            model: "Nano Banana",
            modelId: "nano-banana",
            url: "https://x/full.png",
          }))}
          elements={[]}
        />
      </ImageAttemptPanel>,
    );

    // The thumbnail's natural size drives the ratio; jsdom has none, so 16:9.
    const img = screen.getAllByRole("img")[0] as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 1600 });
    Object.defineProperty(img, "naturalHeight", { value: 900 });
    fireEvent.load(img);
    expect(await screen.findByLabelText("Aspect ratio 16:9")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /view generated image/i }));
    fireEvent.click(await screen.findByRole("button", { name: /reuse prompt and settings/i }));

    expect(reuse).toHaveBeenCalledWith({
      prompt: "A fox @mara_ref",
      modelId: "nano-banana",
      aspectRatio: "16:9",
    });
  });

  it("learns a tile's shape from a thumbnail that was already loaded before hydration", () => {
    // The server-rendered <img> is complete by the time React attaches, so its
    // onLoad never fires — the wall must read the size itself.
    const complete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete");
    const width = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalWidth");
    const height = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalHeight");
    Object.defineProperty(HTMLImageElement.prototype, "complete", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
      configurable: true,
      get: () => 1600,
    });
    Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", {
      configurable: true,
      get: () => 900,
    });
    try {
      render(
        <ImageAttemptPanel initialAttempts={[]} reconcileAction={vi.fn()}>
          <ImageGeneratorHistory
            initialPage={{
              images: [
                { assetId: "a1", url: "https://x/a.png", createdAt: "2026-10-30T00:00:00Z" },
              ],
              nextCursor: null,
            }}
            loadMoreAction={vi.fn()}
            downloadAction={vi.fn()}
            detailsAction={vi.fn()}
            elements={[]}
          />
        </ImageAttemptPanel>,
      );
      expect(screen.getByLabelText("Aspect ratio 16:9")).toBeTruthy();
    } finally {
      for (const [name, d] of [
        ["complete", complete],
        ["naturalWidth", width],
        ["naturalHeight", height],
      ] as const) {
        if (d) Object.defineProperty(HTMLImageElement.prototype, name, d);
        else delete (HTMLImageElement.prototype as unknown as Record<string, unknown>)[name];
      }
    }
  });
});
