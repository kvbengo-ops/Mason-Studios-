import type { JSX } from "react";
import { isAdmin, requireUser } from "@/actions/guard";
import { ElementsLibrary } from "@/components/elements-library";
import { createClient } from "@/lib/supabase/server";
import { loadElementLibraryPage } from "@/lib/element-library";

// The Elements Library: every operator's reusable @tag references
// (0065_elements.sql), in one place, with no project in front of them.
//
// SHARED SINCE 0091_shared_elements_library.sql. This page used to load
// requireUser()'s own id and nothing else, because `elements_select` was
// `user_id = auth.uid() or is_admin()`. It now loads the whole table: the
// Elements Library took the Character Library's sidebar slot (nav-links.tsx),
// which made it the library operators actually see, and it was the one nobody
// could see into.
//
// READING IS SHARED; WRITING IS NOT, and this page is where that split is
// computed. Every card carries its own `canEdit` / `canDelete`, derived per row
// from `elements.user_id` — the same column elements_update and elements_delete
// authorise against, so a card's controls and the policy behind them cannot
// disagree. The Server Actions re-check it anyway (actions/elements.ts runs on
// the admin client, which has no RLS), so hiding a button here is the
// affordance, never the boundary.
//
//   view       EVERY approved account, on every card. Ungated on purpose.
//   download   the same. Both are signed URLs minted server-side by the service
//              role, so the media bucket stays private and no client ever holds
//              a storage key.
//   canEdit    owner, or an admin.
//   canDelete  owner, or an admin.
//
// An admin editing somebody else's @tag rewrites THAT PERSON's scene prompts,
// not the admin's — updateElement follows the rename through the owner's
// prompts (rewriteTagInOwnPrompts), which is what makes admin edit a repair
// rather than a way to silently break somebody's scenes.
//
// WHAT SHARING DOES NOT BUY: the @tag itself. Resolution stays per-owner
// (`unique (user_id, name)`, and loadElementTags keeps its ownerId filter for
// both consoles), so browsing another operator's element tells you it exists
// and does not put it in your vocabulary. The grid says so on the cards that
// are not yours rather than showing an "@name" that would silently substitute
// nothing in your own prompt.
//
// ONE READ, ONE GATE, honestly labelled. loadElementTags runs on the SESSION
// client, so elements_select is still the thing admitting these rows — it is
// simply `using (true)` now. The admin client is not used here and does not
// need to be.
//
// NOT /image-generator. A generated image is not registered as an element — the
// two surfaces stay separate, and turning a generation into a reusable
// reference stays a deliberate act (download, then upload here), the same rule
// 0083's `generated_image` note already sets for conditioning frames.

export default async function ElementsLibraryPage(): Promise<JSX.Element> {
  const { user, profile } = await requireUser();

  const supabase = await createClient();
  const initialPage = await loadElementLibraryPage(supabase, user.id, {
    query: "",
    filter: "all",
    cursor: null,
  });

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Elements Library</h1>
        <p className="text-sm text-muted-foreground">
          View, download, or save a copy of shared references to your elements. Type{" "}
          <span className="font-medium">@name</span> in a prompt to use one of{" "}
          <span className="font-medium">yours</span> — in a clip, or in the Image Generator.
        </p>
      </div>

      <ElementsLibrary
        key={initialPage.elements.map((element) => `${element.id}:${element.name}`).join("|")}
        initialPage={initialPage}
        viewerId={user.id}
        viewerIsAdmin={isAdmin(profile)}
      />
    </main>
  );
}
