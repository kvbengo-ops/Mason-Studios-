// @vitest-environment jsdom
//
// jsdom, not the suite default — this renders real DOM to assert on
// className/text content, same reasoning as sidebar-shell.test.tsx.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { getInitials, InitialsAvatar } from "./initials-avatar";

afterEach(() => {
  cleanup();
});

describe("getInitials", () => {
  it("derives two initials from a two-word local part", () => {
    expect(getInitials("john_tester@gmail.com")).toBe("JT");
  });

  it("derives up to two initials from a single-word local part", () => {
    expect(getInitials("darwin@example.com")).toBe("DA");
  });

  it("returns empty string for a null or empty email", () => {
    expect(getInitials(null)).toBe("");
    expect(getInitials(undefined)).toBe("");
    expect(getInitials("")).toBe("");
  });
});

describe("InitialsAvatar", () => {
  it("renders the derived initials", () => {
    render(<InitialsAvatar email="john_tester@gmail.com" />);
    expect(screen.getByText("JT")).toBeTruthy();
  });

  it("gives the same email the same background colour slot every render", () => {
    const { container: first } = render(<InitialsAvatar email="ops@yopmail.com" />);
    const firstClass = first.querySelector("span")?.className;
    cleanup();
    const { container: second } = render(<InitialsAvatar email="ops@yopmail.com" />);
    const secondClass = second.querySelector("span")?.className;

    expect(firstClass).toBeTruthy();
    expect(firstClass).toBe(secondClass);
  });

  it("assigns different emails to at least sometimes-different colour slots", () => {
    // Not a strict "must differ" assertion (a hash can collide), just a
    // sanity check that the slot classes aren't identical across a very
    // different set of inputs, catching a regression where hashToChartSlotClass
    // returned a constant.
    const chartClassPattern = /bg-chart-[1-5]/;
    const emails = ["a@x.com", "bb@x.com", "ccc@x.com", "dddd@x.com", "eeeee@x.com"];
    const slots = new Set(
      emails.map((email) => {
        const { container } = render(<InitialsAvatar email={email} />);
        const match = container.querySelector("span")?.className.match(chartClassPattern);
        cleanup();
        return match?.[0];
      }),
    );
    expect(slots.size).toBeGreaterThan(1);
  });

  it("renders nothing for a null or empty email, instead of a broken circle", () => {
    const { container } = render(<InitialsAvatar email={null} />);
    expect(container.querySelector("span")).toBeNull();
    expect(container.textContent).toBe("");
  });
});
