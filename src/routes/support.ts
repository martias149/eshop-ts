import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import Anthropic, { APIError, RateLimitError } from "@anthropic-ai/sdk";
import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq, like, or } from "drizzle-orm";
import type { Bindings } from "../types";
import {
  authTokens,
  categories,
  coupons,
  orderItems,
  orders,
  payments,
  products,
  users,
  type UserRow,
} from "../db/schema";
import { centsToStr } from "../lib/money";
import { isCouponValidNow } from "../lib/coupons";
import { chatScopeLimit } from "../lib/rate-limit";

const MODEL = "claude-haiku-4-5";
const MAX_HISTORY_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 4000;
const MAX_TOOL_ITERATIONS = 5;

const SYSTEM_PROMPT = `You are the support chat assistant for "eshop", an online store selling electronics accessories.

Facts about the shop that are always true and must never be contradicted:
- Shipping is CZ-only (Czech Republic only), takes 3-5 business days, and is free on orders over 1000 CZK.
- Returns are accepted within 30 days of delivery.
- Payment is by card via Stripe.
- A customer can cancel their own order only while its status is "pending" or "paid".
- All product prices are in EUR.

Rules you must follow:
- Only state prices, stock levels, order details, or coupon validity that come from a tool result in this conversation. Never invent or guess a price, stock count, order status, or coupon value.
- If someone who is not signed in asks about an order, ask them for the order's UUID so you can look it up with get_order_status.
- If a request has nothing to do with this shop (general chit-chat, coding help, unrelated companies, etc.), politely decline and steer the conversation back to how you can help with the shop.
- Keep your answers concise.
- Always reply in the same language the customer is writing in.`;

type HistoryEntry = { role: "user" | "assistant"; content: string };

type Db = ReturnType<typeof drizzle>;

type Env = { Bindings: Bindings; Variables: { user?: UserRow } };

const TOOL_GET_ORDER_STATUS: Anthropic.Tool = {
  name: "get_order_status",
  description:
    "Look up a single order by its UUID id. Returns its status, created date, line items, subtotal, discount, total, and payment info. Use this whenever a customer asks about a specific order they can identify by id.",
  input_schema: {
    type: "object",
    properties: {
      order_id: {
        type: "string",
        description: "The order's UUID, exactly as given to the customer at checkout.",
      },
    },
    required: ["order_id"],
  },
};

const TOOL_SEARCH_PRODUCTS: Anthropic.Tool = {
  name: "search_products",
  description:
    "Search active products by name or description (case-insensitive). Returns up to 5 matches with price, stock availability, and category. Use this to answer questions about what the shop sells, prices, or availability.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Free-text search term, e.g. a product name or keyword.",
      },
    },
    required: ["query"],
  },
};

const TOOL_CHECK_COUPON: Anthropic.Tool = {
  name: "check_coupon",
  description:
    "Check whether a discount coupon code is currently valid, and if so its discount type and value. Use this whenever a customer asks about a coupon or promo code.",
  input_schema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "The coupon code to check, exactly as given by the customer.",
      },
    },
    required: ["code"],
  },
};

const TOOL_LIST_MY_ORDERS: Anthropic.Tool = {
  name: "list_my_orders",
  description:
    "List the signed-in customer's 5 most recent orders (id, status, total, created date). Use this when the customer asks about 'my orders' without naming a specific order id.",
  input_schema: {
    type: "object",
    properties: {},
  },
};

async function toolGetOrderStatus(db: Db, rawOrderId: unknown): Promise<unknown> {
  if (typeof rawOrderId !== "string" || rawOrderId.length === 0) {
    return { error: "no order with that id" };
  }

  const order = await db.select().from(orders).where(eq(orders.id, rawOrderId)).get();
  if (!order) {
    return { error: "no order with that id" };
  }

  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  const payment = await db.select().from(payments).where(eq(payments.orderId, order.id)).get();

  return {
    status: order.status,
    created: new Date(order.createdAt * 1000).toISOString(),
    items: items.map((item) => ({
      product: item.productName,
      quantity: item.quantity,
      price: centsToStr(item.priceCents),
    })),
    subtotal: centsToStr(order.subtotalCents),
    discount: centsToStr(order.discountAmountCents),
    total: centsToStr(order.totalCents),
    payment: payment ? { provider: payment.provider, amount: centsToStr(payment.amountCents) } : null,
  };
}

async function toolSearchProducts(db: Db, rawQuery: unknown): Promise<unknown> {
  const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
  if (!query) {
    return { results: [], note: "no matching products" };
  }

  const pattern = `%${query}%`;
  const rows = await db
    .select({ product: products, categoryName: categories.name })
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .where(
      and(eq(products.isActive, true), or(like(products.name, pattern), like(products.description, pattern))),
    )
    .limit(5);

  if (rows.length === 0) {
    return { results: [], note: "no matching products" };
  }

  return {
    results: rows.map((row) => ({
      name: row.product.name,
      price: centsToStr(row.product.priceCents),
      in_stock: row.product.stock > 0,
      category: row.categoryName ?? null,
    })),
  };
}

