import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Stop `next dev` from regenerating web/AGENTS.md and web/CLAUDE.md on
  // every run — both are gitignored, dev-only scaffolding with no project
  // value here.
  agentRules: false,
  // Nothing in this app imports `next/image` — media is shown from Supabase
  // signed URLs, which the optimizer cannot cache anyway (they expire). With
  // the optimizer on, Next's dependency trace pulls `sharp` and ~36MB of
  // libvips binaries into the standalone output. The bloat isn't a
  // glibc/musl mismatch — it's that `bun install` ignores npm's `libc`
  // field (which is how npm normally skips platform-mismatched optional
  // binaries) and installs every `@img/sharp-*` platform variant it finds,
  // this Alpine/musl runtime's included, regardless of which one the build
  // actually runs on. web/Dockerfile prunes the non-musl variants; sharp
  // itself stays in the image because lib/to-jpeg.ts uses it for uploads.
  //
  // If someone later adds a `next/image`, delete this line — leaving it on
  // silently ships unoptimized images.
  images: { unoptimized: true },
  turbopack: {
    // The repo root (husky/lint-staged deps) also has a bun.lock, so
    // Turbopack's lockfile-based root inference picks the wrong directory
    // and warns on every `next dev`/`next build`. Pin it explicitly.
    root: path.join(__dirname),
  },
  experimental: {
    serverActions: {
      // Next's default Server Action body limit is 1MB. uploadCharacterRef
      // and uploadProductRef (actions/character.ts) post a raw phone photo
      // through a Server Action, and a normal phone photo clears 1MB on its
      // own — Next was rejecting the request with a 413 before our code
      // ever ran, which surfaced to the operator as a redacted, meaningless
      // React error #441. This must stay strictly ABOVE every reference-file
      // ceiling in lib/file-type.ts, not equal to any of them: the body Next
      // measures here is the file PLUS the rest of the multipart envelope,
      // so a file sized exactly at one of those limits is guaranteed to
      // overflow this one — the same 413-before-our-code-runs failure this
      // value exists to prevent, just moved to exactly the size operators
      // are told is allowed.
      //
      // 18MB, lowered from 28MB when MAX_REFERENCE_VIDEO_BYTES came down to
      // 15MB (lib/kie-video-describe.ts's invention-band guard — see that
      // constant's comment in lib/file-type.ts). The largest file this app
      // will now accept, video or audio, is 15MB, and 18MB clears that with
      // real headroom for the rest of the multipart envelope — the same
      // margin 28MB gave a 25MB video, not a tighter squeeze.
      //
      // This also still carries the fix for the bug that was here before
      // video existed: MAX_REFERENCE_AUDIO_BYTES is 15MB, which EXCEEDED the
      // original 12MB envelope, so a 12-15MB voice clip passed the
      // client-side and registerElement size checks and was then killed by
      // Next with a redacted 413 before registerElement's own check ever
      // ran — the exact #441 failure this comment describes. 18MB, same as
      // 28MB before it, puts the 15MB audio ceiling properly beneath this
      // one.
      //
      // Every byte of an in-flight upload sits in the Node process's memory
      // for the duration of the request, and ugc-web runs on Render's
      // starter plan (512MB) — which is exactly why 18MB is the better
      // number now that 15MB is the largest file either cap needs to admit,
      // not 28MB left alone as unused headroom. Argue with THIS number first
      // if the instance starts OOMing, not the reference-file ceilings it
      // was sized to clear.
      bodySizeLimit: "18mb",
    },
  },
};

export default nextConfig;
