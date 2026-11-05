// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ResizablePromptBar } from "./resizable-prompt-bar";

beforeEach(() => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => void values.set(k, v),
    removeItem: (k: string) => void values.delete(k),
    clear: () => values.clear(),
    key: () => null,
    length: 0,
  } as Storage;
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 1000 });
});

afterEach(cleanup);

const handle = (): HTMLElement => screen.getByRole("separator", { name: "Resize prompt box" });
const moveHandle = (): HTMLElement => screen.getByRole("button", { name: "Move prompt box" });
const height = (): string => handle().getAttribute("aria-valuenow") ?? "";

function renderBar() {
  return render(
    <ResizablePromptBar storageKey="test" defaultPx={64}>
      <textarea aria-label="Prompt" />
    </ResizablePromptBar>,
  );
}

describe("ResizablePromptBar", () => {
  it("starts at the default height and grows with the arrow keys, never below it", () => {
    renderBar();
    expect(height()).toBe("64");
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(height()).toBe("88");
    fireEvent.keyDown(handle(), { key: "ArrowDown" });
    fireEvent.keyDown(handle(), { key: "ArrowDown" });
    expect(height()).toBe("64");
  });

  it("drags up to grow, capped to 60% of the viewport", () => {
    renderBar();
    fireEvent.pointerDown(handle(), { clientY: 500, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientY: 400, pointerId: 1 });
    expect(height()).toBe("164");
    fireEvent.pointerMove(handle(), { clientY: -2000, pointerId: 1 });
    expect(height()).toBe("600");
    fireEvent.pointerUp(handle(), { pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientY: 500, pointerId: 1 });
    expect(height()).toBe("600"); // no longer dragging
  });

  it("sizes the textarea inside through the --prompt-h variable", () => {
    const { container } = renderBar();
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect((container.firstElementChild as HTMLElement).style.getPropertyValue("--prompt-h")).toBe(
      "88px",
    );
  });

  it("double-click toggles between default and large; Home resets", () => {
    renderBar();
    fireEvent.doubleClick(handle());
    expect(height()).toBe("400");
    fireEvent.doubleClick(handle());
    expect(height()).toBe("64");
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    fireEvent.keyDown(handle(), { key: "Home" });
    expect(height()).toBe("64");
  });

  it("remembers the height for next time", () => {
    renderBar();
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    cleanup();
    renderBar();
    expect(height()).toBe("88");
  });

  it("drags to a different position, remembers it, and resets on double-click or Home", () => {
    const { container } = renderBar();
    const bar = container.firstElementChild as HTMLElement;
    expect(bar.style.transform).toBe("");

    fireEvent.pointerDown(moveHandle(), { button: 0, clientX: 500, clientY: 800, pointerId: 1 });
    fireEvent.pointerMove(moveHandle(), { clientX: 380, clientY: 600, pointerId: 1 });
    fireEvent.pointerUp(moveHandle(), { pointerId: 1 });

    expect(bar.style.transform).toBe("translate3d(-120px, -200px, 0)");
    expect(bar.getAttribute("data-moved")).toBe("true");

    cleanup();
    const remount = renderBar();
    const remountedBar = remount.container.firstElementChild as HTMLElement;
    expect(remountedBar.style.transform).toBe("translate3d(-120px, -200px, 0)");

    fireEvent.doubleClick(moveHandle());
    expect(remountedBar.style.transform).toBe("");
    expect(remountedBar.getAttribute("data-moved")).toBeNull();

    fireEvent.keyDown(moveHandle(), { key: "ArrowUp" });
    fireEvent.keyDown(moveHandle(), { key: "ArrowRight" });
    expect(remountedBar.style.transform).toBe("translate3d(24px, -24px, 0)");

    fireEvent.keyDown(moveHandle(), { key: "Home" });
    expect(remountedBar.style.transform).toBe("");
  });

  it("drags from the prompt box itself while keeping sides for resizing", () => {
    const { container } = renderBar();
    const bar = container.firstElementChild as HTMLElement;

    // Dragging the prompt box surface itself moves it.
    fireEvent.pointerDown(bar, { button: 0, clientX: 400, clientY: 500, pointerId: 1 });
    fireEvent.pointerMove(bar, { clientX: 450, clientY: 460, pointerId: 1 });
    fireEvent.pointerUp(bar, { pointerId: 1 });
    expect(bar.style.transform).toBe("translate3d(50px, -40px, 0)");

    // Double-clicking the prompt box resets its position.
    fireEvent.doubleClick(bar);
    expect(bar.style.transform).toBe("");

    // Left and right sides resize width.
    const rightEdge = screen.getByRole("separator", { name: "Resize prompt box right" });
    fireEvent.pointerDown(rightEdge, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(rightEdge, { clientX: 560, pointerId: 1 });
    fireEvent.pointerUp(rightEdge, { pointerId: 1 });
    expect(rightEdge.getAttribute("aria-valuenow")).not.toBeNull();
  });
});