async function toolCheckCoupon(db: Db, rawCode: unknown): Promise<unknown> {
  if (typeof rawCode !== "string" || rawCode.length === 0) {
    return { valid: false };
  }

  const coupon = await db.select().from(coupons).where(eq(coupons.code, rawCode)).get();
  if (!coupon || !isCouponValidNow(coupon, Math.floor(Date.now() / 1000))) {
    return { valid: false };
  }

  return {
    valid: true,
    discount_type: coupon.discountType,
    value: centsToStr(coupon.valueHundredths),
  };
}

async function toolListMyOrders(db: Db, user: UserRow): Promise<unknown> {
  const rows = await db
    .select()
    .from(orders)
    .where(eq(orders.userId, user.id))
    .orderBy(desc(orders.createdAt))
    .limit(5);

  return rows.map((order) => ({
    id: order.id,
    status: order.status,
    total: centsToStr(order.totalCents),
    created: new Date(order.createdAt * 1000).toISOString(),
  }));
}

async function executeTool(db: Db, user: UserRow | undefined, name: string, input: unknown): Promise<unknown> {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "get_order_status":
        return await toolGetOrderStatus(db, args.order_id);
      case "search_products":
        return await toolSearchProducts(db, args.query);
      case "check_coupon":
        return await toolCheckCoupon(db, args.code);
      case "list_my_orders":
        if (!user) return { error: "not authenticated" };
        return await toolListMyOrders(db, user);
      default:
        return { error: `unknown tool: ${name}` };
    }
  } catch {
    return { error: "internal error looking that up" };
  }
}

function isValidHistoryEntry(entry: unknown): entry is HistoryEntry {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  return (
    (e.role === "user" || e.role === "assistant") &&
    typeof e.content === "string" &&
    e.content.length <= MAX_MESSAGE_CHARS
  );
}

const optionalAuth = createMiddleware<Env>(async (c, next) => {
  const header = c.req.header("Authorization");
  const match = header?.match(/^Token (.+)$/);
  if (match) {
    const db = drizzle(c.env.DB);
    const rows = await db
      .select({ user: users })
      .from(authTokens)
      .innerJoin(users, eq(authTokens.userId, users.id))
      .where(eq(authTokens.key, match[1]))
      .limit(1);

    const user = rows[0]?.user;
    if (user && user.isActive) {
      c.set("user", user);
    }
  }
  await next();
});

const app = new Hono<Env>();

app.post("/chat", optionalAuth, chatScopeLimit, async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ detail: "support chat is not configured" }, 503);
  }

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;

  const message = body?.message;
  if (typeof message !== "string" || message.length === 0 || message.length > MAX_MESSAGE_CHARS) {
    return c.json({ errors: { message: "message required" } }, 400);
  }

  const rawHistory = body?.history ?? [];
  if (
    !Array.isArray(rawHistory) ||
    rawHistory.length > MAX_HISTORY_MESSAGES ||
    !rawHistory.every(isValidHistoryEntry)
  ) {
    return c.json({ errors: { history: "malformed history" } }, 400);
  }
  const history = rawHistory as HistoryEntry[];

  const db = drizzle(c.env.DB);
  const user = c.get("user");

  const tools: Anthropic.Tool[] = [TOOL_GET_ORDER_STATUS, TOOL_SEARCH_PRODUCTS, TOOL_CHECK_COUPON];
  if (user) {
    tools.push(TOOL_LIST_MY_ORDERS);
  }

  const anthropic = new Anthropic({ apiKey: c.env.ANTHROPIC_API_KEY });

  const conversation: Anthropic.MessageParam[] = [
    ...history.map((entry): Anthropic.MessageParam => ({ role: entry.role, content: entry.content })),
    { role: "user", content: message },
  ];

  let finalResponse: Anthropic.Message;
  try {
    let iterations = 0;
    for (;;) {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools,
        messages: conversation,
      });
      finalResponse = response;
      iterations++;

      if (response.stop_reason !== "tool_use" || iterations >= MAX_TOOL_ITERATIONS) {
        break;
      }

      conversation.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const result = await executeTool(db, user, block.name, block.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      conversation.push({ role: "user", content: toolResults });
    }
  } catch (err) {
    if (err instanceof RateLimitError) {
      return c.json({ detail: "assistant is busy, try again shortly" }, 503);
    }
    if (err instanceof APIError) {
      return c.json({ detail: "assistant unavailable" }, 502);
    }
    throw err;
  }

  const reply = finalResponse.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  return c.json({
    reply,
    history: [...history, { role: "user", content: message }, { role: "assistant", content: reply }],
  });
});

export default app;
