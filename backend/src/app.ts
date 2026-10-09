import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import express from "express";
import morgan from "morgan";

import { env } from "./config.js";
import { adminRouter } from "./routes/admin.js";
import { customerRouter } from "./routes/customer.js";
import { paymentsRouter } from "./routes/payments.js";
import { publicRouter } from "./routes/public.js";
import { errorMiddleware } from "./utils/http.js";
import { shiprocketWebhookHandler } from "./lib/shiprocket.webhook.js";

export const app = express();

app.use(
  cors({
    origin: env.CORS_ORIGIN ? env.CORS_ORIGIN.split(",").map((entry) => entry.trim()) : true,
    credentials: true,
  })
);
// Razorpay signs the RAW request body for webhooks. Register the raw-body
// middleware ONLY for the webhook path BEFORE the global json parser so
// the signature verifies against the exact bytes Razorpay signed.
app.use("/payments/webhook", express.raw({ type: "application/json", limit: "1mb" }));
app.use("/shiprocket/webhook", express.raw({ type: "application/json", limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

const uploadDir = path.resolve(process.cwd(), env.LOCAL_UPLOAD_DIR);
fs.mkdirSync(uploadDir, { recursive: true });
app.use("/uploads", express.static(uploadDir));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post(
  "/webhooks/shipment",
  express.raw({ type: "application/json" }),
  shiprocketWebhookHandler,
);

app.use(publicRouter);
app.use("/customer", customerRouter);
app.use("/payments", paymentsRouter);
app.use("/admin", adminRouter);
app.use(errorMiddleware);

