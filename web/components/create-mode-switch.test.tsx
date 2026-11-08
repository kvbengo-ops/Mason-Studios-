// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CreateModeContent, CreateModeSwitch } from "./create-mode-switch";

afterEach((): void => {
  cleanup();
});

describe("CreateModeSwitch skeleton loading", () => {
  it("shows the video generator skeleton when switching from Image to Video until the route updates", () => {
    const { rerender } = render(
      <div>
        <CreateModeSwitch video={false} imageHref="/create" videoHref="/create?tab=video" />
        <CreateModeContent video={false}>
          <div data-testid="image-console">Image console</div>
        </CreateModeContent>
      </div>,
    );

    expect(screen.getByTestId("image-console")).toBeTruthy();

    const videoLink = screen.getByRole("link", { name: /^video$/i });
    fireEvent.click(videoLink);

    expect(screen.queryByTestId("image-console")).toBeNull();
    const skeleton = screen.getByRole("status", { name: /loading video generator/i });
    expect(skeleton).toBeTruthy();
    expect(skeleton.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(videoLink.getAttribute("aria-current")).toBe("page");

    rerender(
      <div>
        <CreateModeSwitch video={true} imageHref="/create" videoHref="/create?tab=video" />
        <CreateModeContent video={true}>
          <div data-testid="video-console">Video console</div>
        </CreateModeContent>
      </div>,
    );

    expect(screen.queryByRole("status", { name: /loading video generator/i })).toBeNull();
    expect(screen.getByTestId("video-console")).toBeTruthy();
  });

  it("shows the image generator skeleton when switching from Video to Image", () => {
    render(
      <div>
        <CreateModeSwitch video={true} imageHref="/create" videoHref="/create?tab=video" />
        <CreateModeContent video={true}>
          <div data-testid="video-console">Video console</div>
        </CreateModeContent>
      </div>,
    );

    fireEvent.click(screen.getByRole("link", { name: /^image$/i }));

    expect(screen.queryByTestId("video-console")).toBeNull();
    const skeleton = screen.getByRole("status", { name: /loading image generator/i });
    expect(skeleton).toBeTruthy();
    expect(skeleton.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it("keeps the active console on screen when clicking the already-active mode", () => {
    render(
      <div>
        <CreateModeSwitch video={false} imageHref="/create" videoHref="/create?tab=video" />
        <CreateModeContent video={false}>
          <div data-testid="image-console">Image console</div>
        </CreateModeContent>
      </div>,
    );

    fireEvent.click(screen.getByRole("link", { name: /^image$/i }));

    expect(screen.getByTestId("image-console")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
