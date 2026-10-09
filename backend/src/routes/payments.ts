import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";

import { env } from "../config.js";
import { prisma } from "../lib/prisma.js";
import {
  createRazorpayOrder,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from "../lib/razorpay.js";
import { pushOrderToShiprocket } from "../lib/shiprocket-dispatch.js";
import { asyncHandler, HttpError, parseBody } from "../utils/http.js";
import { calculateShippingRate } from "../lib/shiprocket.js";
import { sendOrderConfirmation } from "../lib/notifications/features/orderConfirmation.js";
import { sendPaymentSuccess } from "../lib/notifications/features/paymentSuccess.js";
import { sendPaymentFailed } from "../lib/notifications/features/paymentFailed.js";

export const paymentsRouter = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────

const orderItemSchema = z.object({
  productSlug: z.string().min(1),
  quantity: z.number().int().min(1).default(1),
  selectedOptions: z.record(z.string(), z.string()).optional(),
  variantSummary: z.string().optional(),
});

const createOrderSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  phone: z.string().min(1),
  source: z.string().optional(),
  notes: z.string().optional(),
  items: z.array(orderItemSchema).min(1),
  // Shipping address. Required so Shiprocket can be pushed once payment
  // captures. Decision #34.
  shippingLine1: z.string().min(1).max(200),
  shippingLine2: z.string().max(200).optional(),
  shippingCity: z.string().min(1).max(80),
  shippingState: z.string().min(1).max(80),
  shippingPincode: z.string().regex(/^[0-9]{6}$/, "Indian pincode must be 6 digits"),
  shippingCountry: z.string().default("IN"),
});

