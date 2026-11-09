# QA checklist: everything shipped 2026-11-09

This checklist is for an AI tester with the **Mason Studios MCP connector** (tools: `list_elements`, `quote_clip`, `generate_clip`, `generate_image`, `get_job`, `get_image`), plus `curl` and a browser for what MCP can't reach. Run it against production (`https://app.vbgstudio.site`).

## Rules for the tester
- Run the 🆓 tests first. Run a 💲 test only after its 🆓 checks pass. **Always `quote_clip` before `generate_clip`**, and stop if a quote is over $1.
- Never print a token. For curl, read it from `$MASON_TOKEN`.
- Record each test as PASS or FAIL, with the actual response code, the message, and the job/run id.
- Don't retry a failed paid call: report it.

## Preconditions (check before testing)
1. PR #21 is merged and deployed. `GET /api/health` reports `schemaDrift: false` (expected DB version `0130`).
2. Migrations `0129`, `0130` (last seen) and `0131` (Hybrid Editor / AI Animator roles) are applied in prod.
3. Four API tokens are available:

| Token | Account | Scopes |
|---|---|---|
| `T_FULL` | trusted editor or admin | read, upload, generate |
| `T_HYBRID` | Hybrid Editor (token made while the account was a trusted editor) | read, upload, generate |
| `T_READ` | trusted editor | read, upload only |
| `T_EDITOR` | regular editor | created before tokens were limited to trusted editors and admins |

4. Test elements exist on the `T_FULL` account: 9 images, 1 MP4 of 4 s, 3 voice clips of 3–8 s. Upload them in section B if missing.

---

## A. Clip quotes through MCP: 🆓 (quotes never spend)

