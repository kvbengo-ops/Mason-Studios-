/**
 * A wall tile's own box: the picture's real shape at the wall's row height
 * (`--row-h`, set on the list). Width is height x ratio and grows a little to
 * fill the row, so every row is the same height and each tile keeps its
 * dimensions. Shared by the image and video walls on /create.
 */
export function tileBox(ratio: number): {
  height: string;
  flexBasis: string;
  flexGrow: number;
} {
  return {
    height: "var(--row-h)",
    flexBasis: `calc(var(--row-h) * ${ratio})`,
    flexGrow: ratio,
  };
}

/** Until a picture or clip has loaded and told us its size. */
export const DEFAULT_TILE_RATIO = 3 / 4;

/**
 * The wall list's classes: justified rows, responsive row height.
 *
 * The trailing ::after (grow 999) soaks up the last row's spare width. Without
 * it a lone tile on the last row grows to fill the whole row, and a portrait
 * clip is cropped into a wide strip instead of keeping its shape.
 */
export const WALL_CLASS =
  "flex w-full flex-wrap gap-1 px-0 [--row-h:11rem] after:grow-[999] after:content-[''] sm:[--row-h:14rem] xl:[--row-h:17rem]";
