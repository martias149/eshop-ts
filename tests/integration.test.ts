import { beforeAll, describe, expect, it } from "vitest";
import { applyD1Migrations, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import worker from "../src/index";
import type { Bindings } from "../src/types";
import { coupons, payments, products, users } from "../src/db/schema";
import { findCouponByCode } from "../src/lib/coupons";
import { toolCheckCoupon } from "../src/routes/support";

interface TestBindings extends Bindings {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

const testEnv = env as unknown as TestBindings;
const db = drizzle(testEnv.DB);

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

interface OrderItemJSON {
  product: number | null;
  product_name: string;
  price: string;
  quantity: number;
  line_total: string;
}

interface OrderJSON {
  id: string;
  status: string;
  email: string;
  items: OrderItemJSON[];
  subtotal: string;
  discount_amount: string;
  total: string;
  payment: { provider: string; transaction_id: string; amount: string } | null;
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://localhost${path}`, init), testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

let ipCounter = 0;
function nextIp(): string {
  ipCounter++;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

let emailCounter = 0;
function uniqueEmail(): string {
  emailCounter++;
  return `user${emailCounter}-${crypto.randomUUID().slice(0, 8)}@example.com`;
}

async function insertProduct(
  overrides: { name?: string; priceCents?: number; stock?: number; isActive?: boolean } = {},
) {
  const ts = Math.floor(Date.now() / 1000);
  const [row] = await db
    .insert(products)
    .values({
      name: overrides.name ?? "Test Product",
      slug: crypto.randomUUID(),
      priceCents: overrides.priceCents ?? 1000,
      stock: overrides.stock ?? 10,
      isActive: overrides.isActive ?? true,
      createdAt: ts,
      updatedAt: ts,
    })
    .returning();
  return row;
}

async function placeOrder(items: { product: number; quantity: number }[], ip: string): Promise<Response> {
  return call("/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({
      items,
      email: "buyer@example.com",
      full_name: "Buyer Buyerson",
      street: "Main St 1",
      city: "Prague",
      zip_code: "11000",
      country: "CZ",
    }),
  });
}

async function registerUser(ip: string): Promise<{ token: string; email: string }> {
  const email = uniqueEmail();
  const res = await call("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ email, password: "correcthorsebattery1" }),
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { token: string };
  return { token: body.token, email };
}

async function makeStaffToken(ip: string): Promise<string> {
  const { token, email } = await registerUser(ip);
  await db.update(users).set({ isStaff: true }).where(eq(users.email, email));
  return token;
}

describe("checkout stock reservation", () => {
  it("places an order for one product and decrements stock by exactly the ordered quantity", async () => {
    const ip = nextIp();
    const product = await insertProduct({ stock: 5, priceCents: 1000 });

    const res = await placeOrder([{ product: product.id, quantity: 2 }], ip);
    expect(res.status).toBe(201);
    const order = (await res.json()) as OrderJSON;
    expect(order.items).toHaveLength(1);
    expect(order.items[0].quantity).toBe(2);

    const [updated] = await db.select().from(products).where(eq(products.id, product.id));
    expect(updated.stock).toBe(3);
  });

  it("rejects the whole order and rolls back the first item's stock reservation when a later item has insufficient stock", async () => {
    const ip = nextIp();
    const productB = await insertProduct({ name: "Product B", stock: 3, priceCents: 500 });
    const productC = await insertProduct({ name: "Product C", stock: 1, priceCents: 700 });

    const res = await placeOrder(
      [
        { product: productB.id, quantity: 2 },
        { product: productC.id, quantity: 5 },
      ],
      ip,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { items: string } };
    expect(body.errors.items).toContain("Product C");

    const [b] = await db.select().from(products).where(eq(products.id, productB.id));
    const [c] = await db.select().from(products).where(eq(products.id, productC.id));
    expect(b.stock).toBe(3);
    expect(c.stock).toBe(1);
  });
});

describe("order status machine", () => {
  it("pays a pending order via the fake provider (no Stripe secret configured), creating a payment row; paying again is rejected", async () => {
    const ip = nextIp();
    const product = await insertProduct({ stock: 4, priceCents: 2000 });
    const orderRes = await placeOrder([{ product: product.id, quantity: 1 }], ip);
    const order = (await orderRes.json()) as OrderJSON;

    const payRes = await call(`/api/orders/${order.id}/pay`, {
      method: "POST",
      headers: { "CF-Connecting-IP": ip },
    });
    expect(payRes.status).toBe(200);
    const paid = (await payRes.json()) as OrderJSON;
    expect(paid.status).toBe("paid");
    expect(paid.payment).not.toBeNull();
    expect(paid.payment?.provider).toBe("fake");

    const [paymentRow] = await db.select().from(payments).where(eq(payments.orderId, order.id));
    expect(paymentRow).toBeTruthy();
    expect(paymentRow.amountCents).toBe(2000);

    const secondPay = await call(`/api/orders/${order.id}/pay`, {
      method: "POST",
      headers: { "CF-Connecting-IP": ip },
    });
    expect(secondPay.status).toBe(400);
  });

  it("cancels a paid order, restoring stock", async () => {
    const ip = nextIp();
    const product = await insertProduct({ stock: 5, priceCents: 1500 });
    const orderRes = await placeOrder([{ product: product.id, quantity: 2 }], ip);
    const order = (await orderRes.json()) as OrderJSON;

    await call(`/api/orders/${order.id}/pay`, { method: "POST", headers: { "CF-Connecting-IP": ip } });

    const cancelRes = await call(`/api/orders/${order.id}/cancel`, {
      method: "POST",
      headers: { "CF-Connecting-IP": ip },
    });
    expect(cancelRes.status).toBe(200);
    const cancelled = (await cancelRes.json()) as OrderJSON;
    expect(cancelled.status).toBe("cancelled");

    const [restored] = await db.select().from(products).where(eq(products.id, product.id));
    expect(restored.stock).toBe(5);
  });

  it("a shipped order cannot be cancelled", async () => {
    const ip = nextIp();
    const product = await insertProduct({ stock: 5, priceCents: 1200 });
    const orderRes = await placeOrder([{ product: product.id, quantity: 1 }], ip);
    const order = (await orderRes.json()) as OrderJSON;
    await call(`/api/orders/${order.id}/pay`, { method: "POST", headers: { "CF-Connecting-IP": ip } });

    const staffToken = await makeStaffToken(nextIp());
    const shipRes = await call("/api/admin/orders/bulk-ship", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Token ${staffToken}` },
      body: JSON.stringify({ ids: [order.id] }),
    });
    expect(shipRes.status).toBe(200);
    const shipBody = (await shipRes.json()) as { updated: number };
    expect(shipBody.updated).toBe(1);

    const check = await call(`/api/orders/${order.id}`, { headers: { "CF-Connecting-IP": ip } });
    const checked = (await check.json()) as OrderJSON;
    expect(checked.status).toBe("shipped");

    const cancelRes = await call(`/api/orders/${order.id}/cancel`, {
      method: "POST",
      headers: { "CF-Connecting-IP": ip },
    });
    expect(cancelRes.status).toBe(400);
  });
});

describe("order item snapshots", () => {
  it("keeps the order item's original snapshotted price and name after the product is changed", async () => {
    const ip = nextIp();
    const product = await insertProduct({ name: "Original Widget", priceCents: 5000, stock: 10 });

    const orderRes = await placeOrder([{ product: product.id, quantity: 1 }], ip);
    expect(orderRes.status).toBe(201);
    const order = (await orderRes.json()) as OrderJSON;
    expect(order.items[0].product_name).toBe("Original Widget");
    expect(order.items[0].price).toBe("50.00");

    const staffToken = await makeStaffToken(nextIp());
    const patchRes = await call(`/api/admin/products/${product.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Token ${staffToken}` },
      body: JSON.stringify({ name: "Renamed Widget", price: "99.99" }),
    });
    expect(patchRes.status).toBe(200);

    const refetch = await call(`/api/orders/${order.id}`, { headers: { "CF-Connecting-IP": ip } });
    const refetched = (await refetch.json()) as OrderJSON;
    expect(refetched.items[0].product_name).toBe("Original Widget");
    expect(refetched.items[0].price).toBe("50.00");
  });
});

describe("auth", () => {
  it("register then login round-trip returns a working token", async () => {
    const ip = nextIp();
    const email = uniqueEmail();
    const password = "correcthorsebattery1";

    const regRes = await call("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ email, password }),
    });
    expect(regRes.status).toBe(201);

    const loginRes = await call("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ email, password }),
    });
    expect(loginRes.status).toBe(200);
    const loginBody = (await loginRes.json()) as { token: string };

    const meRes = await call("/api/auth/me", { headers: { Authorization: `Token ${loginBody.token}` } });
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as { email: string };
    expect(meBody.email).toBe(email);
  });

  it("GET /api/auth/me without a token is 401", async () => {
    const res = await call("/api/auth/me");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toBeTruthy();
  });

  it("rejects a weak password on register", async () => {
    const ip = nextIp();
    const res = await call("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ email: uniqueEmail(), password: "1234567" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Record<string, string> };
    expect(body.errors.password).toBeTruthy();
  });

  it("rejects a duplicate email on register", async () => {
    const ip = nextIp();
    const email = uniqueEmail();

    const first = await call("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ email, password: "correcthorsebattery1" }),
    });
    expect(first.status).toBe(201);

    const second = await call("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ email, password: "correcthorsebattery1" }),
    });
    expect(second.status).toBe(400);
    const body = (await second.json()) as { errors: Record<string, string> };
    expect(body.errors.email).toBeTruthy();
  });

  it("register and login share the same auth rate-limit budget (429 with Retry-After after 10/min)", async () => {
    const ip = nextIp();
    const jsonHeaders = { "Content-Type": "application/json", "CF-Connecting-IP": ip };

    const first = await call("/api/auth/register", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ email: uniqueEmail(), password: "correcthorsebattery1" }),
    });
    expect(first.status).not.toBe(429);

    for (let i = 0; i < 9; i++) {
      const res = await call("/api/auth/login", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ email: "nobody@example.com", password: "whatever123" }),
      });
      expect(res.status).not.toBe(429);
    }

    const eleventh = await call("/api/auth/login", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ email: "nobody@example.com", password: "whatever123" }),
    });
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("address ownership", () => {
  it("user A cannot PATCH/DELETE user B's address; gets 404, not 403", async () => {
    const tokenA = (await registerUser(nextIp())).token;
    const tokenB = (await registerUser(nextIp())).token;

    const createRes = await call("/api/addresses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Token ${tokenB}` },
      body: JSON.stringify({ street: "B Street 1", city: "Brno", zip_code: "60200" }),
    });
    expect(createRes.status).toBe(201);
    const address = (await createRes.json()) as { id: number; street: string };

    const patchRes = await call(`/api/addresses/${address.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Token ${tokenA}` },
      body: JSON.stringify({ street: "Hijacked" }),
    });
    expect(patchRes.status).toBe(404);

    const deleteRes = await call(`/api/addresses/${address.id}`, {
      method: "DELETE",
      headers: { Authorization: `Token ${tokenA}` },
    });
    expect(deleteRes.status).toBe(404);

    const listRes = await call("/api/addresses", { headers: { Authorization: `Token ${tokenB}` } });
    const list = (await listRes.json()) as { id: number; street: string }[];
    expect(list.some((a) => a.id === address.id && a.street === "B Street 1")).toBe(true);
  });
});

