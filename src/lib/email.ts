// Transactional order emails via Cloudflare Email Sending. Like MEDIA/R2 and
// Stripe, the EMAIL binding is optional: without it (or without EMAIL_FROM, or
// with a blank order email) sends are skipped and the order flow is unaffected.
// A failed send is logged, never surfaced to the customer.
import type { OrderItemRow, OrderRow } from "../db/schema";
import type { Bindings } from "../types";
import { centsToStr } from "./money";

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function itemLines(items: OrderItemRow[]): string[] {
  return items.map((it) => `${it.quantity}x ${it.productName} — ${centsToStr(it.priceCents * it.quantity)}`);
}

function itemRowsHtml(items: OrderItemRow[]): string {
  return items
    .map(
      (it) =>
        `<tr><td>${it.quantity}x ${escapeHtml(it.productName)}</td>` +
        `<td style="text-align:right">${centsToStr(it.priceCents * it.quantity)}</td></tr>`,
    )
    .join("");
}

export function orderConfirmationEmail(order: OrderRow, items: OrderItemRow[]): EmailContent {
  const greeting = order.fullName ? `Hi ${order.fullName},` : "Hi,";
  const discountLine = order.discountAmountCents > 0 ? `\nDiscount: -${centsToStr(order.discountAmountCents)}` : "";
  const text = [
    greeting,
    "",
    `Thanks for your order! We received your payment of ${centsToStr(order.totalCents)}.`,
    "",
    ...itemLines(items),
    "",
    `Subtotal: ${centsToStr(order.subtotalCents)}${discountLine}`,
    `Total: ${centsToStr(order.totalCents)}`,
    "",
    `Order ID: ${order.id}`,
  ].join("\n");

  const discountRow =
    order.discountAmountCents > 0
      ? `<tr><td>Discount</td><td style="text-align:right">-${centsToStr(order.discountAmountCents)}</td></tr>`
      : "";
  const html =
    `<p>${escapeHtml(greeting)}</p>` +
    `<p>Thanks for your order! We received your payment of <strong>${centsToStr(order.totalCents)}</strong>.</p>` +
    `<table>${itemRowsHtml(items)}` +
    `<tr><td>Subtotal</td><td style="text-align:right">${centsToStr(order.subtotalCents)}</td></tr>${discountRow}` +
    `<tr><td><strong>Total</strong></td><td style="text-align:right"><strong>${centsToStr(order.totalCents)}</strong></td></tr></table>` +
    `<p>Order ID: ${escapeHtml(order.id)}</p>`;

  return { subject: `Order confirmed — ${centsToStr(order.totalCents)}`, text, html };
}

export function orderShippedEmail(order: OrderRow, items: OrderItemRow[]): EmailContent {
  const greeting = order.fullName ? `Hi ${order.fullName},` : "Hi,";
  const address = [order.street, `${order.zipCode} ${order.city}`.trim(), order.country].filter(Boolean);
  const text = [
    greeting,
    "",
    "Good news — your order is on its way!",
    "",
    ...itemLines(items),
    "",
    ...(address.length > 1 ? ["Shipping to:", ...address, ""] : []),
    `Order ID: ${order.id}`,
  ].join("\n");

  const html =
    `<p>${escapeHtml(greeting)}</p>` +
    `<p>Good news — your order is on its way!</p>` +
    `<table>${itemRowsHtml(items)}</table>` +
    (address.length > 1 ? `<p>Shipping to:<br>${address.map(escapeHtml).join("<br>")}</p>` : "") +
    `<p>Order ID: ${escapeHtml(order.id)}</p>`;

  return { subject: "Your order has shipped", text, html };
}

export async function sendOrderEmail(env: Bindings, order: OrderRow, content: EmailContent): Promise<void> {
  if (!env.EMAIL || !env.EMAIL_FROM || !order.email) return;
  try {
    await env.EMAIL.send({
      from: { email: env.EMAIL_FROM, name: "Eshop" },
      to: order.email,
      subject: content.subject,
      text: content.text,
      html: content.html,
    });
  } catch (err) {
    console.error(`order email failed for ${order.id}:`, err);
  }
}
