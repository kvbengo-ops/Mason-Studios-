import { sanitizeArchiveTitle, type ArchiveEntry } from "@/lib/archive";

export interface ProjectAssetInput {
  id: string;
  kind: string;
  storageKey: string;
}

export function buildProjectAssetEntries(assets: readonly ProjectAssetInput[]): ArchiveEntry[] {
  return [...assets]
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
    .map((asset) => {
      const basename = asset.storageKey.replaceAll("\\", "/").split("/").pop() || "file";
      const filename = sanitizeArchiveTitle(basename);
      const kind = sanitizeArchiveTitle(asset.kind);
      return {
        name: `assets/${kind}/${asset.id}-${filename}`,
        storageKey: asset.storageKey,
      };
    });
}
