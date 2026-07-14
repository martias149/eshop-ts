import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq, inArray, like, or } from "drizzle-orm";
import type { Bindings } from "../types";
import { requireStaff } from "../lib/auth-middleware";
import { centsToStr, strToCents } from "../lib/money";
import { deleteImage, mediaUrl, productImageKey, putImage } from "../lib/media";
import {
  categories,
  coupons,
  orderItems,
  orders,
  productImages,
  products,
  reviews,
  users,
  type CouponRow,
  type OrderRow,
  type ProductRow,
  type UserRow,
} from "../db/schema";

type DB = ReturnType<typeof drizzle>;

export const admin = new Hono<{ Bindings: Bindings; Variables: { user: UserRow } }>();

admin.use("*", requireStaff);

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function isoFromUnix(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function isoToUnix(s: string): number | null {
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function uniqueProductSlug(db: DB, base: string, excludeId?: number): Promise<string> {
  let candidate = base || "product";
  let suffix = 2;
  while (true) {
    const rows = await db.select({ id: products.id }).from(products).where(eq(products.slug, candidate)).limit(1);
    const hit = rows[0];
    if (!hit || hit.id === excludeId) return candidate;
    candidate = `${base || "product"}-${suffix++}`;
  }
}

async function uniqueCategorySlug(db: DB, base: string, excludeId?: number): Promise<string> {
  let candidate = base || "category";
  let suffix = 2;
  while (true) {
    const rows = await db.select({ id: categories.id }).from(categories).where(eq(categories.slug, candidate)).limit(1);
    const hit = rows[0];
    if (!hit || hit.id === excludeId) return candidate;
    candidate = `${base || "category"}-${suffix++}`;
  }
}

async function serializeProduct(db: DB, product: ProductRow) {
  const [category, images] = await Promise.all([
    product.categoryId !== null
      ? db.select().from(categories).where(eq(categories.id, product.categoryId)).limit(1).then((r) => r[0] ?? null)
      : Promise.resolve(null),
    db.select().from(productImages).where(eq(productImages.productId, product.id)).orderBy(productImages.sortOrder),
  ]);
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    description: product.description,
    price: centsToStr(product.priceCents),
    stock: product.stock,
    is_active: product.isActive,
    category: category ? { id: category.id, name: category.name, slug: category.slug } : null,
    images: images.map((img) => ({
      id: img.id,
      url: mediaUrl(img.r2Key),
      alt_text: img.altText,
      sort_order: img.sortOrder,
    })),
    created_at: isoFromUnix(product.createdAt),
    updated_at: isoFromUnix(product.updatedAt),
  };
}

admin.get("/products", async (c) => {
  const db = drizzle(c.env.DB);
  const search = c.req.query("search");
  const categorySlug = c.req.query("category");
  const conditions = [];
  if (categorySlug) {
    const cat = await db.select({ id: categories.id }).from(categories).where(eq(categories.slug, categorySlug)).limit(1);
    if (!cat[0]) return c.json([]);
    conditions.push(eq(products.categoryId, cat[0].id));
  }
  if (search) {
    const q = `%${search}%`;
    conditions.push(or(like(products.name, q), like(products.description, q)));
  }
  const base = db.select().from(products);
  const rows = conditions.length
    ? await base.where(and(...conditions)).orderBy(desc(products.createdAt))
    : await base.orderBy(desc(products.createdAt));
  return c.json(await Promise.all(rows.map((p) => serializeProduct(db, p))));
});

admin.post("/products", async (c) => {
  const db = drizzle(c.env.DB);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ errors: { name: "required" } }, 400);
  if (body.price === undefined || body.price === null) {
    return c.json({ errors: { price: "required" } }, 400);
  }
  let priceCents: number;
  try {
    priceCents = strToCents(String(body.price));
  } catch {
    return c.json({ errors: { price: "must be a decimal string" } }, 400);
  }
  let categoryId: number | null = null;
  if (body.category_id !== undefined && body.category_id !== null) {
    categoryId = Number(body.category_id);
    const cat = await db.select({ id: categories.id }).from(categories).where(eq(categories.id, categoryId)).limit(1);
    if (!cat[0]) return c.json({ errors: { category_id: "does not exist" } }, 400);
  }
  const base = slugify(typeof body.slug === "string" && body.slug ? body.slug : name);
  const slug = await uniqueProductSlug(db, base);
  const ts = now();
  const [created] = await db
    .insert(products)
    .values({
      categoryId,
      name,
      slug,
      description: typeof body.description === "string" ? body.description : "",
      priceCents,
      stock: body.stock !== undefined ? Number(body.stock) : 0,
      isActive: body.is_active !== undefined ? Boolean(body.is_active) : true,
      createdAt: ts,
      updatedAt: ts,
    })
    .returning();
  return c.json(await serializeProduct(db, created), 201);
});

