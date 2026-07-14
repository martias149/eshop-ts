import { describe, expect, it } from "vitest";
import { discountForCents, isCouponValidNow } from "../src/lib/coupons";
import { centsToStr, strToCents } from "../src/lib/money";
import { hashPassword, verifyPassword } from "../src/lib/hash";
import type { CouponRow } from "../src/db/schema";

function makeCoupon(overrides: Partial<CouponRow> = {}): CouponRow {
  return {
    id: 1,
    code: "TEST",
    discountType: "percent",
    valueHundredths: 1000,
    isActive: true,
    validFrom: null,
    validTo: null,
    ...overrides,
  };
}

const DAY = 24 * 60 * 60;

describe("coupons", () => {
  it("percent discount rounds to the nearest cent", () => {
    const coupon = makeCoupon({ discountType: "percent", valueHundredths: 1000 }); // 10%
    expect(discountForCents(coupon, 30970)).toBe(3097); // 10% of 309.70 -> 30.97
  });

  it("percent discount of a round subtotal", () => {
    const coupon = makeCoupon({ discountType: "percent", valueHundredths: 1000 }); // 10%
    expect(discountForCents(coupon, 10000)).toBe(1000); // 10% of 100.00 -> 10.00
  });

  it("fixed discount is capped at the subtotal, total never goes negative", () => {
    const coupon = makeCoupon({ discountType: "fixed", valueHundredths: 5000 }); // 50.00
    const subtotalCents = 2000; // 20.00
    const discount = discountForCents(coupon, subtotalCents);
    expect(discount).toBe(subtotalCents);
    expect(subtotalCents - discount).toBe(0);
    expect(subtotalCents - discount).toBeGreaterThanOrEqual(0);
  });

  it("fixed discount below the subtotal applies in full", () => {
    const coupon = makeCoupon({ discountType: "fixed", valueHundredths: 500 }); // 5.00
    expect(discountForCents(coupon, 2000)).toBe(500); // 20.00 -> 5.00 off
  });

  it("100% off equals the full subtotal", () => {
    const coupon = makeCoupon({ discountType: "percent", valueHundredths: 10000 }); // 100%
    expect(discountForCents(coupon, 1234)).toBe(1234);
  });

  it("is invalid when is_active is false", () => {
    const coupon = makeCoupon({ isActive: false });
    expect(isCouponValidNow(coupon, 1_000_000)).toBe(false);
  });

  it("is invalid when valid_from is in the future", () => {
    const now = 1_000_000;
    const coupon = makeCoupon({ validFrom: now + DAY });
    expect(isCouponValidNow(coupon, now)).toBe(false);
  });

  it("is invalid when valid_to is in the past", () => {
    const now = 1_000_000;
    const coupon = makeCoupon({ validTo: now - DAY });
    expect(isCouponValidNow(coupon, now)).toBe(false);
  });

  it("is valid inside the valid_from/valid_to window", () => {
    const now = 1_000_000;
    const coupon = makeCoupon({ validFrom: now - DAY, validTo: now + DAY });
    expect(isCouponValidNow(coupon, now)).toBe(true);
  });
});

describe("money", () => {
  it.each([
    [0, "0.00"],
    [1, "0.01"],
    [5, "0.05"],
    [100, "1.00"],
    [1234, "12.34"],
    [30970, "309.70"],
    [999999, "9999.99"],
  ])("round-trips %i cents <-> %s", (cents, str) => {
    expect(centsToStr(cents)).toBe(str);
    expect(strToCents(str)).toBe(cents);
    expect(strToCents(centsToStr(cents))).toBe(cents);
  });

  it("strToCents rounds fractional-cent input", () => {
    expect(strToCents("19.999")).toBe(2000);
    expect(strToCents("0.004")).toBe(0);
    expect(strToCents("0.005")).toBe(1);
  });
});

describe("hash", () => {
  const ITERATIONS = 100;

  it("verifies the correct password and rejects a wrong one", async () => {
    const stored = await hashPassword("correct-horse-battery-staple", ITERATIONS);
    expect(await verifyPassword("correct-horse-battery-staple", stored)).toBe(true);
    expect(await verifyPassword("wrong-password", stored)).toBe(false);
  });

  it("salts each hash uniquely, even for the same password", async () => {
    const a = await hashPassword("same-password", ITERATIONS);
    const b = await hashPassword("same-password", ITERATIONS);
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });
});
