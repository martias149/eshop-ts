import { beforeAll, describe, expect, it } from "vitest";
import { applyD1Migrations, env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import seedSql from "../scripts/seed.sql?raw";
import type { Bindings } from "../src/types";
import { products, users } from "../src/db/schema";
import { verifyPassword } from "../src/lib/hash";

interface TestBindings extends Bindings {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

const testEnv = env as unknown as TestBindings;
const db = drizzle(testEnv.DB);

// scripts/seed.sql is hand-maintained SQL. It rots silently the moment the
// schema gains a NOT NULL column or renames one — and it is what every fresh
// environment is bootstrapped from, so the rot only surfaces at provisioning
// time. Apply it to a real migrated D1 and see.
describe("scripts/seed.sql still applies to the current schema", () => {
  beforeAll(async () => {
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);

    const statements = seedSql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    expect(statements.length, "seed.sql parsed to zero statements").toBeGreaterThan(0);
    await testEnv.DB.batch(statements.map((s) => testEnv.DB.prepare(s)));
  });

  it("loads the demo catalog", async () => {
    const rows = await db.select().from(products);
    expect(rows).toHaveLength(6);
    expect(rows.every((p) => p.priceCents > 0)).toBe(true);
  });

  it("loads the two demo accounts, with admin actually staff", async () => {
    const admin = await db.select().from(users).where(eq(users.email, "admin@example.com")).get();
    const student = await db.select().from(users).where(eq(users.email, "student@example.com")).get();

    expect(admin?.isStaff).toBe(true);
    expect(student?.isStaff).toBe(false);
  });

  // The seed hashes are generated out-of-band by a Node script, in a format
  // src/lib/hash.ts has to be able to parse. If either side's format drifts,
  // both demo logins break in every new environment at once.
  it("the seeded password hashes still verify against lib/hash.ts", async () => {
    const admin = await db.select().from(users).where(eq(users.email, "admin@example.com")).get();
    const student = await db.select().from(users).where(eq(users.email, "student@example.com")).get();

    expect(await verifyPassword("admin", admin!.passwordHash)).toBe(true);
    expect(await verifyPassword("correct-horse-battery", student!.passwordHash)).toBe(true);
    expect(await verifyPassword("wrong", admin!.passwordHash)).toBe(false);
  });
});