admin.get("/products/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = Number(c.req.param("id"));
  const rows = await db.select().from(products).where(eq(products.id, id)).limit(1);
  if (!rows[0]) return c.json({ detail: "not found" }, 404);
  return c.json(await serializeProduct(db, rows[0]));
});

admin.patch("/products/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = Number(c.req.param("id"));
  const existing = await db.select().from(products).where(eq(products.id, id)).limit(1);
  if (!existing[0]) return c.json({ detail: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const updates: Partial<typeof products.$inferInsert> = {};

  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ errors: { name: "required" } }, 400);
    updates.name = name;
  }
  if (body.description !== undefined) updates.description = String(body.description);
  if (body.price !== undefined) {
    try {
      updates.priceCents = strToCents(String(body.price));
    } catch {
      return c.json({ errors: { price: "must be a decimal string" } }, 400);
    }
  }
  if (body.stock !== undefined) updates.stock = Number(body.stock);
  if (body.is_active !== undefined) updates.isActive = Boolean(body.is_active);
  if (body.category_id !== undefined) {
    if (body.category_id === null) {
      updates.categoryId = null;
    } else {
      const categoryId = Number(body.category_id);
      const cat = await db.select({ id: categories.id }).from(categories).where(eq(categories.id, categoryId)).limit(1);
      if (!cat[0]) return c.json({ errors: { category_id: "does not exist" } }, 400);
      updates.categoryId = categoryId;
    }
  }
  if (body.slug !== undefined) {
    const source = typeof body.slug === "string" && body.slug ? body.slug : (updates.name ?? existing[0].name);
    const base = slugify(source);
    updates.slug = await uniqueProductSlug(db, base, id);
  }
  updates.updatedAt = now();

  await db.update(products).set(updates).where(eq(products.id, id));
  const [updated] = await db.select().from(products).where(eq(products.id, id)).limit(1);
  return c.json(await serializeProduct(db, updated));
});

admin.delete("/products/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = Number(c.req.param("id"));
  const existing = await db.select({ id: products.id }).from(products).where(eq(products.id, id)).limit(1);
  if (!existing[0]) return c.json({ detail: "not found" }, 404);

  const bucket = c.env.MEDIA;
  if (bucket) {
    const images = await db.select().from(productImages).where(eq(productImages.productId, id));
    for (const img of images) {
      try {
        await deleteImage(bucket, img.r2Key);
      } catch (err) {
        console.error("failed to delete r2 image", img.r2Key, err);
      }
    }
  }

  await db.delete(products).where(eq(products.id, id));
  return c.body(null, 204);
});

admin.post("/products/:id/images", async (c) => {
  const bucket = c.env.MEDIA;
  if (!bucket) return c.json({ detail: "image uploads require the R2 bucket binding" }, 503);

  const db = drizzle(c.env.DB);
  const productId = Number(c.req.param("id"));
  const productRow = await db.select({ id: products.id }).from(products).where(eq(products.id, productId)).limit(1);
  if (!productRow[0]) return c.json({ detail: "not found" }, 404);

  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) return c.json({ errors: { file: "required" } }, 400);

  const key = productImageKey(productId, file.name);
  await putImage(bucket, key, file, file.type);

  const altText = typeof body["alt_text"] === "string" ? (body["alt_text"] as string) : "";
  const sortOrder = body["sort_order"] !== undefined ? Number(body["sort_order"]) : 0;

  const [row] = await db
    .insert(productImages)
    .values({ productId, r2Key: key, altText, sortOrder })
    .returning();

  return c.json({ id: row.id, url: mediaUrl(row.r2Key), alt_text: row.altText, sort_order: row.sortOrder }, 201);
});

