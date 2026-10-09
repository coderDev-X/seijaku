import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(4001),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(8),
  ADMIN_EMAIL: z.string().email().default("admin@seijaku.local"),
  ADMIN_PASSWORD: z.string().min(8).default("password123"),
  CORS_ORIGIN: z.string().optional(),
  LOCAL_UPLOAD_DIR: z.string().default("uploads"),
  PUBLIC_BASE_URL: z.string().url().optional(),
  ADMIN_NOTIFICATION_EMAIL: z.string().optional(),
  NOTIFIER_FROM_EMAIL: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  // Razorpay payments. All three required so the backend refuses to start
  // without them — payments must not silently no-op in any environment
  // that runs the payments router.
  RAZORPAY_KEY_ID: z.string().min(1),
  RAZORPAY_KEY_SECRET: z.string().min(1),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1),
  // Shiprocket credentials. The API has no key-based auth — email +
  // password are exchanged for a ~10-day JWT (cached in
  // src/lib/shiprocket.ts). Required at boot so misconfiguration fails
  // fast instead of silently no-op on first payment success.
  SHIPROCKET_EMAIL: z.string().email(),
  SHIPROCKET_PASSWORD: z.string().min(1),
  SHIPROCKET_WEBHOOK_SECRET: z.string().min(1),

  ABANDON_AFTER_HOURS: z.coerce.number().default(2),

  // Brevo api key.
  BREVO_API_KEY: z.string().min(1),
  // Brevo template IDs.
  BREVO_TPL_ORDER_CONFIRMATION: z.coerce.number(),
  BREVO_TPL_PAYMENT_SUCCESS: z.coerce.number(),
  BREVO_TPL_PAYMENT_FAILED: z.coerce.number(),
  BREVO_TPL_SHIPMENT_UPDATE: z.coerce.number(),
  BREVO_TPL_ABANDONED_CART: z.coerce.number(),

});

export const env = envSchema.parse(process.env);