| # | Call `quote_clip` with | Expect |
|---|---|---|
| A1 | `model_id: seedance-2.5-byteplus`, `resolution: 480p`, `duration_s: 4`, a 20,000-char prompt | 200, a quote |
| A2 | same, with a 20,001-char prompt | `prompt_too_long`, and the message names 20,001 and 20,000 |
| A3 | `model_id: seedance-2.5` (Kie) at `720p` | 200, a quote (Kie Seedance is its own model) |
| A4 | `seedance-2.5-byteplus` at `720p` | `unsupported_resolution` ("480p only") |
| A5 | `wan-3.0` at `480P`, then at `480p` | both 200 (resolution ignores case) |
| A6 | `aspect_ratio: "16:9"` on a model that supports it | 200; then an unsupported ratio → `unsupported_aspect_ratio` |
| A7 | `seedance-2.5-byteplus` with `sound: false` | `unsupported_sound` |
| A8 | `seedance-2.5-byteplus` with 8 image + 1 video + 3 audio refs | 200; the `references` list shows `@image1…8`, `@video1`, `@audio1…3` |
| A9 | the same, with a 9th image | `too_many_references`, mentioning "8 image" |
| A10 | `kling-4.0` with 3 images | refused (Kling takes 1–2 images) |
| A11 | inspect any quote response | **no** `note` field |
| A12 | `seedance-2.5-byteplus` 26 s, without and then with a 4 s video ref | the quote with the ref is lower (BytePlus's video-input rate is $6.40/M vs $10.70/M); `video_reference_seconds: 4` |
| A13 | any call using `T_HYBRID`'s connector | `403 role_not_allowed` (only trusted editors and admins hold tokens) |

## B. REST routes MCP doesn't expose: 🆓 (curl)

`H="Authorization: Bearer $MASON_TOKEN"`, base `https://app.vbgstudio.site/api/v1`.

| # | Request | Expect |
|---|---|---|
| B1 | `GET /allowance` | 200 with `daily_remaining_usd` and `weekly_remaining_usd` |
| B2 | `POST /generate` using `T_READ` | `403 insufficient_scope`, even with an invalid body |
| B3 | any route using `T_EDITOR` | `403 role_not_allowed` |
| B4 | `POST /elements` with a PNG and `description=hello` | 201; `GET /elements/{id}` shows `description: "hello"` |
| B5 | download B4's `download_url` and compare its SHA-256 with the uploaded PNG | **identical** (PNG kept as uploaded) |
| B6 | `POST /elements` with a WebP | 201; the stored file is a JPEG |
| B7 | `POST /elements` with a 1 s WAV, then a 31 s WAV | both `422 invalid_audio_duration` |
| B8 | `POST /elements` with a 17 MB file | `413 file_too_large` (not "must be multipart") |
| B9 | `POST /elements/upload-url` → PUT a 12 MB MP4 → `POST /elements` with `staged_key` | 201 |
| B10 | `PATCH /elements/{id}` to rename it, then `DELETE` it | 200, then 200; `GET` afterwards → 404 |
| B11 | `POST /elements` with `shared=true` | the element appears under **All** in the app |
| B12 | `POST /generate` with no `Idempotency-Key` | 400 `invalid_idempotency_key` |

## C. Paid end-to-end through MCP: 💲 (about $1.50 total; quote first)

| # | Steps | Expect |
|---|---|---|
| C1 | `generate_image`: `model: seedream-5.0-pro`, a photoreal face, prompt only | completes. In the app's Runs, vendor is **byteplus**, model `byteplus/seedream-5.0-pro`, $0.045 |
| C2 | `generate_image`: Seedream with an `@tag` of C1's image | completes, vendor **byteplus** (never kie) |
| C3 | `quote_clip`, then `generate_clip`: `seedance-2.5-byteplus`, 480p, 4 s, C1's face as `image_refs` | the job finishes; there's no `PrivacyInformation` refusal; `get_job` gives a `download_url` |
| C4 | in the app, open C3's scene | the scene settings show 480p, quality High |
| C5 | `get_job` on C3 an hour later | a fresh `download_url` that works (the old link expired after 1 h) |
| C6 | `generate_clip` with the same `Idempotency-Key` and body as C3 | the same `job_id`, `deduplicated: true`, **no** second charge |

## D. Website checks through the browser: 🆓 (no generating)

| # | Where | Expect |
|---|---|---|
| D1 | `/ugc` model picker | both "Seedance 2.5 · Kie" (480p/720p/1080p) and Seedance 2.5 BytePlus (480p only) |
| D2 | `/ugc` with BytePlus selected | the Quality menu shows Standard / High / Max, default High; Max is saved on the scene |
| D3 | `/ugc` Length button | the "Total duration" slider. It closes on release, Esc, and a click outside |
| D4 | `/ugc` prompt box | an "n / 20,000" counter that turns red past the limit |
| D5 | Image Generator | no Nano Banana 2; only the 9:16, 1:1 and 16:9 ratios |
| D6 | Accounts Control | a Role select (Editor / Trusted editor / Hybrid Editor / AI Animator); a green dot for your own account; red for an account idle more than 2 min |
| D7 | `/ugc` as a Hybrid Editor | Wan 3.0 is not in the picker |
| D8 | `/settings/api-tokens` as a regular editor | "available to trusted editors and admins only" |
| D9 | `/settings/api-tokens`: create a token | the token and a copyable `…/api/mcp?token=…` link with 3 setup steps |
| D10 | an old failed BytePlus "real person" scene | the message says to use a different reference or make the face with Seedream 5.0 Pro; it never mentions Kie; **no** Retry |

## E. Known gaps (expected to fail or need attention)
- The `/ugc` References box still caps at a flat 10, not 8 + 1 + 3.
- Neither BytePlus nor kie publishes a prompt limit, so a 20,000-char prompt may still be refused by the vendor (that refusal costs nothing).
- Retry and rerender in `enqueue.ts` don't check the role's model access.
- The scripted pipeline still defaults to Seedance 2.5 on Kie.

## Report format
One line per test: `A1 PASS 200` or `B7 FAIL 201 (expected 422)`. Then list the job and run ids from section C, and the total spent.