admin.delete("/products/:id/images/:imageId", async (c) => {
  const db = drizzle(c.env.DB);
  const productId = Number(c.req.param("id"));
  const imageId = Number(c.req.param("imageId"));
  const rows = await db
    .select()
    .from(productImages)
    .where(and(eq(productImages.id, imageId), eq(productImages.productId, productId)))
    .limit(1);
  const image = rows[0];
  if (!image) return c.json({ detail: "not found" }, 404);

  const bucket = c.env.MEDIA;
  if (bucket) {
    try {
      await deleteImage(bucket, image.r2Key);
    } catch (err) {
      console.error("failed to delete r2 image", image.r2Key, err);
    }
  }
  await db.delete(productImages).where(eq(productImages.id, imageId));
  return c.body(null, 204);
});

admin.get("/categories", async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db.select().from(categories).orderBy(categories.name);
  return c.json(rows);
});

admin.post("/categories", async (c) => {
  const db = drizzle(c.env.DB);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ errors: { name: "required" } }, 400);
  const base = slugify(typeof body.slug === "string" && body.slug ? body.slug : name);
  const slug = await uniqueCategorySlug(db, base);
  const [row] = await db.insert(categories).values({ name, slug }).returning();
  return c.json(row, 201);
});

admin.patch("/categories/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = Number(c.req.param("id"));
  const existing = await db.select().from(categories).where(eq(categories.id, id)).limit(1);
  if (!existing[0]) return c.json({ detail: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const updates: Partial<typeof categories.$inferInsert> = {};

  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ errors: { name: "required" } }, 400);
    updates.name = name;
  }
  if (body.slug !== undefined) {
    const base = slugify(typeof body.slug === "string" && body.slug ? body.slug : (updates.name ?? existing[0].name));
    updates.slug = await uniqueCategorySlug(db, base, id);
  }

  await db.update(categories).set(updates).where(eq(categories.id, id));
  const [row] = await db.select().from(categories).where(eq(categories.id, id)).limit(1);
  return c.json(row);
});

admin.delete("/categories/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = Number(c.req.param("id"));
  const existing = await db.select({ id: categories.id }).from(categories).where(eq(categories.id, id)).limit(1);
  if (!existing[0]) return c.json({ detail: "not found" }, 404);
  await db.delete(categories).where(eq(categories.id, id));
  return c.body(null, 204);
});

function decimalToHundredths(s: string): number {
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) throw new Error("invalid decimal");
  return Math.round(n * 100);
}

function serializeCoupon(row: CouponRow) {
  return {
    id: row.id,
    code: row.code,
    discount_type: row.discountType,
    value: centsToStr(row.valueHundredths),
    is_active: row.isActive,
    valid_from: row.validFrom !== null ? isoFromUnix(row.validFrom) : null,
    valid_to: row.validTo !== null ? isoFromUnix(row.validTo) : null,
  };
}

admin.get("/coupons", async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db.select().from(coupons).orderBy(desc(coupons.id));
  return c.json(rows.map(serializeCoupon));
});

admin.post("/coupons", async (c) => {
  const db = drizzle(c.env.DB);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) return c.json({ errors: { code: "required" } }, 400);
  if (body.discount_type !== "percent" && body.discount_type !== "fixed") {
    return c.json({ errors: { discount_type: "must be 'percent' or 'fixed'" } }, 400);
  }
  if (body.value === undefined || body.value === null) {
    return c.json({ errors: { value: "required" } }, 400);
  }
  let valueHundredths: number;
  try {
    valueHundredths = decimalToHundredths(String(body.value));
  } catch {
    return c.json({ errors: { value: "must be a decimal string" } }, 400);
  }
  let validFrom: number | null = null;
  if (body.valid_from !== undefined && body.valid_from !== null) {
    validFrom = isoToUnix(String(body.valid_from));
    if (validFrom === null) return c.json({ errors: { valid_from: "invalid date" } }, 400);
  }
  let validTo: number | null = null;
  if (body.valid_to !== undefined && body.valid_to !== null) {
    validTo = isoToUnix(String(body.valid_to));
    if (validTo === null) return c.json({ errors: { valid_to: "invalid date" } }, 400);
  }
  const dup = await db.select({ id: coupons.id }).from(coupons).where(eq(coupons.code, code)).limit(1);
  if (dup[0]) return c.json({ errors: { code: "already in use" } }, 400);

  const [row] = await db
    .insert(coupons)
    .values({
      code,
      discountType: body.discount_type,
      valueHundredths,
      isActive: body.is_active !== undefined ? Boolean(body.is_active) : true,
      validFrom,
      validTo,
    })
    .returning();
  return c.json(serializeCoupon(row), 201);
});

