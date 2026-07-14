import * as Sentry from "@sentry/cloudflare";
import type { Bindings } from "../types";

export function withSentry<T extends ExportedHandler<Bindings>>(handler: T): T {
  return Sentry.withSentry(
    (env: Bindings) => ({
      dsn: env.SENTRY_DSN,
      enabled: !!env.SENTRY_DSN,
      environment: "production",
      tracesSampleRate: 1.0,
      sendDefaultPii: true,
    }),
    handler,
  );
}
