import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

// Strip // comments so the jsonc parses. Naive, but wrangler.jsonc has no
// string literal containing "//" — the assertion below would break loudly if
// one ever appeared.
function readWranglerConfig() {
  const raw = readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8");
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as {
    name: string;
    vars: Record<string, unknown>;
    d1_databases: { binding: string; database_id: string; database_name: string }[];
    env?: Record<
      string,
      {
        name: string;
        vars?: Record<string, unknown>;
        d1_databases?: { binding: string; database_id: string; database_name: string }[];
      }
    >;
  };
}

// `wrangler deploy --dry-run` resolves the config with wrangler's own rules and
// prints the bindings it would ship. It needs no credentials and no network, so
// it runs in CI on a fork's PR.
//
// Asserting on this output rather than re-deriving inheritance in the test is
// the point: the previous CI plan confidently documented that `assets` is not
// inherited by environments, and it was wrong. A test that encodes my model of
// wrangler validates my model, not wrangler.
function resolvedBindings(env?: string): string {
  const args = ["wrangler", "deploy", "--dry-run", ...(env ? ["--env", env] : [])];
  return execFileSync("npx", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const config = readWranglerConfig();
const envNames = Object.keys(config.env ?? {});

describe("wrangler environments", () => {
  it("has at least one non-production environment", () => {
    expect(envNames).toContain("dev");
  });

  // The catastrophic one. If dev ever points at prod's database_id, then
  // `d1 migrations apply --env dev` and every dev write land on live orders.
  it("no two environments share a database_id", () => {
    const ids = [
      { env: "production", id: config.d1_databases[0].database_id },
      ...envNames.map((e) => ({ env: e, id: config.env![e].d1_databases?.[0]?.database_id })),
    ];

    for (const entry of ids) {
      expect(entry.id, `${entry.env} has no database_id`).toBeTruthy();
      expect(entry.id, `${entry.env} still has the placeholder id`).not.toMatch(/REPLACE_WITH/i);
    }

    expect(new Set(ids.map((e) => e.id)).size, `database_ids collide: ${JSON.stringify(ids)}`).toBe(ids.length);
  });

  it("no two environments share a worker name", () => {
    const names = [config.name, ...envNames.map((e) => config.env![e].name)];
    expect(new Set(names).size).toBe(names.length);
  });

  // vars are NOT inherited — wrangler warns about this but still deploys, so a
  // missing var is a silently-undefined binding at runtime, not a failed deploy.
  it.each(envNames)("env.%s repeats every top-level var", (envName) => {
    const envVars = config.env![envName].vars ?? {};
    for (const key of Object.keys(config.vars)) {
      expect(Object.keys(envVars), `env.${envName} is missing var ${key}`).toContain(key);
    }
  });

  it("production resolves DB + ASSETS", () => {
    const out = resolvedBindings();
    expect(out).toMatch(/env\.DB \(eshop-db\)/);
    expect(out).toMatch(/env\.ASSETS/);
    expect(out).toMatch(/env\.STRIPE_CURRENCY/);
    expect(out).toMatch(/env\.PASSWORD_HASH_ITERATIONS/);
  });

  it.each(envNames)("env.%s resolves its own DB, plus ASSETS and every var", (envName) => {
    const expected = config.env![envName].d1_databases![0].database_name;
    const out = resolvedBindings(envName);

    expect(out).toMatch(new RegExp(`env\\.DB \\(${expected}\\)`));
    expect(out).toMatch(/env\.ASSETS/);
    expect(out).toMatch(/env\.STRIPE_CURRENCY/);
    expect(out).toMatch(/env\.PASSWORD_HASH_ITERATIONS/);

    // and emphatically not production's database
    expect(out).not.toMatch(new RegExp(`env\\.DB \\(${config.d1_databases[0].database_name}\\)`));
  });
});
