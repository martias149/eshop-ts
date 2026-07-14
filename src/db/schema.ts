import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  firstName: text("first_name").notNull().default(""),
  lastName: text("last_name").notNull().default(""),
  isStaff: integer("is_staff", { mode: "boolean" }).notNull().default(false),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  isSuperuser: integer("is_superuser", { mode: "boolean" }).notNull().default(false),
  dateJoined: integer("date_joined").notNull(),
  lastLogin: integer("last_login"),
});

export const authTokens = sqliteTable("auth_tokens", {
  key: text("key").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
});

export const categories = sqliteTable("categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
});

export const products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  categoryId: integer("category_id").references(() => categories.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description").notNull().default(""),
  priceCents: integer("price_cents").notNull(),
  stock: integer("stock").notNull().default(0),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const productImages = sqliteTable("product_images", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  r2Key: text("r2_key").notNull(),
  altText: text("alt_text").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const reviews = sqliteTable("reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  authorName: text("author_name").notNull(),
  rating: integer("rating").notNull(),
  text: text("text").notNull().default(""),
  createdAt: integer("created_at").notNull(),
});

export const addresses = sqliteTable("addresses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  label: text("label").notNull().default("home"),
  street: text("street").notNull(),
  city: text("city").notNull(),
  zipCode: text("zip_code").notNull(),
  country: text("country").notNull().default("CZ"),
});

export const coupons = sqliteTable("coupons", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull().unique(),
  discountType: text("discount_type", { enum: ["percent", "fixed"] }).notNull(),
  valueHundredths: integer("value_hundredths").notNull(),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  validFrom: integer("valid_from"),
  validTo: integer("valid_to"),
});

export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  status: text("status", { enum: ["pending", "paid", "shipped", "cancelled"] })
    .notNull()
    .default("pending"),
  email: text("email").notNull(),
  fullName: text("full_name").notNull(),
  street: text("street").notNull(),
  city: text("city").notNull(),
  zipCode: text("zip_code").notNull(),
  country: text("country").notNull().default("CZ"),
  couponId: integer("coupon_id").references(() => coupons.id, { onDelete: "set null" }),
  subtotalCents: integer("subtotal_cents").notNull(),
  discountAmountCents: integer("discount_amount_cents").notNull().default(0),
  totalCents: integer("total_cents").notNull(),
  paymentIntentId: text("payment_intent_id").notNull().default(""),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const orderItems = sqliteTable("order_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: text("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  productId: integer("product_id").references(() => products.id, { onDelete: "set null" }),
  productName: text("product_name").notNull(),
  priceCents: integer("price_cents").notNull(),
  quantity: integer("quantity").notNull(),
});

export const payments = sqliteTable("payments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: text("order_id")
    .notNull()
    .unique()
    .references(() => orders.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("fake"),
  transactionId: text("transaction_id").notNull(),
  amountCents: integer("amount_cents").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const rateLimitBuckets = sqliteTable("rate_limit_buckets", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  resetAt: integer("reset_at").notNull(),
});

export type UserRow = typeof users.$inferSelect;
export type AuthTokenRow = typeof authTokens.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
export type ProductRow = typeof products.$inferSelect;
export type ProductImageRow = typeof productImages.$inferSelect;
export type ReviewRow = typeof reviews.$inferSelect;
export type AddressRow = typeof addresses.$inferSelect;
export type CouponRow = typeof coupons.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type RateLimitBucketRow = typeof rateLimitBuckets.$inferSelect;
