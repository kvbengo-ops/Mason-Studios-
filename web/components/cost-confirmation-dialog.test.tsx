// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCostConfirmation } from "./cost-confirmation-dialog";

afterEach(cleanup);

it("shows the app cost dialog and resolves Cancel or Confirm", async () => {
  const onResult = vi.fn();
  function Harness() {
    const [confirm, dialog] = useCostConfirmation();
    return (
      <>
        <button
          onClick={() => {
            void confirm({
              title: "Describe @product1?",
              estimateUsd: 0.001,
              action: "Confirm description",
            }).then(onResult);
          }}
        >
          Describe
        </button>
        {dialog}
      </>
    );
  }
  render(<Harness />);

  fireEvent.click(screen.getByRole("button", { name: "Describe" }));
  expect(screen.getByRole("dialog").textContent).toContain("Describe @product1?");
  expect(screen.getByRole("dialog").textContent).toContain("$0.0010");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(onResult).toHaveBeenLastCalledWith(false));

  fireEvent.click(screen.getByRole("button", { name: "Describe" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm description" }));
  await waitFor(() => expect(onResult).toHaveBeenLastCalledWith(true));
});
