import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Two projects, because they need different runtimes:
//
//   worker — the app itself, inside real workerd (D1, bindings, fetch).
//   node   — the seams around it: wrangler config resolution, the seed script,
//            and the frontend's read of the API. These need child_process /
//            fs / jsdom, none of which exist inside workerd.
//
// The worker project deliberately does NOT pin compatibilityDate. It inherits
// whatever wrangler.jsonc deploys with, so setting a date the pinned toolchain
// can't run fails the suite instead of only failing `wrangler dev` at runtime.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.resolve(__dirname, "migrations"));

  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: path.resolve(__dirname, "wrangler.jsonc") },
              miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
            }),
          ],
          test: {
            name: "worker",
            include: ["tests/*.test.ts"],
          },
        },
        {
          test: {
            name: "node",
            environment: "node",
            include: ["tests/node/*.test.ts"],
            testTimeout: 60_000, // shells out to wrangler
          },
        },
      ],
    },
  };
});
