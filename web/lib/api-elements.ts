import "server-only";

import { elementUploadNameError } from "@/lib/element-upload-name";
import { parseAudioDurationSeconds } from "@/lib/audio-duration";
import {
  isAcceptedReferenceAudioDuration,
  MAX_REFERENCE_AUDIO_BYTES,
  MAX_REFERENCE_AUDIO_SECONDS,
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_VIDEO_BYTES,
  MIN_REFERENCE_AUDIO_SECONDS,
} from "@/lib/file-type";
import { parseMp4DurationSeconds } from "@/lib/mp4-duration";
import { downloadStagedUpload, removeStorageObjects, uploadFile } from "@/lib/storage";
import { createAdminClient } from "@/lib/supabase/server";
import type { AssetKind, ElementCategory } from "@/types/db";

type ApiElementUploadResult =
  | { ok: false; status: 400 | 403 | 404 | 409 | 413 | 422; code: string; error: string }
  | {
      ok: true;
      element: {
        id: string;
        name: string;
        category: ElementCategory;
        asset_kind: AssetKind;
        duration_s: number | null;
        created_at: string;
      };
    };

type DetectedReference = {
  kind: "image" | "audio" | "video";
  assetKind: AssetKind;
  extension: string;
  contentType: string;
  maxBytes: number;
};

// The app sets no cap; this is the API's trust-boundary sanity limit. It is substituted
// into Kie prompts, whose own per-model limits still apply at quote/generate time.
const MAX_DESCRIPTION_CHARS = 2000;

const ELEMENT_CATEGORIES: readonly ElementCategory[] = [
  "image",
  "audio",
  "video",
  "character",
  "product",
  "location",
  "voice",
];

function ascii(bytes: Uint8Array, offset: number, value: string): boolean {
  return [...value].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
}

function detectReference(bytes: Uint8Array): DetectedReference | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return {
      kind: "image",
      assetKind: "ref_frame",
      extension: "jpg",
      contentType: "image/jpeg",
      maxBytes: MAX_REFERENCE_IMAGE_BYTES,
    };
  }
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)
  ) {
    return {
      kind: "image",
      assetKind: "ref_frame",
      extension: "png",
      contentType: "image/png",
      maxBytes: MAX_REFERENCE_IMAGE_BYTES,
    };
  }
  if (bytes.length >= 12 && ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) {
    return {
      kind: "image",
      assetKind: "ref_frame",
      extension: "webp",
      contentType: "image/webp",
      maxBytes: MAX_REFERENCE_IMAGE_BYTES,
    };
  }
  if (bytes.length >= 12 && ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) {
    return {
      kind: "audio",
      assetKind: "audio",
      extension: "wav",
      contentType: "audio/wav",
      maxBytes: MAX_REFERENCE_AUDIO_BYTES,
    };
  }
  if (
    bytes.length >= 3 &&
    (ascii(bytes, 0, "ID3") || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0))
  ) {
    return {
      kind: "audio",
      assetKind: "audio",
      extension: "mp3",
      contentType: "audio/mpeg",
      maxBytes: MAX_REFERENCE_AUDIO_BYTES,
    };
  }
  if (bytes.length >= 12 && ascii(bytes, 4, "ftyp")) {
    return {
      kind: "video",
      assetKind: "video_ref",
      extension: "mp4",
      contentType: "video/mp4",
      maxBytes: MAX_REFERENCE_VIDEO_BYTES,
    };
  }
  return null;
}

function error(
  status: 400 | 403 | 404 | 409 | 413 | 422,
  code: string,
  message: string,
): ApiElementUploadResult {
  return { ok: false, status, code, error: message };
}

