import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type Stripe from "stripe";
import type { Bindings } from "../types";
import {
  addresses,
  authTokens,
  coupons,
  orderItems,
  orders,
  payments,
  products,
  users,
  type AddressRow,
  type CouponRow,
  type OrderRow,
  type UserRow,
} from "../db/schema";
import { centsToStr } from "../lib/money";
import { discountForCents, isCouponValidNow } from "../lib/coupons";
import { constructWebhookEvent, getStripeClient, paymentIntentFor } from "../lib/stripe";
import { requireAuth } from "../lib/auth-middleware";
import { anonOrUserLimit } from "../lib/rate-limit";

type Env = { Bindings: Bindings; Variables: { user?: UserRow } };
type DB = DrizzleD1Database<Record<string, unknown>>;

const app = new Hono<Env>();

function now(): number {
  return Math.floor(Date.now() / 1000);
}

async function optionalUserId(c: { req: { header(name: string): string | undefined } }, db: DB): Promise<number | null> {
  const header = c.req.header("Authorization");
  const match = header?.match(/^Token (.+)$/);
  if (!match) return null;

  const rows = await db
    .select({ user: users })
    .from(authTokens)
    .innerJoin(users, eq(authTokens.userId, users.id))
    .where(eq(authTokens.key, match[1]))
    .limit(1);

  const user = rows[0]?.user;
  if (!user || !user.isActive) return null;
  return user.id;
}

function serializeAddress(row: AddressRow) {
  return {
    id: row.id,
    label: row.label,
    street: row.street,
    city: row.city,
    zip_code: row.zipCode,
    country: row.country,
  };
}

async function serializeOrder(db: DB, order: OrderRow) {
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));

  let couponCode: string | null = null;
  if (order.couponId !== null) {
    const c = await db.select({ code: coupons.code }).from(coupons).where(eq(coupons.id, order.couponId)).get();
    couponCode = c?.code ?? null;
  }

  const payment = await db.select().from(payments).where(eq(payments.orderId, order.id)).get();

  return {
    id: order.id,
    status: order.status,
    email: order.email,
    full_name: order.fullName,
    street: order.street,
    city: order.city,
    zip_code: order.zipCode,
    country: order.country,
    items: items.map((it) => ({
      product: it.productId,
      product_name: it.productName,
      price: centsToStr(it.priceCents),
      quantity: it.quantity,
      line_total: centsToStr(it.priceCents * it.quantity),
    })),
    coupon_code: couponCode,
    subtotal: centsToStr(order.subtotalCents),
    discount_amount: centsToStr(order.discountAmountCents),
    total: centsToStr(order.totalCents),
    payment: payment
      ? { provider: payment.provider, transaction_id: payment.transactionId, amount: centsToStr(payment.amountCents) }
      : null,
    created_at: new Date(order.createdAt * 1000).toISOString(),
  };
}

export async function markPaid(db: DB, order: OrderRow, provider: string, transactionId: string): Promise<OrderRow> {
  const nowTs = now();

  await db
    .insert(payments)
    .values({ orderId: order.id, provider, transactionId, amountCents: order.totalCents, createdAt: nowTs })
    .onConflictDoNothing({ target: payments.orderId });

  await db
    .update(orders)
    .set({ status: "paid", updatedAt: nowTs })
    .where(and(eq(orders.id, order.id), eq(orders.status, "pending")));

  const updated = await db.select().from(orders).where(eq(orders.id, order.id)).get();
  return updated!;
}

