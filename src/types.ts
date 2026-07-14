import type { Hono } from "hono";
import type { UserRow } from "./db/schema";

// MEDIA is optional: R2 is not enabled on the account, so seeded product
// images are served from public/media/ as static assets instead. Binding R2
// re-enables admin image uploads without any other code change.
export interface Bindings {
  DB: D1Database;
  MEDIA?: R2Bucket;
  ANTHROPIC_API_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_PUBLISHABLE_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  SENTRY_DSN: string;
  STRIPE_CURRENCY: string;
  PASSWORD_HASH_ITERATIONS: string;
}

export type App = Hono<{ Bindings: Bindings; Variables: { user?: UserRow } }>;
