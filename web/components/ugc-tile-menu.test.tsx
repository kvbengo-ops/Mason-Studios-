// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { UgcTileMenu } from "@/components/ugc-tile-menu";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// The only /ugc component that had no test of its own, and the one that
// deletes things. What is pinned here is what the menu PROMISES the operator:
// that opening it never submits the tile's form, that an unavailable delete
// says why instead of vanishing, and that a delete in flight looks like one.

// The shape the menu actually ships in: a SIBLING of the tile's control,
// inside the same form. Nesting it in the tile button would be invalid HTML
// and is precisely what this component exists to avoid.
function renderMenu(
  props: Partial<React.ComponentProps<typeof UgcTileMenu>> = {},
  onSubmit: () => void = () => {},
): RenderResult {
  return render(
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <button type="submit">tile</button>
      <UgcTileMenu
        label="v2"
        downloadUrl="https://storage.test/clip.mp4"
        filename="clip.mp4"
        {...props}
      />
    </form>,
  );
}

// No global setup file mounts this, so every file that renders does it
// itself — without it the previous test's menu is still in the document and
// every getByRole finds two.
afterEach(() => {
  cleanup();
  vi.mocked(toast.error).mockClear();
});

describe("UgcTileMenu", () => {
  it("renders nothing when there is neither a download nor a delete", () => {
    // A tile whose render failed has no clip and no version to remove. A bare
    // chevron opening an empty menu would be a control that does nothing.
    const { container } = render(<UgcTileMenu label="v1" downloadUrl={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("does not submit the tile's form when the menu is opened", async () => {
    // The reason this component exists. The tile is a SUBMIT button that
    // promotes a version, and the menu trigger sits in the same form — a
    // trigger that defaulted to type="submit" would promote the very version
    // the operator was only opening a menu on.
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderMenu({}, onSubmit);

    await user.click(screen.getByRole("button", { name: /actions for v2/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    await screen.findByRole("menuitem", { name: /download/i });
  });

  it("offers the clip as a download named after the file", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole("button", { name: /actions for v2/i }));

    const link = await screen.findByRole("menuitem", { name: /download/i });
    expect(link.getAttribute("download")).toBe("clip.mp4");
    // asAttachment is what makes Supabase serve the bytes rather than play
    // them; without it "Download" opens a video in a new tab.
    expect(link.getAttribute("href")).toContain("download=clip.mp4");
  });

  it("says why delete is unavailable rather than hiding it", async () => {
    // "The button is missing" and "the button is not for you right now" look
    // identical when the answer is to hide it. The reason is the whole answer.
    const user = userEvent.setup();
    renderMenu({
      onDelete: vi.fn(),
      deleteFields: { sceneId: "s1", versionId: "v2" },
      deleteUnavailableReason: "Current — pick another first",
    });

    await user.click(screen.getByRole("button", { name: /actions for v2/i }));

    const item = await screen.findByRole("menuitem", { name: /current — pick another first/i });
    expect(item.hasAttribute("data-disabled")).toBe(true);
    expect(screen.queryByRole("menuitem", { name: /^delete$/i })).toBeNull();
  });

  it("sends the delete action exactly the fields it was given", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn().mockResolvedValue(undefined);
    renderMenu({ onDelete, deleteFields: { sceneId: "s1", versionId: "v2" } });

    await user.click(screen.getByRole("button", { name: /actions for v2/i }));
    await user.click(await screen.findByRole("menuitem", { name: /delete/i }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
    const formData = onDelete.mock.calls[0]![0] as FormData;
    expect(formData.get("sceneId")).toBe("s1");
    expect(formData.get("versionId")).toBe("v2");
  });

  it("shows a spinner on the trigger while the delete is in flight", async () => {
    // The standing rule: an in-flight control spins. Before this the trigger
    // only went disabled, which reads the same as a control disabled for any
    // other reason — and a delete that appears to have done nothing is how
    // an operator ends up clicking it twice.
    const user = userEvent.setup();
    let release: () => void = () => {};
    const onDelete = vi.fn(
      (): Promise<void> =>
        new Promise<void>((resolve) => {
          release = (): void => resolve();
        }),
    );
    const { container } = renderMenu({
      onDelete,
      deleteFields: { sceneId: "s1", versionId: "v2" },
    });

    await user.click(screen.getByRole("button", { name: /actions for v2/i }));
    await user.click(await screen.findByRole("menuitem", { name: /delete/i }));

    await waitFor(() => expect(container.querySelector(".animate-spin")).not.toBeNull());

    release();
    await waitFor(() => expect(container.querySelector(".animate-spin")).toBeNull());
  });

  // Editors reported deletes had no confirmation. ugc-scene-strip.tsx is one
  // of two call sites sharing this menu, and it is the one that opts in via
  // confirmMessage — see it and ugc-version-rail.tsx (which does not) for
  // why the two must not behave the same.
  describe("confirmMessage", () => {
    it("submits the delete when the operator confirms", async () => {
      const user = userEvent.setup();
      const onDelete = vi.fn().mockResolvedValue(undefined);
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      renderMenu({
        onDelete,
        deleteFields: { sceneId: "s1" },
        confirmMessage: "Delete scene 3? Every version of this clip goes with it.",
      });

      await user.click(screen.getByRole("button", { name: /actions for v2/i }));
      await user.click(await screen.findByRole("menuitem", { name: /delete/i }));

      expect(confirmSpy).toHaveBeenCalledWith(
        "Delete scene 3? Every version of this clip goes with it.",
      );
      await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
      confirmSpy.mockRestore();
    });

    it("submits nothing when the operator cancels", async () => {
      const user = userEvent.setup();
      const onDelete = vi.fn().mockResolvedValue(undefined);
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      renderMenu({
        onDelete,
        deleteFields: { sceneId: "s1" },
        confirmMessage: "Delete scene 3? Every version of this clip goes with it.",
      });

      await user.click(screen.getByRole("button", { name: /actions for v2/i }));
      await user.click(await screen.findByRole("menuitem", { name: /delete/i }));

      // There is nothing async left to await once submitDelete returns
      // early, so this is the assertion, not a race against one.
      expect(onDelete).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it("deletes with no prompt at all when confirmMessage is absent — the version-rail call site", async () => {
      // ugc-version-rail.tsx never passes confirmMessage: deleteClipVersion
      // already refuses the current and the last version, and a confirm on
      // top of that would be asking permission for something the server
      // mostly just does. Byte-identical to this menu's behaviour before
      // confirmMessage existed.
      const user = userEvent.setup();
      const onDelete = vi.fn().mockResolvedValue(undefined);
      const confirmSpy = vi.spyOn(window, "confirm");
      renderMenu({ onDelete, deleteFields: { sceneId: "s1", versionId: "v2" } });

      await user.click(screen.getByRole("button", { name: /actions for v2/i }));
      await user.click(await screen.findByRole("menuitem", { name: /delete/i }));

      expect(confirmSpy).not.toHaveBeenCalled();
      await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
      confirmSpy.mockRestore();
    });
  });

  it("surfaces an ActionResult error from the delete instead of discarding it", async () => {
    // deleteClipScene returns { error: "..." } rather than throwing (React
    // redacts a thrown Server Action error in production — lib/action-result.ts)
    // when the scene is still rendering. Before this the menu awaited and
    // dropped that result, so the refusal reached nobody.
    const user = userEvent.setup();
    const onDelete = vi.fn().mockResolvedValue({
      error: "This clip is still rendering. Wait for it to finish or fail, then delete it.",
    });
    renderMenu({ onDelete, deleteFields: { sceneId: "s1" } });

    await user.click(screen.getByRole("button", { name: /actions for v2/i }));
    await user.click(await screen.findByRole("menuitem", { name: /delete/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "This clip is still rendering. Wait for it to finish or fail, then delete it.",
      ),
    );
  });

  // F3: deleteClipScene/deleteClipVersion don't only return an ActionResult
  // — they also THROW (a real DB failure, or requireScene's
  // AuthorizationError on a stale id), and submitDelete had no catch at all.
  // The chevron spun, stopped, and said nothing — the same silent-refusal
  // class the ActionResult test above already guards, left in this half of
  // the function.
  it("surfaces a THROWN delete error instead of discarding it, and still stops the spinner", async () => {
    const user = userEvent.setup();
    const onDelete = vi
      .fn()
      .mockRejectedValue(new Error("Failed to delete the clip: connection reset"));
    const { container } = renderMenu({ onDelete, deleteFields: { sceneId: "s1" } });

    await user.click(screen.getByRole("button", { name: /actions for v2/i }));
    await user.click(await screen.findByRole("menuitem", { name: /delete/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Failed to delete the clip: connection reset"),
    );
    // The spinner still has to clear — `finally` runs even when the catch
    // above re-throws nothing further, but a regression that forgot the
    // `finally` (or moved it above a rethrow) would leave this spinning.
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("surfaces a non-Error thrown value with a fallback naming the tile, not a blank toast", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn().mockRejectedValue("connection reset");
    renderMenu({ onDelete, deleteFields: { sceneId: "s1" } });

    await user.click(screen.getByRole("button", { name: /actions for v2/i }));
    await user.click(await screen.findByRole("menuitem", { name: /delete/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Failed to delete v2."));
  });

  it("a notFound()-shaped rejection (requireProject, on a stale scene/version id) surfaces via toast instead of blanking the console", async () => {
    // Same reasoning as delete-project-dialog.tsx's identically-named
    // isNotFoundError: unstable_rethrow would otherwise let this straight
    // into /ugc's own route error boundary, replacing the whole console
    // over one tile's delete.
    const user = userEvent.setup();
    const notFoundError = Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK"), {
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    const onDelete = vi.fn().mockRejectedValue(notFoundError);
    renderMenu({ onDelete, deleteFields: { sceneId: "s1" } });

    await user.click(screen.getByRole("button", { name: /actions for v2/i }));
    await user.click(await screen.findByRole("menuitem", { name: /delete/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "That's no longer available, or isn't yours to delete.",
      ),
    );
  });

  it("a redirect()-shaped rejection still propagates instead of being toasted, pinning navigation behaviour", async () => {
    // Neither deleteClipScene nor deleteClipVersion redirects today, but
    // unstable_rethrow stays in submitDelete's catch so a future change
    // that adds one isn't silently swallowed by the toast below — this
    // pins that the digest it would carry is not mistaken for the 404 case
    // above and toasted instead.
    const user = userEvent.setup();
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;push;/ugc;307;",
    });
    const onDelete = vi.fn().mockRejectedValue(redirectError);
    renderMenu({ onDelete, deleteFields: { sceneId: "s1" } });

    const caught = new Promise<unknown>((resolve) => {
      const onUncaught = (err: unknown): void => {
        process.off("uncaughtException", onUncaught);
        process.off("unhandledRejection", onUncaught);
        resolve(err);
      };
      process.once("uncaughtException", onUncaught);
      process.once("unhandledRejection", onUncaught);
    });

    await user.click(screen.getByRole("button", { name: /actions for v2/i }));
    await user.click(await screen.findByRole("menuitem", { name: /delete/i }));

    expect(await caught).toBe(redirectError);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
