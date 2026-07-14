import { beforeAll, describe, expect, it } from "vitest";
import { applyD1Migrations, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import worker from "../src/index";
import type { Bindings } from "../src/types";
import { categories, productImages, products } from "../src/db/schema";
import {
  CATEGORY_KEYS,
  ORDER_ITEM_KEYS,
  ORDER_KEYS,
  PRODUCT_IMAGE_KEYS,
  PRODUCT_KEYS,
  REVIEW_KEYS,
  USER_KEYS,
} from "./fixtures/api-contract";

interface TestBindings extends Bindings {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

const testEnv = env as unknown as TestBindings;
const db = drizzle(testEnv.DB);

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

async function call(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://localhost${path}`, init), testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// Exact, not superset: an extra key is as much a contract change as a missing
// one, and silently adding fields is how the two sides drift apart.
function expectKeys(obj: unknown, keys: readonly string[]) {
  expect(Object.keys(obj as object).sort()).toEqual([...keys].sort());
}

let ip = 0;
const nextIp = () => `172.16.0.${++ip % 250}`;

describe("the API emits exactly the keys the frontend reads", () => {
  beforeAll(async () => {
    const ts = Math.floor(Date.now() / 1000);
    const [cat] = await db.insert(categories).values({ name: "Peripherals", slug: "peripherals" }).returning();
    const [p] = await db
      .insert(products)
      .values({
        categoryId: cat.id,
        name: "Contract Keyboard",
        slug: "contract-keyboard",
        description: "x",
        priceCents: 12990,
        stock: 5,
        isActive: true,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    await db
      .insert(productImages)
      .values({ productId: p.id, r2Key: "products/kbd.png", altText: "kbd", sortOrder: 0 });
  });

  it("GET /api/products", async () => {
    const list = (await (await call("/api/products")).json()) as Record<string, unknown>[];
    const product = list.find((p) => p.slug === "contract-keyboard")!;

    expectKeys(product, PRODUCT_KEYS);
    expectKeys((product.category as object) ?? {}, CATEGORY_KEYS);

    const images = product.images as Record<string, unknown>[];
    expect(images).toHaveLength(1);
    expectKeys(images[0], PRODUCT_IMAGE_KEYS);
    // The bug: this was read as `.image` in the frontend for the whole first
    // deploy, so every product rendered a broken <img>.
    expect(images[0].url).toBe("/media/products/kbd.png");
  });

  it("GET /api/products/:slug", async () => {
    const product = await (await call("/api/products/contract-keyboard")).json();
    expectKeys(product as object, PRODUCT_KEYS);
  });

  it("GET /api/categories", async () => {
    const list = (await (await call("/api/categories")).json()) as unknown[];
    expectKeys(list[0] as object, CATEGORY_KEYS);
  });

  it("auth responses carry is_staff, which gates the entire admin panel", async () => {
    const email = `contract-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const body = JSON.stringify({ email, password: "correcthorsebattery1" });
    const headers = { "Content-Type": "application/json", "CF-Connecting-IP": nextIp() };

    const registered = (await (await call("/api/auth/register", { method: "POST", headers, body })).json()) as {
      token: string;
      user: object;
    };
    expectKeys(registered.user, USER_KEYS);

    const login = (await (await call("/api/auth/login", { method: "POST", headers, body })).json()) as {
      user: object;
    };
    expectKeys(login.user, USER_KEYS);

    const me = await (
      await call("/api/auth/me", { headers: { Authorization: `Token ${registered.token}` } })
    ).json();
    expectKeys(me as object, USER_KEYS);
    expect((me as { is_staff: unknown }).is_staff).toBe(false);
  });

  it("GET /api/orders/:id and its items", async () => {
    const list = (await (await call("/api/products")).json()) as { id: number }[];

    const created = (await (
      await call("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": nextIp() },
        body: JSON.stringify({
          items: [{ product: list[0].id, quantity: 1 }],
          email: "c@example.com",
          full_name: "C",
          street: "S 1",
          city: "Brno",
          zip_code: "60200",
          country: "CZ",
        }),
      })
    ).json()) as Record<string, unknown>;

    expectKeys(created, ORDER_KEYS);
    expectKeys((created.items as object[])[0], ORDER_ITEM_KEYS);

    const fetched = await (await call(`/api/orders/${created.id}`)).json();
    expectKeys(fetched as object, ORDER_KEYS);
  });

  it("GET /api/reviews", async () => {
    const list = (await (await call("/api/products")).json()) as { id: number }[];
    const posted = await (
      await call("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": nextIp() },
        body: JSON.stringify({ product: list[0].id, author_name: "A", rating: 5, text: "good" }),
      })
    ).json();

    expectKeys(posted as object, REVIEW_KEYS);
  });
});
