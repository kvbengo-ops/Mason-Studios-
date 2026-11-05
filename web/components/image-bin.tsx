import type { JSX } from "react";
import { restorePersonalImage, purgePersonalImage } from "@/actions/image-bin";
import { createClient } from "@/lib/supabase/server";
import { signedUrl } from "@/lib/storage";
import { dateTimeFormatter } from "@/lib/datetime";
import { BinCard, type BinCardThumbnail } from "@/components/bin-card";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";

export async function ImageBin({ userId }: { userId: string }): Promise<JSX.Element> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("assets")
    .select("id, storage_key, deleted_at")
    .eq("user_id", userId).is("project_id", null).eq("kind", "generated_image")
    .not("deleted_at", "is", null).order("deleted_at", { ascending: false });
  if (error) throw new Error("Could not load images in Bin.");
  const images = await Promise.all((data ?? []).map(async (row) => {
    let thumbnail: BinCardThumbnail = { kind: "placeholder" };
    try {
      thumbnail = { kind: "image", url: await signedUrl(row.storage_key, 3600, { width: 320, quality: 80 }) };
    } catch (error) {
      console.error("Could not load Bin image thumbnail", error);
    }
    return { ...row, thumbnail };
  }));
  return (
    <section className="flex flex-col gap-3" aria-labelledby="bin-images-heading">
      <h2 id="bin-images-heading" className="text-lg font-semibold">Generated images</h2>
      {images.length === 0 ? <p className="text-sm text-muted-foreground">No generated images in Bin.</p> : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {images.map((image) => (
            <BinCard key={image.id} itemLabel="Generated image" badge="Image"
              promptFirstLine="Generated image" thumbnail={image.thumbnail}
              deletedAtLabel={dateTimeFormatter.format(new Date(image.deleted_at!))}
              actions={<>
                <ActionForm action={restorePersonalImage}>
                  <input type="hidden" name="assetId" value={image.id} />
                  <SubmitButton pendingLabel="Restoring" variant="outline" size="sm">Restore</SubmitButton>
                </ActionForm>
                <ActionForm action={purgePersonalImage}>
                  <input type="hidden" name="assetId" value={image.id} />
                  <ConfirmSubmitButton confirmMessage="Permanently delete this generated image? This cannot be undone."
                    pendingLabel="Deleting" variant="destructive" size="sm">Delete permanently</ConfirmSubmitButton>
                </ActionForm>
              </>} />
          ))}
        </div>
      )}
    </section>
  );
}
