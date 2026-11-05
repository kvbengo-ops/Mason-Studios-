// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppBanner } from "./app-banner";

const config = {
  id: "model-launch-2026-09",
  text: "New models unlocked: Kling 3.0 + Gemini Omni Video",
  cta: "Create now",
  href: "/projects",
};

// Node 25's own localStorage global shadows jsdom's and has no methods.
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
});

describe("AppBanner", () => {
  it("shows the announcement and its project CTA", async () => {
    render(<AppBanner config={config} />);

    expect(await screen.findByRole("status", { name: config.text })).toBeTruthy();
    expect(screen.getByRole("link", { name: /create now/i }).getAttribute("href")).toBe(
      "/projects",
    );
  });

  it("keeps a dismissed campaign hidden for the same id", async () => {
    const user = userEvent.setup();
    render(<AppBanner config={config} />);

    await user.click(await screen.findByRole("button", { name: "Dismiss announcement" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(window.localStorage.getItem(`app-banner:dismissed:${config.id}`)).toBe("1");

    cleanup();
    render(<AppBanner config={config} />);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("shows a new campaign id after an older one was dismissed", async () => {
    window.localStorage.setItem(`app-banner:dismissed:${config.id}`, "1");
    render(<AppBanner config={{ ...config, id: "model-launch-2026-10" }} />);

    expect(await screen.findByRole("status", { name: config.text })).toBeTruthy();
  });
});
