import { createMiddleware } from "hono/factory";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Bindings } from "../types";
import { authTokens, users, type UserRow } from "../db/schema";

type Env = { Bindings: Bindings; Variables: { user: UserRow } };

export const requireAuth = createMiddleware<Env>(async (c, next) => {
  const header = c.req.header("Authorization");
  const match = header?.match(/^Token (.+)$/);
  if (!match) {
    return c.json({ detail: "invalid or missing token" }, 401);
  }

  const db = drizzle(c.env.DB);
  const rows = await db
    .select({ user: users })
    .from(authTokens)
    .innerJoin(users, eq(authTokens.userId, users.id))
    .where(eq(authTokens.key, match[1]))
    .limit(1);

  const user = rows[0]?.user;
  if (!user || !user.isActive) {
    return c.json({ detail: "invalid or missing token" }, 401);
  }

  c.set("user", user);
  await next();
});

export const requireStaff = createMiddleware<Env>(async (c, next) => {
  let forbidden: Response | undefined;
  const authResult = await requireAuth(c, async () => {
    if (!c.get("user").isStaff) {
      forbidden = c.json({ detail: "staff access required" }, 403);
      return;
    }
    await next();
  });
  return authResult ?? forbidden;
});
