import { drizzle } from "drizzle-orm/d1";
import { eq, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { rateLimitBuckets } from "../db/schema";
import type { Bindings } from "../types";
import type { UserRow } from "../db/schema";

type Env = { Bindings: Bindings; Variables: { user?: UserRow } };
type Ctx = Parameters<MiddlewareHandler<Env>>[0];

function ipOf(c: Ctx): string {
  return c.req.header("CF-Connecting-IP") ?? "unknown";
}

function defaultIdentify(c: Ctx): string {
  const user = c.get("user");
  if (user) return "user:" + user.id;
  return "ip:" + ipOf(c);
}

export function rateLimit(opts: {
  scope: string;
  limit: number;
  windowSeconds: number;
  identify?: (c: Ctx) => string;
}): MiddlewareHandler<Env> {
  const identify = opts.identify ?? defaultIdentify;

  return async (c, next) => {
    const db = drizzle(c.env.DB);
    const currentUnixSeconds = Math.floor(Date.now() / 1000);
    const windowIndex = Math.floor(currentUnixSeconds / opts.windowSeconds);
    const identifier = identify(c);
    const key = opts.scope + ":" + identifier + ":" + windowIndex;
    const resetAt = (windowIndex + 1) * opts.windowSeconds;

    await db
      .insert(rateLimitBuckets)
      .values({ key, count: 1, resetAt })
      .onConflictDoUpdate({
        target: rateLimitBuckets.key,
        set: { count: sql`${rateLimitBuckets.count} + 1` },
      });

    const row = await db
      .select()
      .from(rateLimitBuckets)
      .where(eq(rateLimitBuckets.key, key))
      .get();

    if (row && row.count > opts.limit) {
      c.header("Retry-After", String(row.resetAt - currentUnixSeconds));
      return c.json({ detail: "rate limit exceeded, try again later" }, 429);
    }

    await next();
  };
}

export const anonOrUserLimit: MiddlewareHandler<Env> = async (c, next) => {
  const user = c.get("user");
  const middleware = rateLimit({
    scope: "anon-or-user",
    limit: user ? 120 : 60,
    windowSeconds: 60,
    identify: (c) => {
      const u = c.get("user");
      return u ? "user:" + u.id : "ip:" + ipOf(c);
    },
  });
  return middleware(c, next);
};

export const authScopeLimit = rateLimit({
  scope: "auth",
  limit: 10,
  windowSeconds: 60,
  identify: (c) => "ip:" + ipOf(c),
});

export const chatScopeLimit = rateLimit({
  scope: "chat",
  limit: 20,
  windowSeconds: 60,
});
