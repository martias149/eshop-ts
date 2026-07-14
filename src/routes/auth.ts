import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Bindings } from "../types";
import { users, authTokens, type UserRow } from "../db/schema";
import { hashPassword, verifyPassword } from "../lib/hash";
import { generateToken } from "../lib/tokens";
import { authScopeLimit } from "../lib/rate-limit";
import { requireAuth } from "../lib/auth-middleware";

type Env = { Bindings: Bindings; Variables: { user?: UserRow } };

const authRoutes = new Hono<Env>();

function serializeUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    first_name: user.firstName,
    last_name: user.lastName,
    is_staff: user.isStaff,
  };
}

function jsonErrors(fields: Record<string, string>) {
  return { errors: fields } as const;
}

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  first_name: z.string().optional().default(""),
  last_name: z.string().optional().default(""),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

function validationErrorResponse(result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }, c: { json: (body: unknown, status: 400) => Response }) {
  if (result.success || !result.error) return undefined;
  const issue = result.error.issues[0];
  const field = typeof issue?.path[0] === "string" ? issue.path[0] : "non_field";
  return c.json(jsonErrors({ [field]: issue?.message ?? "invalid input" }), 400);
}

function passwordPolicyError(
  password: string,
  email: string,
  firstName: string,
  lastName: string
): string | null {
  if (password.length < 8) {
    return "password must be at least 8 characters long";
  }
  if (/^\d+$/.test(password)) {
    return "password cannot be entirely numeric";
  }

  const lowerPassword = password.toLowerCase();
  const localPart = email.split("@")[0]?.toLowerCase() ?? "";
  const candidates = [localPart, firstName.toLowerCase(), lastName.toLowerCase()];
  for (const candidate of candidates) {
    if (candidate && lowerPassword.includes(candidate)) {
      return "password cannot contain your name or email";
    }
  }

  return null;
}

authRoutes.post(
  "/register",
  authScopeLimit,
  zValidator("json", registerSchema, validationErrorResponse),
  async (c) => {
    const body = c.req.valid("json");

    const passwordError = passwordPolicyError(
      body.password,
      body.email,
      body.first_name,
      body.last_name
    );
    if (passwordError) {
      return c.json(jsonErrors({ password: passwordError }), 400);
    }

    const db = drizzle(c.env.DB);

    const existing = await db.select().from(users).where(eq(users.email, body.email)).get();
    if (existing) {
      return c.json(jsonErrors({ email: "a user with this email already exists" }), 400);
    }

    const iterations = Number.parseInt(c.env.PASSWORD_HASH_ITERATIONS, 10) || 100000;
    const passwordHash = await hashPassword(body.password, iterations);
    const now = Math.floor(Date.now() / 1000);

    const inserted = await db
      .insert(users)
      .values({
        email: body.email,
        passwordHash,
        firstName: body.first_name,
        lastName: body.last_name,
        dateJoined: now,
      })
      .returning()
      .get();

    const token = generateToken();
    await db.insert(authTokens).values({ key: token, userId: inserted.id, createdAt: now });

    return c.json({ token, user: serializeUser(inserted) }, 201);
  }
);

authRoutes.post(
  "/login",
  authScopeLimit,
  zValidator("json", loginSchema, validationErrorResponse),
  async (c) => {
    const body = c.req.valid("json");
    const db = drizzle(c.env.DB);

    const user = await db.select().from(users).where(eq(users.email, body.email)).get();
    if (!user) {
      return c.json(jsonErrors({ non_field: "invalid credentials" }), 400);
    }

    const passwordOk = await verifyPassword(body.password, user.passwordHash);
    if (!passwordOk || !user.isActive) {
      return c.json(jsonErrors({ non_field: "invalid credentials" }), 400);
    }

    const now = Math.floor(Date.now() / 1000);

    let tokenRow = await db
      .select()
      .from(authTokens)
      .where(eq(authTokens.userId, user.id))
      .get();
    if (!tokenRow) {
      tokenRow = { key: generateToken(), userId: user.id, createdAt: now };
      await db.insert(authTokens).values(tokenRow);
    }

    await db.update(users).set({ lastLogin: now }).where(eq(users.id, user.id));

    return c.json({ token: tokenRow.key, user: serializeUser(user) }, 200);
  }
);

authRoutes.post("/logout", requireAuth, async (c) => {
  const user = c.get("user");
  const db = drizzle(c.env.DB);
  await db.delete(authTokens).where(eq(authTokens.userId, user.id));
  return c.body(null, 204);
});

authRoutes.get("/me", requireAuth, (c) => {
  return c.json(serializeUser(c.get("user")));
});

export default authRoutes;
export { authRoutes };