app.post("/orders", anonOrUserLimit, async (c) => {
  const db = drizzle(c.env.DB);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;

  const rawItems = body && Array.isArray(body.items) ? (body.items as unknown[]) : null;
  if (!rawItems || rawItems.length === 0) {
    return c.json({ errors: { items: "order must contain at least one item" } }, 400);
  }

  const parsedItems: { product: number; quantity: number }[] = [];
  for (const raw of rawItems) {
    const item = raw as Record<string, unknown>;
    const product = Number(item?.product);
    const quantity = Number(item?.quantity);
    if (!Number.isInteger(product) || !Number.isInteger(quantity) || quantity < 1) {
      return c.json({ errors: { items: "order must contain at least one item" } }, 400);
    }
    parsedItems.push({ product, quantity });
  }

  const productIds = parsedItems.map((i) => i.product);
  if (new Set(productIds).size !== productIds.length) {
    return c.json({ errors: { items: "duplicate products in order" } }, 400);
  }

  const couponCodeRaw = body?.coupon_code;
  let coupon: CouponRow | null = null;
  if (typeof couponCodeRaw === "string" && couponCodeRaw.trim() !== "") {
    const code = couponCodeRaw.trim();
    const found = await db
      .select()
      .from(coupons)
      .where(sql`lower(${coupons.code}) = lower(${code})`)
      .get();
    if (!found || !isCouponValidNow(found, now())) {
      return c.json({ errors: { coupon_code: "invalid or expired coupon" } }, 400);
    }
    coupon = found;
  }

  const succeeded: { productId: number; quantity: number }[] = [];
  let failedProductName: string | null = null;

  for (const item of parsedItems) {
    const result = await db
      .update(products)
      .set({ stock: sql`${products.stock} - ${item.quantity}` })
      .where(and(eq(products.id, item.product), gte(products.stock, item.quantity), eq(products.isActive, true)))
      .run();

    if (result.meta.changes === 0) {
      const p = await db.select({ name: products.name }).from(products).where(eq(products.id, item.product)).get();
      failedProductName = p?.name ?? `#${item.product}`;
      break;
    }

    succeeded.push({ productId: item.product, quantity: item.quantity });
  }

  if (failedProductName !== null) {
    for (const s of succeeded) {
      await db
        .update(products)
        .set({ stock: sql`${products.stock} + ${s.quantity}` })
        .where(eq(products.id, s.productId))
        .run();
    }
    return c.json({ errors: { items: `insufficient stock for ${failedProductName}` } }, 400);
  }

  const productRows = await db.select().from(products).where(inArray(products.id, productIds));
  const productById = new Map(productRows.map((p) => [p.id, p]));

  let subtotalCents = 0;
  const orderItemsData = parsedItems.map((item) => {
    const p = productById.get(item.product)!;
    subtotalCents += p.priceCents * item.quantity;
    return { productId: p.id, productName: p.name, priceCents: p.priceCents, quantity: item.quantity };
  });

  const discountAmountCents = coupon ? discountForCents(coupon, subtotalCents) : 0;
  const totalCents = subtotalCents - discountAmountCents;

  const userId = await optionalUserId(c, db);
  const orderId = crypto.randomUUID();
  const nowTs = now();

  await db.batch([
    db.insert(orders).values({
      id: orderId,
      userId,
      status: "pending",
      email: String(body?.email ?? ""),
      fullName: String(body?.full_name ?? ""),
      street: String(body?.street ?? ""),
      city: String(body?.city ?? ""),
      zipCode: String(body?.zip_code ?? ""),
      country: typeof body?.country === "string" && body.country ? body.country : "CZ",
      couponId: coupon?.id ?? null,
      subtotalCents,
      discountAmountCents,
      totalCents,
      paymentIntentId: "",
      createdAt: nowTs,
      updatedAt: nowTs,
    }),
    ...orderItemsData.map((it) =>
      db.insert(orderItems).values({
        orderId,
        productId: it.productId,
        productName: it.productName,
        priceCents: it.priceCents,
        quantity: it.quantity,
      }),
    ),
  ]);

  const created = await db.select().from(orders).where(eq(orders.id, orderId)).get();
  return c.json(await serializeOrder(db, created!), 201);
});

app.get("/orders", requireAuth, anonOrUserLimit, async (c) => {
  const db = drizzle(c.env.DB);
  const user = c.get("user")!;
  const rows = await db.select().from(orders).where(eq(orders.userId, user.id)).orderBy(desc(orders.createdAt));
  const result = await Promise.all(rows.map((o) => serializeOrder(db, o)));
  return c.json(result);
});

app.get("/orders/:id", anonOrUserLimit, async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const order = await db.select().from(orders).where(eq(orders.id, id)).get();
  if (!order) return c.json({ detail: "not found" }, 404);
  return c.json(await serializeOrder(db, order));
});

app.post("/orders/:id/pay", anonOrUserLimit, async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const order = await db.select().from(orders).where(eq(orders.id, id)).get();
  if (!order) return c.json({ detail: "not found" }, 404);
  if (order.status !== "pending") {
    return c.json({ detail: `cannot pay a ${order.status} order` }, 400);
  }

  if (!c.env.STRIPE_SECRET_KEY) {
    const updated = await markPaid(db, order, "fake", crypto.randomUUID());
    return c.json(await serializeOrder(db, updated));
  }

  const intent = await paymentIntentFor(c.env, db, order);
  return c.json({ provider: "stripe", client_secret: intent.client_secret, publishable_key: c.env.STRIPE_PUBLISHABLE_KEY });
});

app.post("/orders/:id/confirm-payment", anonOrUserLimit, async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const order = await db.select().from(orders).where(eq(orders.id, id)).get();
  if (!order) return c.json({ detail: "not found" }, 404);

  if (order.status === "paid") {
    return c.json(await serializeOrder(db, order));
  }

  if (order.status !== "pending" || !order.paymentIntentId) {
    return c.json({ detail: "nothing to confirm" }, 400);
  }

  const stripe = getStripeClient(c.env);
  const intent = await stripe.paymentIntents.retrieve(order.paymentIntentId);
  if (intent.status !== "succeeded") {
    return c.json({ detail: `payment not completed (${intent.status})` }, 400);
  }

  const updated = await markPaid(db, order, "stripe", intent.id);
  return c.json(await serializeOrder(db, updated));
});

