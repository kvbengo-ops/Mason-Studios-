# Mason Studios API (`/api/v1`)

Base URL: `https://app.vbgstudio.site/api/v1`. JSON in and out, except element uploads (multipart).

## Auth

Every request: `Authorization: Bearer ms_live_…` — a personal API token from **Profile → Manage API tokens**.

- Only **trusted editors and admins** can create or use tokens (`403 role_not_allowed` otherwise).
- Hybrid Editor and AI Animator accounts cannot hold tokens (`role_not_allowed`). As a second line, `/quote` and `/generate` refuse any model the account's role may not use (`403 model_not_allowed`, e.g. `wan-3.0` for a Hybrid Editor) before any spend.
- Each token has scopes: `read`, `upload`, `generate`. The scope is checked first, before any parsing, upload or spend.
- Spend counts against the token owner's normal USD caps, plus the token's own optional monthly cap.

## Rate limits

Per account, per minute: **60 writes** (`upload`, `generate`) and **120 reads**. Over the limit: `429 rate_limited` with a `Retry-After` header (seconds). Counters live in server memory and reset on each deploy.

## Routes

| Method | Path                   | Scope    | What it does                                                                 |
| ------ | ---------------------- | -------- | ---------------------------------------------------------------------------- |
| GET    | `/elements`            | read     | List your elements: `id, name, category, asset_kind, duration_s, created_at` |
| POST   | `/elements`            | upload   | Upload an element (multipart, below)                                         |
| GET    | `/elements/{id}`       | read     | Your element metadata and a 1-hour `download_url`                            |
| PATCH  | `/elements/{id}`       | upload   | Update your element's name, description or category                          |
| DELETE | `/elements/{id}`       | upload   | Soft-delete your element                                                     |
| POST   | `/elements/upload-url` | upload   | Get a signed URL for a large file (staged upload)                            |
| GET    | `/allowance`           | read     | Remaining daily and weekly USD allowance                                     |
| POST   | `/quote`               | read     | Price a clip and show the prompt the provider will get — spends nothing      |
| POST   | `/generate`            | generate | Start a clip; returns `job_id`                                               |
| GET    | `/jobs/{job_id}`       | read     | Status, costs and, when done, `download_url`                                 |
| POST   | `/images`              | generate | Generate an image                                                            |
| GET    | `/images/{id}`         | read     | Image status and download                                                    |

MCP (Claude connectors): `https://app.vbgstudio.site/api/mcp?token=ms_live_…` exposes the same calls as tools.

## Elements

`POST /elements`, multipart fields:

| Field                                    | Required                     | Notes                                                                                                                                            |
| ---------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `file`                                   | one of `file` / `staged_key` | JPG, PNG, WebP, MP3, WAV or MP4, detected from the bytes                                                                                         |
| `name`                                   | yes                          | 1–64 characters; becomes the `@tag`                                                                                                              |
| `category`                               | no                           | `image`, `character`, `product`, `location` for images; audio and video are set automatically                                                    |
| `description`                            | no                           | Up to 2,000 characters. Substituted for the `@tag` in Kie prompts                                                                                |
| `shared`                                 | no                           | `true` publishes the element to the shared library; default `false`. Shared names must be unique across the shared library and your own elements |
| `staged_key`, `filename`, `content_type` | with staged upload           | From `/elements/upload-url`                                                                                                                      |

Limits: images **10 MB**, audio and video **15 MB**. A direct upload over 16 MB is refused with `413 file_too_large`. Voice clips must be **2–30 seconds** (`422 invalid_audio_duration`). If the length can't be read, the clip is accepted and the provider decides.

PNG and JPG images are kept byte-for-byte; WebP is converted to JPEG for providers that reject WebP.

Staged upload: `POST /elements/upload-url` → `PUT` the file to `upload_url` → `POST /elements` with `staged_key`, `filename`, `content_type`, `name`.

`PATCH /elements/{id}` takes a JSON object with any of `name` (1–64 tag characters), `description` (string or null, at most 2,000 characters), and `category`. A rename follows the tag through your existing scene prompts. `DELETE` removes the tag from the library without deleting clips or their copied assets. Both routes require the `upload` scope and act only on elements owned by the token's account.

## Clips

`POST /quote` and `POST /generate` take the same JSON body. Unknown fields are refused (`400 unknown_field`).

| Field                                    | Required | Notes                                                                                                                         |
| ---------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `prompt`                                 | yes      | 1–20,000 characters; a lower model limit still applies after reference descriptions are expanded. Refer to elements by `@tag` |
| `model_id`                               | yes      | Table below                                                                                                                   |
| `resolution`                             | yes      | Any case (`480p` = `480P`)                                                                                                    |
| `duration_s`                             | yes      | Integer, from the model's list                                                                                                |
| `aspect_ratio`                           | no       | Defaults to `9:16`; must be offered by the model                                                                              |
| `sound`                                  | no       | Boolean, defaults to `true`. Controls native-audio Kling sound. Models with fixed sound, including Seedance, refuse `false`   |
| `is_talking_head`                        | no       | Legacy alias for `sound`; if both are sent they must agree                                                                    |
| `image_refs`, `video_refs`, `audio_refs` | no       | Element ids, in `@Image 1…`, `@Video 1…`, `@Audio 1…` order                                                                   |

