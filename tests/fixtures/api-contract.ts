// The seam between src/routes/* and public/*.js, written down once.
//
// Three of the four real bugs in this rewrite lived here and typechecked
// perfectly: images were serialized as `url` but read as `.image`, the admin
// upload field was named `file` but sent as `image`, and `is_staff` was absent
// from the auth response entirely, which made the admin panel unreachable.
// Nothing caught any of them, because each side was individually consistent.
//
// Both halves of the contract now assert against these constants:
//   tests/contract.test.ts       — the backend really emits these keys
//   tests/node/frontend.test.ts  — the frontend really reads these keys
// Changing a name means changing it here, which fails both sides at once.

export const PRODUCT_KEYS = [
  "id",
  "name",
  "slug",
  "description",
  "price",
  "stock",
  "is_active",
  "category",
  "images",
  "avg_rating",
  "review_count",
  "created_at",
  "updated_at",
] as const;

export const PRODUCT_IMAGE_KEYS = ["id", "url", "alt_text"] as const;

export const CATEGORY_KEYS = ["id", "name", "slug"] as const;

// `is_staff` gates the admin nav link and the whole admin panel's boot check.
export const USER_KEYS = ["id", "email", "first_name", "last_name", "is_staff"] as const;

export const ORDER_KEYS = [
  "id",
  "status",
  "email",
  "full_name",
  "street",
  "city",
  "zip_code",
  "country",
  "items",
  "coupon_code",
  "subtotal",
  "discount_amount",
  "total",
  "payment",
  "created_at",
] as const;

export const ORDER_ITEM_KEYS = [
  "product",
  "product_name",
  "price",
  "quantity",
  "line_total",
] as const;

export const REVIEW_KEYS = ["id", "product", "author_name", "rating", "text", "created_at"] as const;

// The multipart field name POST /api/admin/products/:id/images reads.
export const ADMIN_IMAGE_UPLOAD_FIELD = "file";

// Same-origin: the Worker serves the frontend and the API. Anything absolute
// here means CORS is back on the table.
export const API_BASE = "/api";

// A payload shaped exactly like GET /api/products, fed to the real frontend in
// the jsdom test. The worker-side test proves the live API matches this shape,
// so rendering against it is not rendering against a fiction.
export const SAMPLE_PRODUCT = {
  id: 1,
  name: "Mechanical Keyboard",
  slug: "mechanical-keyboard",
  description: "Too loud for the office.",
  price: "129.90",
  stock: 11,
  is_active: true,
  category: { id: 1, name: "Peripherals", slug: "peripherals" },
  images: [{ id: 1, url: "/media/products/mechanical-keyboard.png", alt_text: "Mechanical Keyboard" }],
  avg_rating: 4.5,
  review_count: 2,
  created_at: "2026-07-09T18:00:55.000Z",
  updated_at: "2026-07-09T18:00:55.000Z",
};

export const SAMPLE_CATEGORY = { id: 1, name: "Peripherals", slug: "peripherals" };
