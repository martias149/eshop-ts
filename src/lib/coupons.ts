import type { CouponRow } from "../db/schema";

export function isCouponValidNow(coupon: CouponRow, nowUnixSeconds: number): boolean {
  if (!coupon.isActive) return false;
  if (coupon.validFrom !== null && nowUnixSeconds < coupon.validFrom) return false;
  if (coupon.validTo !== null && nowUnixSeconds > coupon.validTo) return false;
  return true;
}

export function discountForCents(coupon: CouponRow, subtotalCents: number): number {
  let discount: number;
  if (coupon.discountType === "percent") {
    discount = Math.round((subtotalCents * coupon.valueHundredths) / 10000);
  } else {
    discount = coupon.valueHundredths;
  }
  return Math.min(Math.max(discount, 0), subtotalCents);
}
