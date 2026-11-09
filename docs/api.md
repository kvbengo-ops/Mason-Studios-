# Mason Studios API (`/api/v1`)

Base URL: `https://app.vbgstudio.site/api/v1`. JSON in and out, except element uploads (multipart).

## Auth

Every request: `Authorization: Bearer ms_live_…` — a personal API token from **Profile → Manage API tokens**.

- Only **trusted editors and admins** can create or use tokens (`403 role_not_allowed` otherwise).
- Each token has scopes: `read`, `upload`, `generate`. The scope is checked first, before any parsing, upload or spend.
- Spend counts against the token owner's normal USD caps, plus the token's own optional monthly cap.

## Rate limits

Per account, per minute: **60 writes** (`upload`, `generate`) and **120 reads**. Over the limit: `429 rate_limited` with a `Retry-After` header (seconds). Counters live in server memory and reset on each deploy.

## Routes

| Method | Path | Scope | What it does |
|---|---|---|---|
| GET | `/elements` | read | List your elements: `id, name, category, asset_kind, duration_s, created_at` |
| POST | `/elements` | upload | Upload an element (multipart, below) |
| POST | `/elements/upload-url` | upload | Get a signed URL for a large file (staged upload) |
| POST | `/quote` | read | Price a clip and show the prompt the provider will get — spends nothing |
| POST | `/generate` | generate | Start a clip; returns `job_id` |
| GET | `/jobs/{job_id}` | read | Status, costs and, when done, `download_url` |
| POST | `/images` | generate | Generate an image |
| GET | `/images/{id}` | read | Image status and download |

MCP (Claude connectors): `https://app.vbgstudio.site/api/mcp?token=ms_live_…` exposes the same calls as tools.

## Elements

`POST /elements`, multipart fields:

| Field | Required | Notes |
|---|---|---|
| `file` | one of `file` / `staged_key` | JPG, PNG, WebP, MP3, WAV or MP4, detected from the bytes |
| `name` | yes | 1–64 characters; becomes the `@tag` |
| `category` | no | `image`, `character`, `product`, `location` for images; audio and video are set automatically |
| `description` | no | Up to 2,000 characters. Substituted for the `@tag` in Kie prompts |
| `staged_key`, `filename`, `content_type` | with staged upload | From `/elements/upload-url` |

Limits: images **10 MB**, audio and video **15 MB**. A direct upload over 16 MB is refused with `413 file_too_large`. Voice clips must be **2–30 seconds** (`422 invalid_audio_duration`). If the length can't be read, the clip is accepted and the provider decides.

PNG and WebP images are stored, and sent to the provider, as JPEG at quality 90.

Staged upload: `POST /elements/upload-url` → `PUT` the file to `upload_url` → `POST /elements` with `staged_key`, `filename`, `content_type`, `name`.

## Clips

`POST /quote` and `POST /generate` take the same JSON body. Unknown fields are refused (`400 unknown_field`).

| Field | Required | Notes |
|---|---|---|
| `prompt` | yes | 1–5,000 characters; some models are lower (table below). Refer to elements by `@tag` |
| `model_id` | yes | Table below |
| `resolution` | yes | Any case (`480p` = `480P`) |
| `duration_s` | yes | Integer, from the model's list |
| `is_talking_head` | no | Boolean. Turns sound on for Kling |
| `image_refs`, `video_refs`, `audio_refs` | no | Element ids, in `@Image 1…`, `@Video 1…`, `@Audio 1…` order |

At most **10 references** per clip, all kinds together. Kling 4.0 Reference takes 1–2 images only (start and end frame) and no `@tags`.

`/generate` also needs an `Idempotency-Key` header (1–128 characters). The same key with the same body returns the same job (`deduplicated: true`); the same key with a different body returns `409 idempotency_conflict`. Keys don't expire. The one exception: a job stuck preparing for more than 5 minutes is cleared, which frees its key.

### Models

| `model_id` | Name | Resolutions | `duration_s` | Prompt limit |
|---|---|---|---|---|
| `seedance-2.5` | Seedance 2.5 (Kie) | 480p, 720p, 1080p | 4–30 | 5,000 |
| `seedance-2.5-byteplus` | Seedance 2.5 · BytePlus | 480p, 720p, 1080p | 4–30 | 5,000 |
| `kling-4.0` | Kling 4.0 | 720p, 1080p | 3–30 | 5,000 |
| `kling-4.0-reference` | Kling 4.0 Reference | 720p, 1080p | 3–30 | 5,000 |
| `wan-3.0` | Wan 3.0 | 480p, 720p, 1080p | 4–30 | 5,000 |
| `gemini-omni-video` | Gemini Omni Video | 720p, 1080p, 4k | 4, 6, 8, 10 | 5,000 |

A refused resolution or duration gets `422`, and the error lists what the model accepts. `/quote` is the final word on whether a combination can be sold right now (`422 unavailable_rate` if not).

## Jobs

`GET /jobs/{job_id}` returns `status` — `preparing`, `queued`, `rendering`, `done` or `failed` — plus:

- `estimated_cost_usd`: the hold taken when it was queued
- `latest_attempt_cost_usd`, `total_cost_usd`: what was actually recorded
- when `done`: `download_url` and `url_expires_in_s`. The link works for **1 hour**; call again for a fresh one

Poll about every 10 seconds.

## Pricing

- **Quote:** the model's published rate × `duration_s`. A video reference adds its own seconds (`video_reference_seconds`), because the provider bills input plus output. `price_unpaid: true` means the rate is the published price and hasn't yet been confirmed by a real charge.
- **Actual charge:** what the provider reports — Kie's credits used, or BytePlus's token count.
- **Failed jobs:** $0 if the provider refused before starting (for example a BytePlus real-person refusal). If Kie accepted the job and it failed later, the charge is what Kie reports, or the estimate if Kie reports nothing. A failed BytePlus job is $0.
- **Caps:** checked when the job is queued, and queued or running jobs count against them. Over a cap: `403` with a reason.

## Errors

Every error is `{ "error": "<message>", "code": "<code>" }` with the HTTP status. Common codes: `missing_token`, `invalid_token`, `token_revoked`, `token_expired`, `account_inactive`, `role_not_allowed`, `insufficient_scope`, `rate_limited`, `unknown_field`, `invalid_parameters`, `unknown_model`, `unsupported_resolution`, `unsupported_duration`, `unavailable_rate`, `too_many_references`, `prompt_too_long`, `file_too_large`, `invalid_media_file`, `invalid_audio_duration`, `invalid_description`, `duplicate_element`, `idempotency_conflict`.
