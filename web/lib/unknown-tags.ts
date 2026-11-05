import { IMAGE_ASSET_KINDS } from "@/lib/asset-kinds";
import { tagsInOrder } from "@/lib/element-tags";
import { findElementByTag, type ElementTag } from "@/lib/elements";

/**
 * The @tags in a prompt that point at nothing the render can use.
 *
 * Such a tag does not fail: the worker strips the "@" and it goes through as a
 * plain word, so the picture or voice the writer meant is silently missing and
 * the clip is paid for anyway. Both bars ask before spending on one.
 *
 * `imagesOnly` is for the image bar, where a tag that names a saved video or
 * voice is as unusable as one that names nothing.
 */
export function unknownPromptTags(
  prompt: string,
  elements: readonly ElementTag[],
  options: { imagesOnly?: boolean } = {},
): string[] {
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const tag of tagsInOrder(prompt)) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const element = findElementByTag(elements, tag);
    const usable = element && (!options.imagesOnly || IMAGE_ASSET_KINDS.has(element.assetKind));
    if (!usable) unknown.push(tag);
  }
  return unknown;
}

/** What the confirm dialog says. Empty list means no warning. */
export function unknownTagsWarning(tags: readonly string[]): string | null {
  if (tags.length === 0) return null;
  const names = tags.map((tag) => `@${tag}`);
  const list =
    names.length === 1
      ? names[0]!
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list} ${names.length === 1 ? "doesn't" : "don't"} match any saved element, so ${
    names.length === 1 ? "it" : "they"
  } will go through as plain text with no reference. Are you sure you want to render?`;
}
