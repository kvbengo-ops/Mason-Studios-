// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const submitIssue = vi.fn();
vi.mock("@/actions/report-issue", () => ({
  submitIssue: (fd: FormData) => submitIssue(fd),
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/ugc/proj-1" }));

import { ReportIssueDialog } from "./report-issue-dialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openAndFill(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  render(<ReportIssueDialog collapsed={false} />);
  await user.click(screen.getByRole("button", { name: /report a problem/i }));
  await user.type(await screen.findByLabelText(/what happened/i), "Generate does nothing");
  await user.type(
    screen.getByLabelText(/tell us more/i),
    "I pressed Generate and nothing happened.",
  );
}

describe("the report dialog", () => {
  it("sends what was typed, with the page it was reported from", async () => {
    submitIssue.mockResolvedValue({ issueNumber: 7, issueUrl: "https://x/7" });
    const user = userEvent.setup();
    await openAndFill(user);

    await user.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => expect(submitIssue).toHaveBeenCalledTimes(1));
    const sent = submitIssue.mock.calls[0]![0] as FormData;
    expect(sent.get("title")).toBe("Generate does nothing");
    expect(sent.get("description")).toBe("I pressed Generate and nothing happened.");
    // The one thing the server cannot know for itself.
    expect(sent.get("route")).toBe("/ugc/proj-1");
    expect(await screen.findByText(/sent as #7/i)).toBeTruthy();
  });

  it("KEEPS THE TEXT when the send fails", async () => {
    // The whole feature turns on this. Somebody wrote it once; they will not
    // write it twice, and a dialog that eats the words loses the thing it
    // existed to collect along with their willingness to try again.
    submitIssue.mockResolvedValue({ error: "GitHub refused the report (HTTP 401)." });
    const user = userEvent.setup();
    await openAndFill(user);

    await user.click(screen.getByRole("button", { name: /^send$/i }));

    expect(await screen.findByText(/HTTP 401/)).toBeTruthy();
    expect((screen.getByLabelText(/what happened/i) as HTMLInputElement).value).toBe(
      "Generate does nothing",
    );
    expect((screen.getByLabelText(/tell us more/i) as HTMLTextAreaElement).value).toBe(
      "I pressed Generate and nothing happened.",
    );
  });

  it("offers the existing issue when the report is a duplicate", async () => {
    // The refusal raises a question — "so where is it?" — and the link is
    // the answer, rather than something to go and look for.
    submitIssue.mockResolvedValue({ error: "You already sent this one a moment ago.", issueUrl: "https://x/3" });
    const user = userEvent.setup();
    await openAndFill(user);

    await user.click(screen.getByRole("button", { name: /^send$/i }));

    const link = await screen.findByRole("link", { name: /see the one you sent/i });
    expect(link.getAttribute("href")).toBe("https://x/3");
  });

  it("survives the action throwing outright", async () => {
    // A thrown error is redacted to "Minified React error #441" in
    // production, so the only honest thing to show is that it failed — but
    // it must still be shown, and the text must still be there.
    submitIssue.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    await openAndFill(user);

    await user.click(screen.getByRole("button", { name: /^send$/i }));

    expect(await screen.findByText("boom")).toBeTruthy();
    expect((screen.getByLabelText(/what happened/i) as HTMLInputElement).value).toBe(
      "Generate does nothing",
    );
  });
});
