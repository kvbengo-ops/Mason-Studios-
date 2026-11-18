// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setSceneKeep } from "@/actions/scene-organize";
import { deleteClipScene } from "@/actions/ugc";
import { StaleClipsPrompt, type StaleClip } from "./stale-clips-prompt";

vi.mock("@/actions/scene-organize", () => ({ setSceneKeep: vi.fn() }));
vi.mock("@/actions/ugc", () => ({ deleteClipScene: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  unstable_rethrow: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const clips: StaleClip[] = [
  { sceneId: "scene-a", prompt: "A cat", madeAt: "2026-11-05T00:00:00Z", posterUrl: null },
  { sceneId: "scene-b", prompt: "A dog", madeAt: "2026-11-06T00:00:00Z", posterUrl: null },
];

function sceneIds(fn: typeof setSceneKeep | typeof deleteClipScene): string[] {
  return vi.mocked(fn).mock.calls.map(([formData]) => String(formData.get("sceneId")));
}

describe("StaleClipsPrompt", () => {
  it("shows nothing without stale clips", () => {
    const { container } = render(<StaleClipsPrompt clips={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("keeps the selected clips and moves the rest to the Bin after a confirm", async () => {
    render(<StaleClipsPrompt clips={clips} />);
    expect(screen.getByText(/2 stale videos/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep A cat" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep 1, clean up 1" }));
    expect(deleteClipScene).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm: move 1 to Bin" }));

    await waitFor(() => expect(deleteClipScene).toHaveBeenCalledTimes(1));
    expect(sceneIds(setSceneKeep)).toEqual(["scene-a"]);
    expect(vi.mocked(setSceneKeep).mock.calls[0]![0].get("keep")).toBe("true");
    expect(sceneIds(deleteClipScene)).toEqual(["scene-b"]);
  });

  it("cleans up all when none is selected", async () => {
    render(<StaleClipsPrompt clips={clips} />);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Clean up all 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm: move 2 to Bin" }));

    await waitFor(() => expect(deleteClipScene).toHaveBeenCalledTimes(2));
    expect(sceneIds(deleteClipScene)).toEqual(["scene-a", "scene-b"]);
    expect(setSceneKeep).not.toHaveBeenCalled();
  });
});