app.post("/orders/:id/cancel", anonOrUserLimit, async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const order = await db.select().from(orders).where(eq(orders.id, id)).get();
  if (!order) return c.json({ detail: "not found" }, 404);

  if (order.status !== "pending" && order.status !== "paid") {
    return c.json({ detail: `cannot cancel a ${order.status} order` }, 400);
  }

  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, id));
  for (const item of items) {
    if (item.productId !== null) {
      await db
        .update(products)
        .set({ stock: sql`${products.stock} + ${item.quantity}` })
        .where(eq(products.id, item.productId))
        .run();
    }
  }

  const nowTs = now();
  await db.update(orders).set({ status: "cancelled", updatedAt: nowTs }).where(eq(orders.id, id));

  const updated = await db.select().from(orders).where(eq(orders.id, id)).get();
  return c.json(await serializeOrder(db, updated!));
});

app.post("/coupons/validate", anonOrUserLimit, async (c) => {
  const db = drizzle(c.env.DB);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const code = body?.code;

  if (typeof code !== "string" || code.trim() === "") {
    return c.json({ detail: "invalid or expired coupon" }, 404);
  }

  const trimmed = code.trim();
  const found = await db
    .select()
    .from(coupons)
    .where(sql`lower(${coupons.code}) = lower(${trimmed})`)
    .get();

  if (!found || !isCouponValidNow(found, now())) {
    return c.json({ detail: "invalid or expired coupon" }, 404);
  }

  const value = found.discountType === "percent" ? (found.valueHundredths / 100).toFixed(2) : centsToStr(found.valueHundredths);

  return c.json({ code: found.code, discount_type: found.discountType, value });
});

app.get("/addresses", requireAuth, anonOrUserLimit, async (c) => {
  const db = drizzle(c.env.DB);
  const user = c.get("user")!;
  const rows = await db.select().from(addresses).where(eq(addresses.userId, user.id));
  return c.json(rows.map(serializeAddress));
});

app.post("/addresses", requireAuth, anonOrUserLimit, async (c) => {
  const db = drizzle(c.env.DB);
  const user = c.get("user")!;
  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

  const inserted = await db
    .insert(addresses)
    .values({
      userId: user.id,
      label: typeof body.label === "string" && body.label ? body.label : "home",
      street: String(body.street ?? ""),
      city: String(body.city ?? ""),
      zipCode: String(body.zip_code ?? ""),
      country: typeof body.country === "string" && body.country ? body.country : "CZ",
    })
    .returning();

  return c.json(serializeAddress(inserted[0]), 201);
});

app.patch("/addresses/:id", requireAuth, anonOrUserLimit, async (c) => {
  const db = drizzle(c.env.DB);
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));

  const existing = await db
    .select()
    .from(addresses)
    .where(and(eq(addresses.id, id), eq(addresses.userId, user.id)))
    .get();
  if (!existing) return c.json({ detail: "not found" }, 404);

  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const patch: Partial<typeof addresses.$inferInsert> = {};
  if (typeof body.label === "string") patch.label = body.label;
  if (typeof body.street === "string") patch.street = body.street;
  if (typeof body.city === "string") patch.city = body.city;
  if (typeof body.zip_code === "string") patch.zipCode = body.zip_code;
  if (typeof body.country === "string") patch.country = body.country;

  const updated = await db.update(addresses).set(patch).where(eq(addresses.id, id)).returning();
  return c.json(serializeAddress(updated[0]));
});

app.delete("/addresses/:id", requireAuth, anonOrUserLimit, async (c) => {
  const db = drizzle(c.env.DB);
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));

  const existing = await db
    .select()
    .from(addresses)
    .where(and(eq(addresses.id, id), eq(addresses.userId, user.id)))
    .get();
  if (!existing) return c.json({ detail: "not found" }, 404);

  await db.delete(addresses).where(eq(addresses.id, id));
  return c.body(null, 204);
});

app.post("/stripe/webhook", async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET) {
    return c.json({ detail: "webhook not configured" }, 503);
  }

  const rawBody = await c.req.text();
  const signature = c.req.header("Stripe-Signature") ?? "";

  let event: Stripe.Event;
  try {
    event = await constructWebhookEvent(c.env, rawBody, signature);
  } catch {
    return c.json({ detail: "invalid signature" }, 400);
  }

  if (event.type === "payment_intent.succeeded") {
    const intent = event.data.object as Stripe.PaymentIntent;
    const orderId = intent.metadata?.order_id;
    if (typeof orderId === "string" && orderId) {
      const db = drizzle(c.env.DB);
      const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();
      if (order) {
        await markPaid(db, order, "stripe", intent.id);
      }
    }
  }

  return c.json({ received: true });
});

export default app;
