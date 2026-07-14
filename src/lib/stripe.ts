import Stripe from "stripe";
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { orders, type OrderRow } from "../db/schema";
import type { Bindings } from "../types";

export function getStripeClient(env: Bindings): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export async function paymentIntentFor(
  env: Bindings,
  db: DrizzleD1Database<Record<string, unknown>>,
  order: OrderRow,
): Promise<Stripe.PaymentIntent> {
  const stripe = getStripeClient(env);

  if (order.paymentIntentId) {
    const existing = await stripe.paymentIntents.retrieve(order.paymentIntentId);
    if (existing.status !== "succeeded" && existing.status !== "canceled") {
      return existing;
    }
  }

  const intent = await stripe.paymentIntents.create({
    amount: order.totalCents,
    currency: env.STRIPE_CURRENCY,
    metadata: { order_id: order.id },
    automatic_payment_methods: { enabled: true },
  });

  await db
    .update(orders)
    .set({ paymentIntentId: intent.id, updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(orders.id, order.id));

  return intent;
}

export async function constructWebhookEvent(
  env: Bindings,
  rawBody: string,
  signatureHeader: string,
): Promise<Stripe.Event> {
  const stripe = getStripeClient(env);
  return stripe.webhooks.constructEventAsync(
    rawBody,
    signatureHeader,
    env.STRIPE_WEBHOOK_SECRET,
    undefined,
    Stripe.createSubtleCryptoProvider(),
  );
}