admin.patch("/coupons/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = Number(c.req.param("id"));
  const existing = await db.select().from(coupons).where(eq(coupons.id, id)).limit(1);
  if (!existing[0]) return c.json({ detail: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const updates: Partial<typeof coupons.$inferInsert> = {};

  if (body.code !== undefined) {
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!code) return c.json({ errors: { code: "required" } }, 400);
    const dup = await db.select({ id: coupons.id }).from(coupons).where(eq(coupons.code, code)).limit(1);
    if (dup[0] && dup[0].id !== id) return c.json({ errors: { code: "already in use" } }, 400);
    updates.code = code;
  }
  if (body.discount_type !== undefined) {
    if (body.discount_type !== "percent" && body.discount_type !== "fixed") {
      return c.json({ errors: { discount_type: "must be 'percent' or 'fixed'" } }, 400);
    }
    updates.discountType = body.discount_type;
  }
  if (body.value !== undefined) {
    try {
      updates.valueHundredths = decimalToHundredths(String(body.value));
    } catch {
      return c.json({ errors: { value: "must be a decimal string" } }, 400);
    }
  }
  if (body.is_active !== undefined) updates.isActive = Boolean(body.is_active);
  if (body.valid_from !== undefined) {
    if (body.valid_from === null) {
      updates.validFrom = null;
    } else {
      const v = isoToUnix(String(body.valid_from));
      if (v === null) return c.json({ errors: { valid_from: "invalid date" } }, 400);
      updates.validFrom = v;
    }
  }
  if (body.valid_to !== undefined) {
    if (body.valid_to === null) {
      updates.validTo = null;
    } else {
      const v = isoToUnix(String(body.valid_to));
      if (v === null) return c.json({ errors: { valid_to: "invalid date" } }, 400);
      updates.validTo = v;
    }
  }

  await db.update(coupons).set(updates).where(eq(coupons.id, id));
  const [row] = await db.select().from(coupons).where(eq(coupons.id, id)).limit(1);
  return c.json(serializeCoupon(row));
});

admin.delete("/coupons/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = Number(c.req.param("id"));
  const existing = await db.select({ id: coupons.id }).from(coupons).where(eq(coupons.id, id)).limit(1);
  if (!existing[0]) return c.json({ detail: "not found" }, 404);
  await db.delete(coupons).where(eq(coupons.id, id));
  return c.body(null, 204);
});

const ORDER_STATUSES = ["pending", "paid", "shipped", "cancelled"] as const;

function serializeOrderSummary(order: OrderRow, userEmail: string | null) {
  return {
    id: order.id,
    status: order.status,
    email: order.email,
    full_name: order.fullName,
    user_email: userEmail,
    total: centsToStr(order.totalCents),
    created_at: isoFromUnix(order.createdAt),
  };
}

admin.get("/orders", async (c) => {
  const db = drizzle(c.env.DB);
  const status = c.req.query("status");
  const search = c.req.query("search");
  const conditions = [];
  if (status && (ORDER_STATUSES as readonly string[]).includes(status)) {
    conditions.push(eq(orders.status, status as (typeof ORDER_STATUSES)[number]));
  }
  if (search) {
    const q = `%${search}%`;
    conditions.push(or(like(orders.email, q), like(orders.fullName, q), like(orders.id, q)));
  }
  const base = db.select({ order: orders, userEmail: users.email }).from(orders).leftJoin(users, eq(orders.userId, users.id));
  const rows = conditions.length
    ? await base.where(and(...conditions)).orderBy(desc(orders.createdAt))
    : await base.orderBy(desc(orders.createdAt));
  return c.json(rows.map(({ order, userEmail }) => serializeOrderSummary(order, userEmail ?? null)));
});

