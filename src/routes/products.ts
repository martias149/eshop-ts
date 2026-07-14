import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Bindings } from "../types";
import {
  categories,
  products,
  productImages,
  reviews,
  type CategoryRow,
  type ProductRow,
  type ProductImageRow,
} from "../db/schema";
import { centsToStr } from "../lib/money";
import { mediaUrl } from "../lib/media";

type Env = { Bindings: Bindings };

export const productsRouter = new Hono<Env>();

function avgRatingSubquery() {
  return sql<number | null>`(select avg(${reviews.rating}) from ${reviews} where ${reviews.productId} = ${products.id})`;
}

function reviewCountSubquery() {
  return sql<number>`(select count(*) from ${reviews} where ${reviews.productId} = ${products.id})`;
}

function serializeProduct(
  product: ProductRow,
  category: CategoryRow | null,
  avgRating: number | null,
  reviewCount: number,
  images: ProductImageRow[],
) {
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
    })),
    avg_rating: avgRating,
    review_count: reviewCount,
    created_at: new Date(product.createdAt * 1000).toISOString(),
    updated_at: new Date(product.updatedAt * 1000).toISOString(),
  };
}

function serializeReview(row: typeof reviews.$inferSelect) {
  return {
    id: row.id,
    product: row.productId,
    author_name: row.authorName,
    rating: row.rating,
    text: row.text,
    created_at: new Date(row.createdAt * 1000).toISOString(),
  };
}

async function fetchImagesByProductIds(
  db: ReturnType<typeof drizzle>,
  productIds: number[],
): Promise<Map<number, ProductImageRow[]>> {
  const map = new Map<number, ProductImageRow[]>();
  if (productIds.length === 0) return map;

  const rows = await db
    .select()
    .from(productImages)
    .where(inArray(productImages.productId, productIds))
    .orderBy(productImages.productId, productImages.sortOrder);

  for (const row of rows) {
    const arr = map.get(row.productId) ?? [];
    arr.push(row);
    map.set(row.productId, arr);
  }
  return map;
}

productsRouter.get("/categories", async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db.select().from(categories).orderBy(categories.name);
  return c.json(rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug })));
});

productsRouter.get("/categories/:slug", async (c) => {
  const db = drizzle(c.env.DB);
  const row = await db
    .select()
    .from(categories)
    .where(eq(categories.slug, c.req.param("slug")))
    .get();

  if (!row) return c.json({ detail: "not found" }, 404);
  return c.json({ id: row.id, name: row.name, slug: row.slug });
});

productsRouter.get("/products", async (c) => {
  const db = drizzle(c.env.DB);
  const categorySlug = c.req.query("category");

  const conditions = [eq(products.isActive, true)];
  if (categorySlug) {
    conditions.push(eq(categories.slug, categorySlug));
  }

  const rows = await db
    .select({
      product: products,
      category: categories,
      avgRating: avgRatingSubquery(),
      reviewCount: reviewCountSubquery(),
    })
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .where(and(...conditions))
    .orderBy(desc(products.createdAt));

  const imagesByProduct = await fetchImagesByProductIds(
    db,
    rows.map((r) => r.product.id),
  );

  return c.json(
    rows.map((r) =>
      serializeProduct(
        r.product,
        r.category,
        r.avgRating,
        r.reviewCount,
        imagesByProduct.get(r.product.id) ?? [],
      ),
    ),
  );
});

productsRouter.get("/products/:slug", async (c) => {
  const db = drizzle(c.env.DB);
  const slug = c.req.param("slug");

  const row = await db
    .select({
      product: products,
      category: categories,
      avgRating: avgRatingSubquery(),
      reviewCount: reviewCountSubquery(),
    })
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .where(and(eq(products.slug, slug), eq(products.isActive, true)))
    .get();

  if (!row) return c.json({ detail: "not found" }, 404);

  const images = await db
    .select()
    .from(productImages)
    .where(eq(productImages.productId, row.product.id))
    .orderBy(productImages.sortOrder);

  return c.json(serializeProduct(row.product, row.category, row.avgRating, row.reviewCount, images));
});

productsRouter.get("/reviews", async (c) => {
  const productParam = c.req.query("product");
  const productId = Number(productParam);
  if (!productParam || !Number.isInteger(productId)) {
    return c.json({ errors: { product: "required" } }, 400);
  }

  const db = drizzle(c.env.DB);
  const rows = await db
    .select()
    .from(reviews)
    .where(eq(reviews.productId, productId))
    .orderBy(desc(reviews.createdAt));

  return c.json(rows.map(serializeReview));
});

productsRouter.post("/reviews", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const db = drizzle(c.env.DB);

  const productId = Number(body.product);
  const product = Number.isInteger(productId)
    ? await db
        .select()
        .from(products)
        .where(and(eq(products.id, productId), eq(products.isActive, true)))
        .get()
    : undefined;
  if (!product) {
    return c.json({ errors: { product: "invalid product" } }, 400);
  }

  const authorName = typeof body.author_name === "string" ? body.author_name.trim() : "";
  if (!authorName) {
    return c.json({ errors: { author_name: "required" } }, 400);
  }

  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return c.json({ errors: { rating: "must be between 1 and 5" } }, 400);
  }

  const text = typeof body.text === "string" ? body.text : "";
  const createdAt = Math.floor(Date.now() / 1000);

  const inserted = await db
    .insert(reviews)
    .values({ productId, authorName, rating, text, createdAt })
    .returning();

  return c.json(serializeReview(inserted[0]), 201);
});

export default productsRouter;
