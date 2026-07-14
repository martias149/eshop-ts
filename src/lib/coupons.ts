import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { coupons, type CouponRow } from "../db/schema";

export async function findCouponByCode<T extends Record<string, unknown>>(
  db: DrizzleD1Database<T>,
  code: string,
): Promise<CouponRow | undefined> {
  const trimmed = code.trim();
  if (trimmed === "") return undefined;

  return db
    .select()
    .from(coupons)
    .where(sql`lower(${coupons.code}) = lower(${trimmed})`)
    .get();
}

export function isCouponValidNow(coupon: CouponRow, nowUnixSeconds: number): boolean {
  if (!coupon.isActive) return false;
  if (coupon.validFrom !== null && nowUnixSeconds < coupon.validFrom) return false;
  if (coupon.validTo !== null && nowUnixSeconds > coupon.validTo) return false;
  return true;
}

export function discountForCents(coupon: CouponRow, subtotalCents: number): number {
  let discount: number;
  if (coupon.discountType === "percent") {
    // Half-to-even on an exact half-cent tie, matching the Decimal.quantize
    // default the Django original rounded with. Integer arithmetic throughout,
    // so the tie is detected exactly rather than through a float comparison.
    const numerator = subtotalCents * coupon.valueHundredths;
    const quotient = Math.floor(numerator / 10000);
    const remainder = numerator - quotient * 10000;

    if (remainder * 2 > 10000) discount = quotient + 1;
    else if (remainder * 2 < 10000) discount = quotient;
    else discount = quotient % 2 === 0 ? quotient : quotient + 1;
  } else {
    discount = coupon.valueHundredths;
  }
  return Math.min(Math.max(discount, 0), subtotalCents);
}
