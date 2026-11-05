// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { useEffect } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { SceneBusyFieldset } from "./scene-busy-fieldset";
import { RailBusyProvider, useRailBusySetter } from "@/components/project-rail";

afterEach(() => {
  cleanup();
});

function MarkBusy({ sceneId }: { sceneId: string }): null {
  const setRailBusy = useRailBusySetter();
  useEffect(() => {
    setRailBusy(sceneId, true);
  }, [sceneId, setRailBusy]);
  return null;
}

describe("SceneBusyFieldset", () => {
  it("disables every control inside it, including ones it never sees", () => {
    // The whole reason this is a fieldset: the sidebar it wraps is a Server
    // Component full of controls this file knows nothing about, and
    // `disabled` on a fieldset is inherited by all of them natively.
    render(
      <RailBusyProvider>
        <MarkBusy sceneId="s-1" />
        <SceneBusyFieldset sceneId="s-1">
          <select aria-label="Shooting mode">
            <option>Selfie</option>
          </select>
          <input aria-label="Visual idea" />
          <button type="submit">Save</button>
        </SceneBusyFieldset>
      </RailBusyProvider>,
    );

    // `:disabled`, not `.disabled`. The property reflects only the
    // element's OWN attribute — a control inside a disabled fieldset is
    // non-interactive in every browser while its .disabled stays false. The
    // first version of this test asserted the property and failed against a
    // working implementation.
    expect(screen.getByLabelText("Shooting mode").matches(":disabled")).toBe(true);
    expect(screen.getByLabelText("Visual idea").matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Save" }).matches(":disabled")).toBe(true);
  });

  it("says why", () => {
    render(
      <RailBusyProvider>
        <MarkBusy sceneId="s-1" />
        <SceneBusyFieldset sceneId="s-1">
          <input aria-label="Visual idea" />
        </SceneBusyFieldset>
      </RailBusyProvider>,
    );
    expect(screen.getByText(/Something is still running on this scene/)).toBeTruthy();
  });

  it("leaves everything alone when nothing is running", () => {
    render(
      <RailBusyProvider>
        <SceneBusyFieldset sceneId="s-1">
          <input aria-label="Visual idea" />
        </SceneBusyFieldset>
      </RailBusyProvider>,
    );
    expect(screen.getByLabelText("Visual idea").matches(":disabled")).toBe(false);
    expect(screen.queryByText(/Something is still running/)).toBeNull();
  });

  it("ignores another scene's work", () => {
    // The store is keyed per entry, and a sidebar must not freeze because a
    // different scene is generating.
    render(
      <RailBusyProvider>
        <MarkBusy sceneId="s-2" />
        <SceneBusyFieldset sceneId="s-1">
          <input aria-label="Visual idea" />
        </SceneBusyFieldset>
      </RailBusyProvider>,
    );
    expect(screen.getByLabelText("Visual idea").matches(":disabled")).toBe(false);
  });
});
