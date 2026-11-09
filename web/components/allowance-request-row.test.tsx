// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AllowanceRequestRow } from "./allowance-request-row";
import { TableCell } from "@/components/ui/table";

afterEach(cleanup);

function renderRow() {
  return render(
    <table>
      <tbody>
        <AllowanceRequestRow
          requestId="request-1"
          userId="user-1"
          username="Editor"
          email="editor@example.com"
          requestedUsd={25}
          reason={"First paragraph.\nSecond paragraph with full context."}
          status="denied"
          createdAt="2026-11-10T09:00:00.000Z"
          decidedByEmail="admin@example.com"
          decidedAt="2026-11-10T10:00:00.000Z"
          decisionNote="Please include the project budget next time."
        >
          <TableCell>editor@example.com</TableCell>
          <TableCell>Request details</TableCell>
          <TableCell>
            <button type="button">Approve</button>
          </TableCell>
        </AllowanceRequestRow>
      </tbody>
    </table>,
  );
}

describe("AllowanceRequestRow", () => {
  it("opens the complete request preview when a table cell is clicked", async () => {
    const user = userEvent.setup();
    renderRow();

    await user.click(screen.getByText("Request details"));

    const dialog = screen.getByRole("dialog", { name: "Allowance request" });
    expect(
      within(dialog).getByText(
        (_, element) =>
          element?.tagName === "DD" &&
          element.textContent?.includes("First paragraph.\nSecond paragraph with full context.") ===
            true,
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText(/admin@example.com · Nov 10, 2026, 6:00 PM/)).toBeTruthy();
    expect(within(dialog).getByText("Please include the project budget next time.")).toBeTruthy();
    expect(within(dialog).getByText("request-1")).toBeTruthy();
    expect(within(dialog).getByText("user-1")).toBeTruthy();
  });

  it("keeps action buttons out of the row preview click", async () => {
    const user = userEvent.setup();
    renderRow();

    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
