// @vitest-environment jsdom
//
// This control had no tests at all when it shipped. It is the direct fix for
// the green-pouch incident — a lime-green pouch sat uploaded while the typed
// description said matte kraft paper, and the compiler reads only the text —
// so the rule it must never break is the same one its sibling enforces: the
// suggestion is PREVIEWED, never written on the operator's behalf.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DescribeFromPhotoButton } from "./describe-from-photo-button";
import { describeProductFromPhoto } from "@/actions/character";

vi.mock("@/actions/character", () => ({
  describeProductFromPhoto: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.mocked(describeProductFromPhoto).mockReset();
});

const SUGGESTION = "A slim matte pouch in bright lime green, with a white sans-serif wordmark.";

function renderButton(props: { currentValue?: string; hasPhoto?: boolean } = {}) {
  const onAccept = vi.fn();
  render(
    <DescribeFromPhotoButton
      projectId="project-1"
      costUsd={0.01}
      disabled={false}
      hasPhoto={props.hasPhoto ?? true}
      currentValue={props.currentValue ?? ""}
      onAccept={onAccept}
    />,
  );
  return { onAccept, user: userEvent.setup() };
}

describe("DescribeFromPhotoButton", () => {
  it("previews the suggestion and writes nothing until Accept", async () => {
    vi.mocked(describeProductFromPhoto).mockResolvedValue({ suggestion: SUGGESTION });
    const { onAccept, user } = renderButton();

    await user.click(screen.getByRole("button", { name: /describe from photo/i }));
    await waitFor(() => expect(screen.getByText(SUGGESTION)).toBeTruthy());
    expect(onAccept).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^accept$/i }));
    expect(onAccept).toHaveBeenCalledWith(SUGGESTION);
  });

  it("Discard drops it without touching the field", async () => {
    vi.mocked(describeProductFromPhoto).mockResolvedValue({ suggestion: SUGGESTION });
    const { onAccept, user } = renderButton();

    await user.click(screen.getByRole("button", { name: /describe from photo/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /discard/i })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: /discard/i }));

    expect(screen.queryByText(SUGGESTION)).toBeNull();
    expect(onAccept).not.toHaveBeenCalled();
  });

  // Unlike its sibling, this suggestion comes from the PHOTO, so there is no
  // older version of the text for it to be stale against. Whatever is in the
  // field is at risk equally — the operator who wrote a careful paragraph and
  // then clicked this out of curiosity is the one being protected.
  it("warns that Accept overwrites words already in the field", async () => {
    vi.mocked(describeProductFromPhoto).mockResolvedValue({ suggestion: SUGGESTION });
    const { user } = renderButton({ currentValue: "matte kraft paper, forest-green label" });

    // Text already in the field means the label reads "Check against
    // photo", not "Describe from photo" — see the component's own comment
    // on why "Describe" would read as "this will overwrite what I wrote".
    await user.click(screen.getByRole("button", { name: /check against photo/i }));
    await waitFor(() => expect(screen.getByText(SUGGESTION)).toBeTruthy());

    expect(screen.getByText(/replaces everything currently in the field/i)).toBeTruthy();
  });

  it("stays quiet when the field is empty, and when it holds only whitespace", async () => {
    vi.mocked(describeProductFromPhoto).mockResolvedValue({ suggestion: SUGGESTION });
    const { user } = renderButton({ currentValue: "   \n  " });

    await user.click(screen.getByRole("button", { name: /describe from photo/i }));
    await waitFor(() => expect(screen.getByText(SUGGESTION)).toBeTruthy());

    expect(screen.queryByText(/replaces everything currently in the field/i)).toBeNull();
  });

  it("shows the price before the click", () => {
    renderButton();
    expect(screen.getByRole("button", { name: /\$0\.01/ })).toBeTruthy();
  });

  // The design marks the paid calls with ✦ and sets the amount apart from
  // the label rather than folding it into the sentence — the label says what
  // happens, the amount says what it costs. It stays inside the button, so
  // the accessible name still carries the price to a screen reader.
  it("sets the price apart from the label instead of folding it into the sentence", () => {
    renderButton();
    const amount = screen.getByText("$0.01");
    expect(amount.tagName).toBe("SPAN");
    expect(amount.textContent).toBe("$0.01");
    expect(screen.getByRole("button", { name: /describe from photo/i }).textContent).not.toContain(
      "($0.01)",
    );
  });

  it("offers no live click without a photo — the call could only fail server-side", () => {
    renderButton({ hasPhoto: false });
    expect(
      screen.getByRole("button", { name: /describe from photo/i }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("surfaces a refusal in place, rather than as a toast that scrolls away", async () => {
    vi.mocked(describeProductFromPhoto).mockResolvedValue({
      error: "Upload a product photo first — there's nothing to describe from yet.",
    });
    const { user } = renderButton();

    await user.click(screen.getByRole("button", { name: /describe from photo/i }));
    await waitFor(() => expect(screen.getByText(/nothing to describe from yet/i)).toBeTruthy());
  });
});
