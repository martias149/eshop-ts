import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.resolve(__dirname, "migrations"));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: path.resolve(__dirname, "wrangler.jsonc") },
        // wrangler.jsonc's compatibility_date tracks "today" for deploys, but the
        // workerd binary pinned by this repo's installed wrangler version lags behind
        // it locally; override just for the test runner so `vitest run` isn't blocked
        // on bumping wrangler. Does not affect `wrangler deploy`/`wrangler dev`.
        miniflare: {
          compatibilityDate: "2026-07-09",
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      include: ["tests/**/*.test.ts"],
    },
  };
});
