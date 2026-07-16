import { describe, expect, it, vi } from "vitest";
import { orderConfirmationEmail, orderShippedEmail, sendOrderEmail } from "../src/lib/email";
import type { OrderItemRow, OrderRow } from "../src/db/schema";
import type { Bindings } from "../src/types";

function makeOrder(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    userId: null,
    status: "paid",
    email: "buyer@example.com",
    fullName: "Jane Doe",
    street: "Main St 1",
    city: "Prague",
    zipCode: "110 00",
    country: "CZ",
    couponId: null,
    subtotalCents: 12990,
    discountAmountCents: 0,
    totalCents: 12990,
    paymentIntentId: null,
    createdAt: 1_752_500_000,
    updatedAt: 1_752_500_000,
    ...overrides,
  };
}

function makeItem(overrides: Partial<OrderItemRow> = {}): OrderItemRow {
  return {
    id: 1,
    orderId: "11111111-2222-3333-4444-555555555555",
    productId: 1,
    productName: "Mechanical Keyboard",
    priceCents: 12990,
    quantity: 1,
    ...overrides,
  };
}

describe("order emails", () => {
  it("confirmation includes items, total, and order id", () => {
    const content = orderConfirmationEmail(makeOrder(), [makeItem()]);
    expect(content.subject).toBe("Order confirmed — 129.90");
    expect(content.text).toContain("Hi Jane Doe,");
    expect(content.text).toContain("1x Mechanical Keyboard — 129.90");
    expect(content.text).toContain("Total: 129.90");
    expect(content.text).toContain("11111111-2222-3333-4444-555555555555");
    expect(content.html).toContain("129.90");
  });

  it("confirmation shows a discount line only when discounted", () => {
    const plain = orderConfirmationEmail(makeOrder(), [makeItem()]);
    expect(plain.text).not.toContain("Discount");

    const discounted = orderConfirmationEmail(
      makeOrder({ subtotalCents: 12990, discountAmountCents: 1299, totalCents: 11691 }),
      [makeItem()],
    );
    expect(discounted.text).toContain("Discount: -12.99");
    expect(discounted.text).toContain("Total: 116.91");
  });

  it("greets generically when the order has no name and escapes html", () => {
    const content = orderConfirmationEmail(makeOrder({ fullName: "" }), [
      makeItem({ productName: '<img src=x onerror="x">' }),
    ]);
    expect(content.text).toContain("Hi,");
    expect(content.html).not.toContain("<img");
    expect(content.html).toContain("&lt;img");
  });

  it("shipped email includes the address when present", () => {
    const content = orderShippedEmail(makeOrder(), [makeItem()]);
    expect(content.subject).toBe("Your order has shipped");
    expect(content.text).toContain("Main St 1");
    expect(content.text).toContain("110 00 Prague");
  });

  it("shipped email omits the address block for an empty address", () => {
    const content = orderShippedEmail(makeOrder({ street: "", city: "", zipCode: "" }), [makeItem()]);
    expect(content.text).not.toContain("Shipping to:");
  });

  it("sendOrderEmail is a no-op without the EMAIL binding, EMAIL_FROM, or a recipient", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const content = orderConfirmationEmail(makeOrder(), [makeItem()]);

    await sendOrderEmail({} as Bindings, makeOrder(), content);
    await sendOrderEmail({ EMAIL: { send } } as unknown as Bindings, makeOrder(), content);
    await sendOrderEmail(
      { EMAIL: { send }, EMAIL_FROM: "orders@example.com" } as unknown as Bindings,
      makeOrder({ email: "" }),
      content,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("sendOrderEmail sends when configured and swallows send failures", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = { EMAIL: { send }, EMAIL_FROM: "orders@example.com" } as unknown as Bindings;
    const content = orderConfirmationEmail(makeOrder(), [makeItem()]);

    await sendOrderEmail(env, makeOrder(), content);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "buyer@example.com",
        from: { email: "orders@example.com", name: "Eshop" },
        subject: content.subject,
      }),
    );

    send.mockRejectedValueOnce(new Error("boom"));
    await expect(sendOrderEmail(env, makeOrder(), content)).resolves.toBeUndefined();
  });
});
