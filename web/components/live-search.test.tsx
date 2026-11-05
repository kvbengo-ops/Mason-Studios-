// @vitest-environment jsdom
//
// Covers one thing this component had no coverage for: the Search button is
// a no-JS fallback and must not be presented to a visitor whose JS is
// running. Typing already searches after DEBOUNCE_MS, so a visible button
// teaches "type, then click" and makes every search feel like it waited on
// a click it never needed.
//
// next/navigation is mocked because useRouter/usePathname/useSearchParams
// all throw outside a Next request — the same reason other component tests
// in this directory mock their server-side imports.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LiveSearch } from "./live-search";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/projects",
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(cleanup);

function renderSearch(): void {
  render(
    <LiveSearch
      q=""
      placeholder="Search projects…"
      ariaLabel="Search projects"
      action="/projects"
      clearHref={null}
    >
      <div>results</div>
    </LiveSearch>,
  );
}

describe("LiveSearch — the no-JS Search button", () => {
  it("does not offer a Search button to a scripting visitor", () => {
    renderSearch();

    // jsdom has scripting enabled, so <noscript> contents are inert: React
    // renders them as markup the accessibility tree never exposes. If this
    // starts finding a button, the fallback has escaped its <noscript> and
    // is being shown to everyone again.
    expect(screen.queryByRole("button", { name: /^search$/i })).toBeNull();
  });

  it("still ships the fallback in the server-rendered markup", async () => {
    // Server markup, not the jsdom tree, and that distinction is the point:
    // a no-JS visitor never runs React's client render — they get exactly
    // the HTML the server sent. Asserting against the client tree would
    // test a path that visitor never takes (and jsdom reports empty
    // textContent for <noscript> children anyway, since scripting is on
    // there).
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(
      <LiveSearch
        q=""
        placeholder="Search projects\u2026"
        ariaLabel="Search projects"
        action="/projects"
        clearHref={null}
      >
        <div>results</div>
      </LiveSearch>,
    );

    // Hidden from JS visitors, but NOT deleted — without JS, typing does
    // nothing and this submit is the only way to search at all.
    expect(html).toMatch(/<noscript>[\s\S]*Search[\s\S]*<\/noscript>/);
    expect(html).toMatch(/<noscript>[\s\S]*type="submit"[\s\S]*<\/noscript>/);
  });

  it("keeps the search input itself reachable by its accessible name", () => {
    renderSearch();

    // Guards the obvious over-correction: hiding the button must not hide
    // the field it sat next to.
    expect(screen.getByRole("searchbox", { name: "Search projects" })).toBeTruthy();
  });

  it("composes optional leading controls into the search toolbar", () => {
    render(
      <LiveSearch
        q=""
        placeholder="Search projects…"
        ariaLabel="Search projects"
        action="/projects"
        clearHref={null}
        leadingControls={<span>Everyone</span>}
      >
        <div>results</div>
      </LiveSearch>,
    );

    expect(screen.getByText("Everyone")).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search projects" })).toBeTruthy();
  });
});