const verifySchema = z.object({
  razorpay_order_id: z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

// ─── POST /public/payments/orders ─────────────────────────────────────────
//
// Creates a Razorpay order via Razorpay's REST API and persists a matching
// OrderRequest in `paymentStatus = CREATED`. The amount is recomputed from
// the database — the client never gets to set the price.

paymentsRouter.post(
  "/orders",
  asyncHandler(async (req, res) => {
    const payload = parseBody(createOrderSchema, req.body);
    const productSlugs = payload.items.map((item) => item.productSlug);

    const products = await prisma.product.findMany({
      where: { slug: { in: productSlugs }, workflowStatus: "PUBLISHED" },
    });
    if (products.length !== productSlugs.length) {
      throw new HttpError(400, "product_not_found");
    }
    const bySlug = new Map(products.map((product) => [product.slug, product]));
    
    const totalWeightGrams = payload.items.reduce((sum, line) => {
      const product = bySlug.get(line.productSlug);
      return sum + ((product?.weightGrams ?? 300) * (line.quantity ?? 1));
    }, 0);
    const maxLengthCm = Math.max(...products.map((p) => p.lengthCm ?? 15), 15);
    const maxBreadthCm = Math.max(...products.map((p) => p.breadthCm ?? 10), 10);
    const maxHeightCm = Math.max(...products.map((p) => p.heightCm ?? 8), 8);

    const result = await calculateShippingRate({
      pincode: payload.shippingPincode,
      weightKg: Math.max(totalWeightGrams / 1000, 0.1), // Convert grams to kg
      lengthCm: maxLengthCm,
      breadthCm: maxBreadthCm,
      heightCm: maxHeightCm,
    });

    // Product.priceAmount is whole rupees (Decision #20). Razorpay wants
    // paise (× 100). Compute server-side and reject zero/negative totals.
    const itemsSubtotalPaise = payload.items.reduce((sum, line) => {
      const product = bySlug.get(line.productSlug)!;
      const quantity = line.quantity ?? 1;
      return sum + product.priceAmount * 100 * quantity;
    }, 0);
    const totalAmountPaise = itemsSubtotalPaise + (result.rate ?? 0) * 100;
    if (totalAmountPaise <= 0) {
      throw new HttpError(400, "invalid_total");
    }

    const receipt = `seijaku_${crypto.randomBytes(8).toString("hex")}`;
    const razorpayOrder = await createRazorpayOrder({
      amountPaise: totalAmountPaise,
      receipt,
    });

    const orderRequest = await prisma.orderRequest.create({
      data: {
        email: payload.email,
        name: payload.name,
        phone: payload.phone,
        source: payload.source ?? "frontend-checkout",
        notes: payload.notes,
        razorpayOrderId: razorpayOrder.id,
        totalAmount: totalAmountPaise,
        currency: "INR",
        paymentStatus: "CREATED",
        shippingLine1: payload.shippingLine1,
        shippingLine2: payload.shippingLine2,
        shippingCity: payload.shippingCity,
        shippingState: payload.shippingState,
        shippingPincode: payload.shippingPincode,
        shippingCountry: payload.shippingCountry,
        items: {
          create: payload.items.map((item) => {
            const product = bySlug.get(item.productSlug)!;
            return {
              productId: product.id,
              quantity: item.quantity ?? 1,
              unitPriceAmount: product.priceAmount,
              selectedOptionsJson: item.selectedOptions ?? undefined,
              variantSummary: item.variantSummary,
            };
          }),
        },
      },
    });

    res.status(201).json({
      orderId: orderRequest.id,
      razorpayOrderId: razorpayOrder.id,
      amount: totalAmountPaise,
      currency: "INR",
      keyId: env.RAZORPAY_KEY_ID,
    });
  }),
);

// ─── POST /public/payments/verify ─────────────────────────────────────────
//
// Browser-callback fast path. Razorpay Checkout invokes the JS handler with
// (order_id, payment_id, signature); the browser POSTs that triple here.
// We HMAC-verify and flip the row to PAID. Idempotent against the webhook.

paymentsRouter.post(
  "/verify",
  asyncHandler(async (req, res) => {
    const payload = parseBody(verifySchema, req.body);

    if (
      !verifyCheckoutSignature(
        payload.razorpay_order_id,
        payload.razorpay_payment_id,
        payload.razorpay_signature,
      )
    ) {
      throw new HttpError(400, "invalid_signature");
    }

    const updated = await prisma.orderRequest.updateMany({
      where: {
        razorpayOrderId: payload.razorpay_order_id,
        paymentStatus: { in: ["CREATED", "FAILED"] },
      },
      data: {
        razorpayPaymentId: payload.razorpay_payment_id,
        razorpaySignature: payload.razorpay_signature,
        paymentStatus: "PAID",
      },
    });

    const orderRequest = await prisma.orderRequest.findUnique({
      where: { razorpayOrderId: payload.razorpay_order_id },
      select: { id: true, paymentStatus: true },
    });

    if (!orderRequest) {
      throw new HttpError(404, "order_not_found");
    }

    // Fire-and-forget Shiprocket push on the PAID transition. Decision
    // #34: never block payment confirmation on shipping. Admins can
    // retry from /admin/leads if this fails.
    if (updated.count > 0) {
      sendPaymentSuccess(orderRequest.id).catch((err) => {
        console.error("[payments/verify] payment success notification crashed", err);
      });

      pushOrderToShiprocket(orderRequest.id).catch((err) => {
        console.error("[payments/verify] shiprocket dispatch crashed", err);
      });

      sendOrderConfirmation(orderRequest.id).catch((err) => {
        console.error("[payments/verify] order confirmation crashed", err);
      });
    }

    res.json({
      status: orderRequest.paymentStatus,
      orderId: orderRequest.id,
      updatedNow: updated.count > 0,
    });
  }),
);

// ─── POST /public/payments/webhook ────────────────────────────────────────
//
// Inbound from Razorpay. Receives raw Buffer (registered in app.ts before
// express.json so the HMAC verifies against the exact bytes Razorpay
// signed). Idempotent on `paymentStatus` transitions; duplicate deliveries
// are no-op. Always returns 200 once persisted — failures are logged and
// re-delivery is Razorpay's responsibility.

type RazorpayWebhookPayment = {
  entity?: {
    id?: string;
    order_id?: string;
    [k: string]: unknown;
  };
};
type RazorpayWebhookBody = {
  event?: string;
  payload?: {
    payment?: RazorpayWebhookPayment;
    refund?: { entity?: { id?: string; payment_id?: string } };
  };
};

paymentsRouter.post(
  "/webhook",
  asyncHandler(async (req, res) => {
    const headerSig = req.header("x-razorpay-signature") ?? "";
    const rawBody = req.body as Buffer;

    if (!Buffer.isBuffer(rawBody)) {
      // Misconfigured middleware: webhook didn't receive raw bytes.
      console.error("[razorpay webhook] body is not a Buffer; check raw-body middleware ordering");
      throw new HttpError(500, "webhook_misconfigured");
    }

    if (!headerSig || !verifyWebhookSignature(rawBody, headerSig)) {
      throw new HttpError(400, "invalid_signature");
    }

    let body: RazorpayWebhookBody;
    try {
      body = JSON.parse(rawBody.toString("utf8")) as RazorpayWebhookBody;
    } catch {
      throw new HttpError(400, "invalid_json");
    }

    const event = body.event ?? "";
    const payment = body.payload?.payment?.entity;
    const orderId = payment?.order_id;
    const paymentId = payment?.id;

    // Conditional updates — duplicate deliveries become no-op.
    try {
      if (event === "payment.captured" && orderId && paymentId) {
        const updated = await prisma.orderRequest.updateMany({
          where: {
            razorpayOrderId: orderId,
            paymentStatus: { in: ["CREATED", "FAILED"] },
          },
          data: {
            razorpayPaymentId: paymentId,
            paymentStatus: "PAID",
          },
        });
        if (updated.count > 0) {
          const row = await prisma.orderRequest.findUnique({
            where: { razorpayOrderId: orderId },
            select: { id: true },
          });
          if (row) {
            sendPaymentSuccess(row.id).catch((err) => {
              console.error("[payments/verify] payment success notification crashed", err);
            });

            // Fire-and-forget Shiprocket push. Webhook ack returns 200
            // regardless of dispatch outcome — Decision #34.
            pushOrderToShiprocket(row.id).catch((err) => {
              console.error("[payments/webhook] shiprocket dispatch crashed", err);
            });

            sendOrderConfirmation(row.id).catch((err) => {
              console.error("[payments/webhook] order confirmation crashed", err);
            });
          }
        }
      } else if (event === "payment.failed" && orderId) {
        await prisma.orderRequest.updateMany({
          where: {
            razorpayOrderId: orderId,
            paymentStatus: "CREATED",
          },
          data: {
            razorpayPaymentId: paymentId ?? undefined,
            paymentStatus: "FAILED",
          },
        });

        sendPaymentFailed(orderId, body.payload?.payment?.entity?.error_description as string).catch((err) => {
          console.error("[payments/webhook] payment failed notification crashed", err);
        });
        
      } else if (event === "refund.processed") {
        const refundPaymentId = body.payload?.refund?.entity?.payment_id;
        if (refundPaymentId) {
          await prisma.orderRequest.updateMany({
            where: {
              razorpayPaymentId: refundPaymentId,
              paymentStatus: "PAID",
            },
            data: { paymentStatus: "REFUNDED" },
          });
        }
      } else {
        // Unrecognized event — ack 200 so Razorpay doesn't retry forever.
        console.warn("[razorpay webhook] ignoring event", event);
      }
    } catch (err) {
      // Persist failure logged; ack 200 anyway? No — let Razorpay retry on
      // genuine DB errors. 5xx triggers their backoff.
      console.error("[razorpay webhook] persist error", err);
      throw new HttpError(500, "webhook_persist_error");
    }

    res.json({ ok: true });
  }),
);

// ─── GET /public/payments/orders/:id ──────────────────────────────────────
//
// Read-only by id, used by the order-confirmed page so the client can
// display masked payment id + total without a second authenticated path.
// Returns no PII (no email/name/notes).

paymentsRouter.get(
  "/orders/:id",
  asyncHandler(async (req, res) => {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!id) throw new HttpError(400, "missing_id");

    const order = await prisma.orderRequest.findUnique({
      where: { id },
      select: {
        id: true,
        paymentStatus: true,
        totalAmount: true,
        currency: true,
        razorpayPaymentId: true,
      },
    });
    if (!order) throw new HttpError(404, "order_not_found");

    res.json({ item: order });
  }),
);
