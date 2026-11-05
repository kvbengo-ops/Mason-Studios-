// @vitest-environment jsdom
//
// Pins the two things this component promises: it disappears entirely when
// there is nothing archived (not an empty box — see this component's own
// header), and every row it does show carries a Restore control that spins
// — the GitHub Actions ring, never dots or a swapped label — exactly like
// every other in-flight control on this page (Regenerate's own spinner,
// setActiveVersion's tiles).

import type ReactDOM from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { UgcDeletedScenes, type UgcDeletedScene } from "./ugc-deleted-scenes";

vi.mock("@/actions/ugc", () => ({
  restoreScene: vi.fn(async () => undefined),
}));

// Same reasoning as ugc-version-rail.test.tsx: useFormStatus only reports
// pending inside a real <form action={...}> submit in flight, which jsdom
// cannot drive from a unit test, so it is mocked to assert what SubmitButton
// renders WHILE a submit is in flight, on demand.
const mockFormStatus = vi.fn(() => ({ pending: false }));
vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof ReactDOM>("react-dom");
  return { ...actual, useFormStatus: () => mockFormStatus() };
});

afterEach(() => {
  cleanup();
  mockFormStatus.mockReturnValue({ pending: false });
});

function aDeletedScene(over: Partial<UgcDeletedScene> & { sceneId: string }): UgcDeletedScene {
  return {
    idx: 3,
    promptFirstLine: "A cat knocks a glass off a table.",
    deletedAtLabel: "Aug 29, 2026, 1:00 PM",
    ...over,
  };
}

describe("UgcDeletedScenes", () => {
  it("renders nothing at all when there is nothing archived", () => {
    // Not an empty box — a project that never lost a scene should not carry
    // a permanent "Recently deleted" husk at its foot.
    const { container } = render(<UgcDeletedScenes scenes={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("lists an archived scene with its index, prompt and deleted-at label, and a Restore button", () => {
    render(<UgcDeletedScenes scenes={[aDeletedScene({ sceneId: "scene-1" })]} />);

    expect(screen.getByText("#3")).toBeTruthy();
    expect(screen.getByText("A cat knocks a glass off a table.")).toBeTruthy();
    expect(screen.getByText(/aug 29, 2026/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
  });

  it("shows the archived index as an em dash rather than a bare blank when it was never recorded", () => {
    render(<UgcDeletedScenes scenes={[aDeletedScene({ sceneId: "scene-1", idx: null })]} />);
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("falls back to a placeholder for a scene that never had a prompt", () => {
    render(
      <UgcDeletedScenes
        scenes={[aDeletedScene({ sceneId: "scene-1", promptFirstLine: "(no prompt)" })]}
      />,
    );
    expect(screen.getByText("(no prompt)")).toBeTruthy();
  });

  it("shows every archived scene, newest first as the caller ordered them", () => {
    render(
      <UgcDeletedScenes
        scenes={[
          aDeletedScene({ sceneId: "scene-2", idx: 5 }),
          aDeletedScene({ sceneId: "scene-1", idx: 3 }),
        ]}
      />,
    );
    const rendered = screen.getAllByText(/^#\d+$/).map((el) => el.textContent);
    expect(rendered).toEqual(["#5", "#3"]);
  });

  it("hides the Restore control for a read-only viewer, same as UgcSceneStrip hides Delete", () => {
    render(<UgcDeletedScenes scenes={[aDeletedScene({ sceneId: "scene-1" })]} readOnly />);
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  });

  it("shows the GitHub-Actions spinner on Restore while a restore is in flight", () => {
    mockFormStatus.mockReturnValue({ pending: true });
    render(<UgcDeletedScenes scenes={[aDeletedScene({ sceneId: "scene-1" })]} />);

    const button = screen.getByRole("button");
    expect(button.querySelector("svg.animate-spin")).not.toBeNull();
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("shows no spinner at rest", () => {
    render(<UgcDeletedScenes scenes={[aDeletedScene({ sceneId: "scene-1" })]} />);
    const button = screen.getByRole("button");
    expect(button.querySelector("svg.animate-spin")).toBeNull();
  });
});