describe("admin gating", () => {
  it("a non-staff authenticated user gets 403 from admin routes; anonymous gets 401", async () => {
    const token = (await registerUser(nextIp())).token;

    for (const path of ["/api/admin/products", "/api/admin/orders", "/api/admin/users"]) {
      const nonStaffRes = await call(path, { headers: { Authorization: `Token ${token}` } });
      expect(nonStaffRes.status).toBe(403);

      const anonRes = await call(path);
      expect(anonRes.status).toBe(401);
    }
  });
});

// Codes are stored uppercase but customers type them however they like, so
// every lookup path has to agree on case-insensitivity — the support chatbot
// included, or it tells customers a working coupon is invalid.
describe("coupon codes are matched case-insensitively on every path", () => {
  async function insertCoupon(code: string) {
    const [row] = await db
      .insert(coupons)
      .values({ code, discountType: "percent", valueHundredths: 1000, isActive: true })
      .returning();
    return row;
  }

  it("/api/coupons/validate accepts a lowercase spelling of an uppercase code", async () => {
    await insertCoupon("SAVE10");

    const res = await call("/api/coupons/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": nextIp() },
      body: JSON.stringify({ code: "save10" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ code: "SAVE10", discount_type: "percent" });
  });

  it("checkout applies a coupon typed in the wrong case", async () => {
    await insertCoupon("MIXED10");
    const product = await insertProduct({ priceCents: 10000, stock: 5 });

    const res = await call("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": nextIp() },
      body: JSON.stringify({
        items: [{ product: product.id, quantity: 1 }],
        coupon_code: "  mIxEd10 ",
        email: "buyer@example.com",
        full_name: "Buyer Buyerson",
        street: "Main St 1",
        city: "Prague",
        zip_code: "11000",
        country: "CZ",
      }),
    });

    expect(res.status).toBe(201);
    const order = (await res.json()) as OrderJSON;
    expect(order.discount_amount).toBe("10.00");
    expect(order.total).toBe("90.00");
  });

  it("findCouponByCode, the one lookup the chatbot and checkout share, ignores case", async () => {
    await insertCoupon("SHARED10");

    expect(await findCouponByCode(db, "shared10")).toMatchObject({ code: "SHARED10" });
    expect(await findCouponByCode(db, "SHARED10")).toMatchObject({ code: "SHARED10" });
    expect(await findCouponByCode(db, "  ShArEd10  ")).toMatchObject({ code: "SHARED10" });
    expect(await findCouponByCode(db, "nope10")).toBeUndefined();
  });

  // The bug that started this: the chatbot used to match the code exactly, so
  // it told customers a coupon checkout would happily accept was invalid.
  it("the chatbot's check_coupon tool agrees with checkout on a lowercase code", async () => {
    await insertCoupon("BOT10");

    expect(await toolCheckCoupon(db, "bot10")).toEqual({
      valid: true,
      discount_type: "percent",
      value: "10.00",
    });
    expect(await toolCheckCoupon(db, "BOT10")).toMatchObject({ valid: true });
    expect(await toolCheckCoupon(db, "not-a-code")).toEqual({ valid: false });
  });
});