admin.get("/orders/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const rows = await db
    .select({ order: orders, userEmail: users.email })
    .from(orders)
    .leftJoin(users, eq(orders.userId, users.id))
    .where(eq(orders.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return c.json({ detail: "not found" }, 404);

  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, id));
  return c.json({
    id: row.order.id,
    status: row.order.status,
    email: row.order.email,
    full_name: row.order.fullName,
    street: row.order.street,
    city: row.order.city,
    zip_code: row.order.zipCode,
    country: row.order.country,
    subtotal: centsToStr(row.order.subtotalCents),
    discount_amount: centsToStr(row.order.discountAmountCents),
    total: centsToStr(row.order.totalCents),
    items: items.map((it) => ({
      product_id: it.productId,
      product_name: it.productName,
      price: centsToStr(it.priceCents),
      quantity: it.quantity,
    })),
    user_email: row.userEmail ?? null,
    created_at: isoFromUnix(row.order.createdAt),
    updated_at: isoFromUnix(row.order.updatedAt),
  });
});

admin.post("/orders/bulk-ship", async (c) => {
  const db = drizzle(c.env.DB);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const ids: string[] = Array.isArray(body.ids) ? (body.ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) return c.json({ updated: 0 });

  const toShip = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(inArray(orders.id, ids), eq(orders.status, "paid")));

  if (toShip.length > 0) {
    await db
      .update(orders)
      .set({ status: "shipped", updatedAt: now() })
      .where(inArray(orders.id, toShip.map((o) => o.id)));
  }

  return c.json({ updated: toShip.length });
});

admin.get("/reviews", async (c) => {
  const db = drizzle(c.env.DB);
  const productParam = c.req.query("product");
  const ratingParam = c.req.query("rating");
  const conditions = [];
  if (productParam) conditions.push(eq(reviews.productId, Number(productParam)));
  if (ratingParam) conditions.push(eq(reviews.rating, Number(ratingParam)));

  const base = db
    .select({ review: reviews, productName: products.name, productSlug: products.slug })
    .from(reviews)
    .innerJoin(products, eq(reviews.productId, products.id));
  const rows = conditions.length
    ? await base.where(and(...conditions)).orderBy(desc(reviews.createdAt))
    : await base.orderBy(desc(reviews.createdAt));

  return c.json(
    rows.map(({ review, productName, productSlug }) => ({
      id: review.id,
      product_id: review.productId,
      product: { name: productName, slug: productSlug },
      author_name: review.authorName,
      rating: review.rating,
      text: review.text,
      created_at: isoFromUnix(review.createdAt),
    })),
  );
});

admin.delete("/reviews/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = Number(c.req.param("id"));
  const existing = await db.select({ id: reviews.id }).from(reviews).where(eq(reviews.id, id)).limit(1);
  if (!existing[0]) return c.json({ detail: "not found" }, 404);
  await db.delete(reviews).where(eq(reviews.id, id));
  return c.body(null, 204);
});

function serializeUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    first_name: u.firstName,
    last_name: u.lastName,
    is_staff: u.isStaff,
    is_active: u.isActive,
    date_joined: isoFromUnix(u.dateJoined),
  };
}

admin.get("/users", async (c) => {
  const db = drizzle(c.env.DB);
  const search = c.req.query("search");
  const base = db.select().from(users);
  const rows = search
    ? await base
        .where(or(like(users.email, `%${search}%`), like(users.firstName, `%${search}%`), like(users.lastName, `%${search}%`)))
        .orderBy(users.id)
    : await base.orderBy(users.id);
  return c.json(rows.map(serializeUser));
});

admin.patch("/users/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = Number(c.req.param("id"));
  const existing = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!existing[0]) return c.json({ detail: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const updates: Partial<typeof users.$inferInsert> = {};
  if (body.is_staff !== undefined) updates.isStaff = Boolean(body.is_staff);
  if (body.is_active !== undefined) updates.isActive = Boolean(body.is_active);

  if (Object.keys(updates).length > 0) {
    await db.update(users).set(updates).where(eq(users.id, id));
  }
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return c.json(serializeUser(row));
});
