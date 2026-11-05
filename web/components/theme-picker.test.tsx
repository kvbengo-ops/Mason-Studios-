// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemePicker } from "./theme-picker";
import { THEME_LIST } from "@/config/theme";
import { getCommittedTheme } from "@/lib/theme-store";

// jsdom does not implement scrollIntoView, and the keyboard-nav effect calls
// it unguarded on every ArrowDown — see scene-table.test.tsx, projects-table.test.tsx.
if (!("scrollIntoView" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "scrollIntoView", { value: () => {}, writable: true });
}

afterEach(() => {
  cleanup();
  document.cookie = "ugc-theme=; path=/; max-age=0";
  delete document.documentElement.dataset.theme;
});

async function openPicker(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  render(<ThemePicker collapsed={false} />);
  await user.click(screen.getByRole("button", { name: "Theme" }));
  // The input mounts inside a Radix portal; findBy* is the one await needed
  // for that to settle, so every query after this in a test can be sync.
  return screen.findByRole("combobox");
}

// The row after whatever is committed when the test starts (no cookie is
// ever set outside a test, so this is THEME's row before any interaction).
function rowAfterCommitted(): (typeof THEME_LIST)[number] {
  const committedId = getCommittedTheme();
  const index = THEME_LIST.findIndex((entry) => entry.id === committedId);
  return THEME_LIST[(index + 1) % THEME_LIST.length]!;
}

describe("ThemePicker", () => {
  it("opens the dialog from the trigger", async () => {
    const user = userEvent.setup();
    await openPicker(user);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("renders exactly one option per registered theme", async () => {
    const user = userEvent.setup();
    await openPicker(user);
    expect(screen.getAllByRole("option")).toHaveLength(THEME_LIST.length);
  });

  it("narrows to a single option on a matching query", async () => {
    const user = userEvent.setup();
    const input = await openPicker(user);

    await user.type(input, "higg");

    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: "higgsfield" })).toBeTruthy();
  });

  it("shows the no-match row and no options for a query with no match", async () => {
    const user = userEvent.setup();
    const input = await openPicker(user);

    await user.type(input, "zzz");

    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/No themes match/)).toBeTruthy();
  });

  it("previews on ArrowDown by writing the attribute only, not the cookie", async () => {
    const user = userEvent.setup();
    const input = await openPicker(user);
    const preview = rowAfterCommitted();

    await user.type(input, "{ArrowDown}");

    expect(document.documentElement.dataset.theme).toBe(preview.id);
    expect(document.cookie).not.toMatch(/ugc-theme=/);
  });

  it("restores the committed theme when Escape closes after a preview", async () => {
    const user = userEvent.setup();
    const input = await openPicker(user);
    const committedId = getCommittedTheme();

    await user.type(input, "{ArrowDown}");
    expect(document.documentElement.dataset.theme).not.toBe(committedId);

    await user.type(input, "{Escape}");

    expect(document.documentElement.dataset.theme).toBe(committedId);
    expect(document.cookie).not.toMatch(/ugc-theme=/);
  });

  it("writes both the attribute and the cookie on Enter", async () => {
    const user = userEvent.setup();
    const input = await openPicker(user);
    const preview = rowAfterCommitted();

    await user.type(input, "{ArrowDown}{Enter}");

    expect(document.documentElement.dataset.theme).toBe(preview.id);
    expect(document.cookie).toContain(`ugc-theme=${preview.id}`);
  });

  it("does NOT revert the commit once the dialog finishes closing after Enter", async () => {
    // Regression guard: handleOpenChange used to reapply a theme captured
    // when the dialog opened, repainting the old theme over the commit that
    // Enter had just made — cookie says the new theme, screen says the old
    // one. This is the single most important assertion in this file.
    const user = userEvent.setup();
    const input = await openPicker(user);
    const preview = rowAfterCommitted();

    await user.type(input, "{ArrowDown}{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(document.documentElement.dataset.theme).toBe(preview.id);
    expect(document.cookie).toContain(`ugc-theme=${preview.id}`);
    expect(getCommittedTheme()).toBe(preview.id);
  });

  it("keeps the Check on the committed row while the cursor previews a different row", async () => {
    const user = userEvent.setup();
    const input = await openPicker(user);
    const committedId = getCommittedTheme();
    const committedEntry = THEME_LIST.find((entry) => entry.id === committedId)!;
    const previewEntry = rowAfterCommitted();

    await user.type(input, "{ArrowDown}");

    expect(screen.getByRole("option", { name: `${committedEntry.label} current` })).toBeTruthy();
    expect(screen.getByRole("option", { name: previewEntry.label })).toBeTruthy();
  });

  it("does nothing and does not throw when Enter is pressed on an empty filter", async () => {
    const user = userEvent.setup();
    const input = await openPicker(user);
    const committedId = getCommittedTheme();

    await user.type(input, "zzz{Enter}");

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    // Not asserted: the painted attribute. userEvent types one character at a
    // time, so a prefix of a no-match query can legitimately match and preview
    // — "z" alone hits "solarized light". The preview then stays put once the
    // query stops matching, which is the intended behaviour: it would flicker
    // back to the committed theme on every mistyped character otherwise.
    // What must hold is that nothing was COMMITTED.
    expect(document.cookie).not.toMatch(/ugc-theme=/);
    expect(getCommittedTheme()).toBe(committedId);
  });

  it("keeps the cursor in range when the filter narrows past the previous cursor index", async () => {
    const user = userEvent.setup();
    const input = await openPicker(user);

    await user.type(input, "{End}"); // cursor -> last row of the full, unfiltered list
    await user.type(input, "dark{Enter}"); // narrows to one row, at index 0

    expect(document.documentElement.dataset.theme).toBe("studio-dark");
    expect(document.cookie).toContain("ugc-theme=studio-dark");
  });

  it("renders a swatch scoped to higgsfield's row", async () => {
    // STRUCTURAL ONLY: jsdom computes no cascade, so this proves the swatch
    // element exists and is scoped to higgsfield's row — not that its dots
    // render the right colour.
    const user = userEvent.setup();
    await openPicker(user);

    const higgsfieldOption = screen.getByRole("option", { name: "higgsfield" });
    expect(
      higgsfieldOption.querySelector('[data-theme="higgsfield"][aria-hidden="true"]'),
    ).toBeTruthy();
  });
});
