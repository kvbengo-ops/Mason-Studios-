// Display order of scenes on the project studio strip (0142), plus the
// limits its name and comment fields share with their actions.
//
// scenes.position is null until a scene is dragged; idx is never renumbered.
// So the order key is `position ?? idx`, with idx breaking ties.
//
// Not lib/scene-order.ts: that one REPACKS idx for the scripted pipeline.

export const MAX_SCENE_TITLE_CHARS = 80;
export const MAX_SCENE_COMMENT_CHARS = 2000;

export interface OrderedScene {
  id: string;
  idx: number;
  position: number | null;
}

export function compareSceneOrder(
  a: { idx: number; position?: number | null },
  b: { idx: number; position?: number | null },
): number {
  return (a.position ?? a.idx) - (b.position ?? b.idx) || a.idx - b.idx;
}

/**
 * The positions to write so `scenes` reads in `orderedIds` order.
 *
 * Reuses the scenes' OWN current keys, sorted, rather than writing 1..n: the
 * strip only lists the newest scenes, and a scene it does not list keeps its
 * key — so the dragged set stays where it was relative to everything else.
 * Keys are made strictly increasing, since two equal positions would fall
 * back to idx and undo the drag.
 *
 * Returns null when `orderedIds` is not exactly the given scenes.
 */
export function reassignPositions(
  scenes: readonly OrderedScene[],
  orderedIds: readonly string[],
): { id: string; position: number }[] | null {
  const known = new Set(scenes.map((scene) => scene.id));
  if (
    orderedIds.length !== scenes.length ||
    new Set(orderedIds).size !== orderedIds.length ||
    orderedIds.some((id) => !known.has(id))
  ) {
    return null;
  }
  const keys = [...scenes].sort(compareSceneOrder).map((scene) => scene.position ?? scene.idx);
  for (let i = 1; i < keys.length; i++) {
    if (keys[i]! <= keys[i - 1]!) keys[i] = keys[i - 1]! + 1;
  }
  return orderedIds.map((id, i) => ({ id, position: keys[i]! }));
}
