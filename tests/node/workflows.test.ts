import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOWS = path.resolve(__dirname, "../../.github/workflows");
const read = (f: string) => readFileSync(path.join(WORKFLOWS, f), "utf8");

// Pull out every `wrangler <something>` invocation in a workflow.
function wranglerCommands(yaml: string): string[] {
  return [...yaml.matchAll(/^\s*(?:- )?run: .*$|^\s{2,}npx wrangler .*$/gm)]
    .map((m) => m[0].trim())
    .filter((line) => line.includes("wrangler"));
}

// The deploy workflows are the only place in this repo that can destroy data.
// The failure mode is mundane and total: a wrangler command in the dev workflow
// that loses its `--env dev` flag runs against production instead. There is no
// prompt, no diff, no undo — `d1 migrations apply` just applies.
//
// Splitting deploy into two files (rather than one with an `--env` computed by
// a GitHub expression) is what makes this checkable at all: each file has one
// target, stated literally.
describe("deploy workflows target the environment they claim to", () => {
  it("every wrangler command in deploy-dev carries --env dev", () => {
    const commands = wranglerCommands(read("deploy-dev.yml"));

    expect(commands.length, "found no wrangler commands in deploy-dev.yml").toBeGreaterThan(0);
    for (const cmd of commands) {
      expect(cmd, `dev workflow command without --env dev would hit production: ${cmd}`).toContain("--env dev");
    }
  });

  it("no wrangler command in deploy-prod names a non-production environment", () => {
    const commands = wranglerCommands(read("deploy-prod.yml"));

    expect(commands.length).toBeGreaterThan(0);
    for (const cmd of commands) {
      expect(cmd, `prod workflow must not target another env: ${cmd}`).not.toMatch(/--env\s+\w/);
    }
  });

  it("deploy-dev only fires on dev, deploy-prod only on main", () => {
    expect(read("deploy-dev.yml")).toMatch(/branches:\s*\[dev\]/);
    expect(read("deploy-prod.yml")).toMatch(/branches:\s*\[main\]/);
  });

  // Steps in a job run sequentially and abort on failure, so ordering IS the
  // gate — deploying before testing would mean shipping a red build.
  it.each(["deploy-dev.yml", "deploy-prod.yml"])("%s runs the tests before it deploys", (file) => {
    const yaml = read(file);
    const testStep = yaml.indexOf("npm test");
    const deployStep = yaml.indexOf("wrangler deploy");

    expect(testStep, `${file} never runs npm test`).toBeGreaterThan(-1);
    expect(deployStep).toBeGreaterThan(-1);
    expect(testStep, `${file} deploys before it tests`).toBeLessThan(deployStep);
  });

  // The falsiness trap: in GitHub expressions `x && '' || '--env dev'` always
  // yields the right-hand side, because '' is falsy. The previous plan used
  // exactly that shape to pick an env. Two literal workflows have no ternary at
  // all, so keep it that way.
  it("no workflow computes its target environment from an expression", () => {
    for (const file of ["deploy-dev.yml", "deploy-prod.yml"]) {
      expect(read(file), `${file} computes --env from a GitHub expression`).not.toMatch(
        /--env[^\n]*\$\{\{/,
      );
    }
  });
});
