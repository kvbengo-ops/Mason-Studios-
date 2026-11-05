// Files no longer ride inside Server Action requests: Render's Cloudflare WAF
// answers a Server Action POST with a file-shaped body with a 403 HTML page,
// which the client shows as "An unexpected response was received from the
// server." The browser uploads each file straight to Storage under
// `staging/<user id>/<uuid>` (lib/stage-files.ts) and puts this marker in the
// FormData in the file's place; the action turns it back into a File
// (resolveStagedUploads in lib/storage.ts) before its usual validation runs.
export const STAGED_UPLOAD_PREFIX = "__staged_upload__:";

export interface StagedUpload {
  key: string;
  filename: string;
  type: string;
}