export async function createApiElement(
  userId: string,
  formData: FormData,
): Promise<ApiElementUploadResult> {
  const stagedKeyRaw = formData.get("staged_key");
  const stagedKey = typeof stagedKeyRaw === "string" ? stagedKeyRaw.trim() : "";
  const directFile = formData.get("file") ?? formData.get("image");
  if (stagedKey && directFile instanceof File) {
    return error(400, "invalid_upload", "Send either staged_key or file, not both.");
  }

  let file: File;
  if (stagedKey) {
    const filename = String(formData.get("filename") ?? "").trim();
    const contentType = String(formData.get("content_type") ?? "").trim();
    if (!filename || filename.length > 255) {
      return error(400, "invalid_upload", "A valid filename is required with staged_key.");
    }
    file = await downloadStagedUpload(stagedKey, userId, filename, contentType);
  } else if (directFile instanceof File) {
    file = directFile;
  } else {
    return error(400, "missing_file", "Send a file part or a staged_key.");
  }

  if (file.size === 0) return error(422, "invalid_media_file", "The uploaded file is empty.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const detected = detectReference(bytes);
  if (!detected) {
    return error(
      422,
      "invalid_media_file",
      "File bytes must be a JPG, PNG, WebP, MP3, WAV, or MP4.",
    );
  }
  if (file.size > detected.maxBytes) {
    return error(
      413,
      "file_too_large",
      `The ${detected.kind} reference exceeds its ${Math.floor(detected.maxBytes / (1024 * 1024))} MB limit.`,
    );
  }

  const durationS =
    detected.kind === "video"
      ? parseMp4DurationSeconds(bytes)
      : detected.kind === "audio"
        ? parseAudioDurationSeconds(bytes, detected.extension as "wav" | "mp3")
        : null;
  if (detected.kind === "video" && durationS === null) {
    return error(422, "invalid_media_file", "The MP4 has no supported movie duration.");
  }
  // An unreadable audio length passes through, as in the app; a readable one must fit kie's range.
  if (
    detected.kind === "audio" &&
    durationS !== null &&
    !isAcceptedReferenceAudioDuration(durationS)
  ) {
    return error(
      422,
      "invalid_audio_duration",
      `Voice clips must be ${MIN_REFERENCE_AUDIO_SECONDS}-${MAX_REFERENCE_AUDIO_SECONDS} seconds; this one is ${durationS.toFixed(1)} s.`,
    );
  }

  const name = String(formData.get("name") ?? "").trim();
  if (!name || name.length > 64)
    return error(422, "invalid_element_name", "Element name must be 1-64 characters.");
  const admin = createAdminClient();
  const nameError = await elementUploadNameError(admin, userId, name, false);
  if (nameError) {
    const duplicate = nameError.startsWith("@");
    return error(
      duplicate ? 409 : 422,
      duplicate ? "duplicate_element" : "invalid_element_name",
      nameError,
    );
  }

  // Same reading as the app's updateElement (actions/elements.ts): blank means none.
  const description = String(formData.get("description") ?? "").trim() || null;
  if (description && description.length > MAX_DESCRIPTION_CHARS) {
    return error(
      422,
      "invalid_description",
      `description must be at most ${MAX_DESCRIPTION_CHARS} characters.`,
    );
  }

  const categoryRaw = String(formData.get("category") ?? detected.kind);
  if (!(ELEMENT_CATEGORIES as readonly string[]).includes(categoryRaw)) {
    return error(422, "invalid_category", "category is not supported.");
  }
  const category: ElementCategory =
    detected.kind === "audio"
      ? "audio"
      : detected.kind === "video"
        ? "video"
        : (categoryRaw as ElementCategory);
  const normalizedFile = new File([file], `reference.${detected.extension}`, {
    type: detected.contentType,
  });
  const { storageKey, bytes: storedBytes } = await uploadFile({
    file: normalizedFile,
    userId,
    kind: detected.assetKind,
  });

  const { data: asset, error: assetError } = await admin
    .from("assets")
    .insert({
      project_id: null,
      user_id: userId,
      kind: detected.assetKind,
      storage_key: storageKey,
      bytes: storedBytes ?? file.size,
      duration_s: durationS,
    })
    .select("id")
    .single();
  if (assetError || !asset) {
    await removeStorageObjects([storageKey]).catch(() => undefined);
    throw new Error(`Failed to create API element asset: ${assetError?.message ?? "no row"}`);
  }

  const { data: element, error: elementError } = await admin
    .from("elements")
    .insert({
      user_id: userId,
      name,
      description,
      category,
      asset_id: asset.id,
      is_shared: false,
    })
    .select("id, name, category, created_at")
    .single();
  if (elementError || !element) {
    // Keep the asset row if Storage cleanup fails; it preserves the key for repair.
    await removeStorageObjects([storageKey]);
    const { error: assetCleanupError } = await admin.from("assets").delete().eq("id", asset.id);
    if (assetCleanupError) {
      throw new Error(`Failed to clean API element asset: ${assetCleanupError.message}`);
    }
    if (elementError?.code === "23505") {
      return error(409, "duplicate_element", `@${name} is already used. Choose another tag.`);
    }
    throw new Error(`Failed to create API element: ${elementError?.message ?? "no row"}`);
  }

  return {
    ok: true,
    element: {
      ...element,
      asset_kind: detected.assetKind,
      duration_s: durationS,
    },
  };
}
