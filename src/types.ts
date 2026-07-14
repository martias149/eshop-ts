import type { Hono } from "hono";
import type { UserRow } from "./db/schema";

export interface Bindings {
  DB: D1Database;
  MEDIA: R2Bucket;
  ANTHROPIC_API_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_PUBLISHABLE_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  SENTRY_DSN: string;
  STRIPE_CURRENCY: string;
  PASSWORD_HASH_ITERATIONS: string;
}

export type App = Hono<{ Bindings: Bindings; Variables: { user?: UserRow } }>;
