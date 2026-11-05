import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      // `server-only` (lib/claude.ts) unconditionally throws when resolved
      // through its package.json "default" export condition — that's the
      // whole point, it's what turns an accidental client-bundle import into
      // a build error (see webpack-config.js's server-only/client-only
      // aliasing). Next's own bundler and `next/jest` both route around this
      // by resolving the "react-server" condition instead, which points at
      // an empty no-op module. Vitest has no such condition set, so without
      // this alias every test that imports lib/claude.ts — even
      // server-side, legitimate ones — would trip the same throw. Point
      // straight at the package's own no-op variant rather than
      // maintaining a duplicate stub file here.
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    environment: "node",
  },
});