Seedance 2.5, on both Kie and BytePlus, accepts up to **12 images, 1 video and 3 audio clips**, 12 total in any mix. Video references must each be at most 30 seconds and total at most 30 seconds; audio has the same time limits. The same 12 apply in the `/ugc` References box (10 on every other model). The 20,000-character prompt cap applies to the text actually sent, so `@tag` descriptions count toward it; a prompt that only exceeds it after expansion gets `422 prompt_too_long`. Kling takes 1–2 PNG/JPG images only and no `@tags`. Wan 3.0 takes up to 10 images, 5 videos and 5 audio clips (10 total), each clip at most 15 seconds and 15 seconds combined per type. Other models accept at most 10 references total, subject to their own media rules. Per-type or total overflow returns `422 too_many_references` with the offending limit.

`/generate` also needs an `Idempotency-Key` header (1–128 characters). The same key with the same body returns the same job (`deduplicated: true`); the same key with a different body returns `409 idempotency_conflict`. Committed keys never expire. A job stuck preparing for more than 5 minutes is cleared, freeing its key.

### Models

| `model_id`              | Name                    | Resolutions           | `duration_s` | Prompt limit                            |
| ----------------------- | ----------------------- | --------------------- | ------------ | --------------------------------------- |
| `seedance-2.5`          | Seedance 2.5 · Kie      | 480p, 720p, 1080p     | 4–30         | 20,000 site cap; vendor cap unpublished |
| `seedance-2.5-byteplus` | Seedance 2.5 · BytePlus | 480p only             | 4–30         | 20,000 site cap; vendor cap unpublished |
| `kling-4.0`             | Kling 4.0               | 720p, 1080p           | 3–30         | 8,000                                   |
| `kling-4.0-reference`   | Kling 4.0 Reference     | 720p, 1080p           | 3–30         | 8,000                                   |
| `wan-3.0`               | Wan 3.0                 | 480p, 720p, 1080p     | 4–30         | Vendor cap unpublished                  |
| `gemini-omni-video`     | Gemini Omni Video       | 720p, 1080p, 4k       | 4, 6, 8, 10  | Vendor cap unpublished                  |
| `gemini-omni-1.2`       | Gemini Omni 1.2 Flash   | 360p, 720p, 1080p, 4k | 3–15         | 20,000                                  |

A refused resolution or duration gets `422`, and the error lists what the model accepts. `/quote` is the final word on whether a combination can be sold right now (`422 unavailable_rate` if not).

`seedance-2.5` (Kie) and `seedance-2.5-byteplus` are separate models: you pick one, and neither stands in for the other. Use BytePlus for faces made with Seedream 5.0 Pro. BytePlus dispatch is limited by `BYTEPLUS_MAX_INFLIGHT` (default 3), and does not fall back to Kie.

Image model IDs for `POST /images`: `nano-banana-2-1` (default), `seedream-5.0-pro`, `gpt-image-2.6-sunburst` (1K only), and `gpt-image-2.6-economy` (1K only).

`GET /allowance` reports `daily_remaining_usd`, `weekly_remaining_usd`, the corresponding caps, and whether the per-user daily cap is enabled. These are current headroom under spend ceilings, not a stored balance.

## Jobs

`GET /jobs/{job_id}` returns `status` — `preparing`, `queued`, `rendering`, `done` or `failed` — plus:

- `estimated_cost_usd`: the hold taken when it was queued
- `latest_attempt_cost_usd`, `total_cost_usd`: what was actually recorded
- when `done`: `download_url` and `url_expires_in_s`. The link works for **1 hour**; call again for a fresh one

Poll about every 10 seconds.

Active element and generated asset files have no automatic expiry in Mason Storage. A soft-deleted element keeps its file so existing references remain safe. Deleted scenes, clip versions and images appear in Bin for 3 days; the worker removes expired Bin entries and their unreferenced files hourly. Download links expire after one hour; request a fresh URL when needed.

## Pricing

- **Quote:** the model's published rate × estimated video tokens. BytePlus uses $10.70/M tokens without video input and $6.40/M with video input at 480p; it counts input and output video seconds. Therefore a 26-second clip with a 4-second video reference can quote about $1.845 instead of $2.673. `price_unpaid: true` means the rate is published but has no receipt yet. Quote responses omit internal billing notes.
- **Actual charge:** what the provider reports — Kie's credits used, or BytePlus's token count.
- **Failed jobs:** Refused or moderated jobs cost $0. If Kie accepted a job and it failed later, the charge is what Kie reports, or the estimate if Kie reports nothing. A failed BytePlus job costs $0.
- **Caps:** checked when the job is queued, and queued or running jobs count against them. Over a cap: `403` with a reason.

## Errors

Every error is `{ "error": "<message>", "code": "<code>" }` with the HTTP status. Common codes: `missing_token`, `invalid_token`, `token_revoked`, `token_expired`, `account_inactive`, `role_not_allowed`, `model_not_allowed`, `insufficient_scope`, `rate_limited`, `unknown_field`, `invalid_parameters`, `unknown_model`, `unsupported_resolution`, `unsupported_aspect_ratio`, `unsupported_sound`, `unsupported_duration`, `unavailable_rate`, `too_many_references`, `prompt_too_long`, `file_too_large`, `invalid_media_file`, `invalid_audio_duration`, `invalid_description`, `duplicate_element`, `idempotency_conflict`. A read+upload token gets `403 insufficient_scope` on `/generate` and `/images` before their bodies are parsed. `/quote` needs only `read` and may return validation errors for that token.
