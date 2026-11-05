import type { JSX } from "react";
import { RemoveReferenceButton } from "@/components/remove-reference-button";
import { RegenerateCharacterButton } from "@/components/regenerate-character-button";
import { RAIL_ENTRY_CHARACTER } from "@/lib/project-rail";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/action-result";

/**
 * The character reference photo, with the controls that act on it, as one
 * card beside the description on the Character screen.
 *
 * The card is where STALENESS is said, and that is the whole reason this is
 * a component rather than inline JSX on the page. The photo is generated
 * FROM the description, so the moment the text changes the photo is of the
 * old text — and this used to be announced by a banner inside the
 * description block, below the portrait, reading "the portrait below was
 * generated…". It pointed in the wrong direction once the two sat side by
 * side, and it put the warning in a different block from the only control
 * that answers it. Now the picture itself is dimmed, the card is outlined,
 * the words are on the card, and the regenerate button is directly beneath
 * them.
 *
 * Nothing here regenerates on its own. That costs money, and the design is
 * explicit that the app says the photo is stale and the OPERATOR decides
 * whether to spend it.
 *
 * Server-renderable (no "use client"): its two interactive children are
 * client components already, and the bound Server Actions pass straight
 * through as props.
 */
export function CharacterPortraitCard({
  imageUrl,
  stale,
  admin,
  fieldsLocked,
  regenerateDisabled,
  costLabel,
  libraryCharacterName,
  removeDescription,
  removeAction,
  regenerateAction,
}: {
  /** Signed URL for the current character_ref asset. */
  imageUrl: string;
  /**
   * True when character_desc_edited_at (0057_description_edit_tracking.sql)
   * is after this asset's created_at — the description changed since this
   * photo was made. Computed server-side; see isDescriptionStale.
   */
  stale: boolean;
  /** isAdmin(profile) && isOwner — regenerateCharacter refuses everyone else server-side (actions/character.ts). */
  admin: boolean;
  /** Project locked, or the viewer is not the owner — hides the destructive remove overlay. */
  fieldsLocked: boolean;
  /** Locked, or there is no description to regenerate from. */
  regenerateDisabled: boolean;
  /** Pre-formatted price, e.g. "$0.04" — estimatedRefFrameCostUsd(imageVendor()) resolved server-side. */
  costLabel: string;
  /** Name of the library character this photo came from, or null. */
  libraryCharacterName: string | null;
  removeDescription: string;
  removeAction: () => Promise<ActionResult>;
  regenerateAction: () => Promise<ActionResult>;
}): JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border p-2",
        stale ? "border-warning ring-1 ring-warning" : "border-border",
      )}
    >
      <div className="relative aspect-square w-full overflow-hidden rounded-md border border-border bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element -- signed URL, not a static import */}
        <img
          src={imageUrl}
          alt="Character reference"
          className={cn("h-full w-full object-contain", stale && "opacity-50")}
          loading="lazy"
          decoding="async"
        />
        {fieldsLocked ? null : (
          <RemoveReferenceButton
            label="character reference"
            description={removeDescription}
            action={removeAction}
            // Hardcoded rather than threaded down as a prop: this component
            // is the Character screen's portrait card and nothing else, so
            // there is no second answer for it to take.
            railEntryId={RAIL_ENTRY_CHARACTER}
          />
        )}
      </div>

      {stale ? (
        <p className="text-[11px] font-medium leading-snug text-warning">
          ⚠ Stale — made from the older description
        </p>
      ) : null}

      {admin ? (
        <RegenerateCharacterButton
          action={regenerateAction}
          disabled={regenerateDisabled}
          costLabel={costLabel}
          libraryCharacterName={libraryCharacterName}
        />
      ) : (
        // A non-admin owner is shown the stale flag above and would
        // otherwise be given nothing at all to do about it. regenerateCharacter
        // refuses non-admins server-side, so the honest answer is not a
        // button that will fail — it is who can press one.
        <p className="text-[11px] leading-snug text-muted-foreground">
          {stale
            ? "Regenerating is admin-only — ask an admin to bring it back in line with the description."
            : "Regenerating is admin-only."}
        </p>
      )}
    </div>
  );
}
