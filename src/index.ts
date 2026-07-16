import { Hono } from "hono";
import * as Sentry from "@sentry/cloudflare";
import type { Bindings } from "./types";
import type { UserRow } from "./db/schema";
import { withSentry } from "./lib/sentry";
import authRoutes from "./routes/auth";
import productsRouter from "./routes/products";
import ordersRouter from "./routes/orders";
import { admin } from "./routes/admin";
import supportRouter from "./routes/support";

type Env = { Bindings: Bindings; Variables: { user?: UserRow } };

const app = new Hono<Env>();

app.route("/api/auth", authRoutes);
app.route("/api", productsRouter);
app.route("/api", ordersRouter);
app.route("/api/admin", admin);
app.route("/api/support", supportRouter);

// Only reached for keys with no matching static asset under public/media/.
app.get("/media/:key{.+}", async (c) => {
  if (!c.env.MEDIA) return c.json({ detail: "not found" }, 404);

  const key = c.req.param("key");
  const object = await c.env.MEDIA.get(key);
  if (!object) return c.json({ detail: "not found" }, 404);

  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

app.onError((err, c) => {
  if (c.env.SENTRY_DSN) {
    Sentry.captureException(err);
  }
  console.error({
    event: "unhandled_error",
    method: c.req.method,
    path: c.req.path,
    error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return c.json({ detail: "internal server error" }, 500);
});

export default withSentry(app);
