// @vitest-environment jsdom
//
// Product page — field isolation and Save wiring. Mirrors character-setup-
// form.test.tsx's own coverage for the Character page's split-off field.
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as NextNavigation from "next/navigation";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ProductSetupForm,
  ProductNameField,
  ProductAppearanceField,
  SaveButton,
} from "./product-setup-form";
import type { ActionResult } from "@/lib/action-result";

// SetupForm calls useRouter() (it navigates to the next Setup step on a
// successful save), which throws "invariant expected app router to be
// mounted" without a real AppRouterContext. Only useRouter is replaced —
// unstable_rethrow stays the real one, since SetupForm's catch depends on
// it to re-throw Next's own control-flow errors rather than toasting them.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
});

function renderProductFields(): ReturnType<typeof render> {
  return render(
    <ProductSetupForm action={async () => undefined} fallbackErrorMessage="failed">
      <ProductNameField initialValue="" locked={false} />
      <ProductAppearanceField
        initialValue=""
        locked={false}
        projectId="project-1"
        describeCostUsd={0.01}
        hasProductPhoto={false}
      />
    </ProductSetupForm>,
  );
}

describe("Product page — field isolation", () => {
  it("renders the product fields, and no field from another split page", () => {
    renderProductFields();

    expect(screen.getByLabelText(/^\d+\. product name$/i)).toBeTruthy();
    expect(screen.getByRole("textbox", { name: /product appearance/i })).toBeTruthy();
    // Character page field.
    expect(screen.queryByRole("textbox", { name: /describe your character/i })).toBeNull();
    // Script page field.
    expect(screen.queryByLabelText(/^script$/i)).toBeNull();
  });
});

describe("Product page — Save posts through the product form", () => {
  it("submits product_name and product_appearance to the bound action when Save is clicked", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async (_formData: FormData): Promise<ActionResult> => undefined);

    render(
      <ProductSetupForm action={action} fallbackErrorMessage="failed">
        <ProductNameField initialValue="" locked={false} />
        <ProductAppearanceField
          initialValue=""
          locked={false}
          projectId="project-1"
          describeCostUsd={0.01}
          hasProductPhoto={false}
        />
        <SaveButton locked={false} />
      </ProductSetupForm>,
    );

    await user.type(screen.getByLabelText(/^\d+\. product name$/i), "NeuroBlast");
    await user.type(
      screen.getByRole("textbox", { name: /product appearance/i }),
      "Matte green pouch, white logo.",
    );
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(action).toHaveBeenCalledTimes(1);
    const submitted = action.mock.calls[0]?.[0] as FormData;
    expect(submitted.get("product_name")).toBe("NeuroBlast");
    expect(submitted.get("product_appearance")).toBe("Matte green pouch, white logo.");
  });
});

// The photo-vs-text warning was gated on the description being thin or
// empty, which put it out of the room for the incident it exists to catch:
// the green-pouch description was LONG, and wrong. Length is not agreement,
// so while there is a photo to disagree with, the warning stands.
describe("ProductAppearanceField — the photo-vs-text warning", () => {
  function renderField(props: { value: string; hasProductPhoto: boolean }) {
    render(
      <ProductSetupForm action={async () => undefined} fallbackErrorMessage="failed">
        <ProductAppearanceField
          initialValue={props.value}
          locked={false}
          projectId="p1"
          describeCostUsd={0.01}
          hasProductPhoto={props.hasProductPhoto}
        />
      </ProductSetupForm>,
    );
  }

  const FULL =
    "Matte lime-green stand-up pouch, soft-touch finish, white sans-serif wordmark centred near the top, resealable zip strip along the upper edge.";

  it("warns when a photo exists and the text is too thin to match it", () => {
    // The green-pouch incident exactly: a photo uploaded, a description too
    // thin to contradict it with, and the compiler reading only the text.
    renderField({ value: "a green pouch", hasProductPhoto: true });
    expect(screen.getByText(/never from the photo/i)).toBeTruthy();
  });

  it("warns when a photo exists and nothing has been typed at all", () => {
    renderField({ value: "", hasProductPhoto: true });
    expect(screen.getByText(/never from the photo/i)).toBeTruthy();
  });

  // The one this used to get wrong. "matte kraft-paper pouch with a
  // forest-green label" is a perfectly full description of a product that is
  // not the one in the photo, so a length threshold cannot be what decides
  // whether the operator is told the compiler ignores the picture.
  it("stays up when the description is substantial — length is not agreement", () => {
    renderField({ value: FULL, hasProductPhoto: true });
    expect(screen.getByText(/never from the photo/i)).toBeTruthy();
  });

  it("stays quiet when there is no photo to disagree with", () => {
    // Nothing to contradict: the text is the only input, so there is no
    // silent-disagreement failure available here, and a warning about a
    // photo that does not exist is a warning about nothing.
    renderField({ value: "a green pouch", hasProductPhoto: false });
    expect(screen.queryByText(/never from the photo/i)).toBeNull();
  });

  it("still calls out a thin description with no photo uploaded", () => {
    renderField({ value: "a green pouch", hasProductPhoto: false });
    expect(screen.getByText(/too thin/i)).toBeTruthy();
  });

  it("says nothing about length once the description is substantial", () => {
    renderField({ value: FULL, hasProductPhoto: false });
    expect(screen.queryByText(/too thin/i)).toBeNull();
  });
});

// Design note 1: this field used to offer TWO AI buttons at the same price —
// "Describe from photo" (reads the image) and "Improve with AI" (rewrites
// the text) — which forced the operator to decide which INPUT won, on the
// exact screen that exists because the photo and the text can disagree.
// They are now one control: describeProductFromPhoto reads both the photo
// and whatever text is already there and reconciles them. There is no
// second AI button here any more, and so no second price.
describe("ProductAppearanceField — one AI control, not two", () => {
  it("renders exactly one AI control, and it is the describe/check-against-photo button", () => {
    render(
      <ProductSetupForm action={async () => undefined} fallbackErrorMessage="failed">
        <ProductAppearanceField
          initialValue="a green pouch"
          locked={false}
          projectId="p1"
          describeCostUsd={0.01}
          hasProductPhoto
        />
      </ProductSetupForm>,
    );

    // Text is already in the field, so the label reads "Check against
    // photo" rather than "Describe from photo".
    const describe = screen.getByRole("button", { name: /check against photo/i });
    expect(describe.className).toContain("bg-primary");

    // No "Improve with AI" / "Rewrite my words" button sits beside it —
    // there is nothing left to choose between.
    expect(screen.queryByRole("button", { name: /rewrite my words/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /improve with ai/i })).toBeNull();

    // Only one button total in the field's control row — one AI action,
    // one price.
    expect(screen.getAllByRole("button", { name: /\$0\.01/ })).toHaveLength(1);
  });
});
