import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { env } from "../config.js";
import type { ShipmentStatus } from "@prisma/client";
import { ShipmentStage } from "./email/builders/shipmentStage.js";
import { sendShipmentUpdate } from "./notifications/features/shipmentUpdate.js";

// Shiprocket's current_status values
const STAGE_BY_STATUS: Record<string, ShipmentStage> = {
    "PICKED UP"       : "SHIPMENT_PICKED_UP",
    "IN TRANSIT"      : "SHIPMENT_IN_TRANSIT",
    "OUT FOR DELIVERY": "SHIPMENT_OUT_FOR_DELIVERY",
    "DELIVERED"       : "SHIPMENT_DELIVERED",
    "RTO INITIATED"   : "SHIPMENT_RTO",
    "RTO DELIVERED"   : "SHIPMENT_RTO",
    "UNDELIVERED"     : "SHIPMENT_FAILED",
    "NDR"             : "SHIPMENT_FAILED",
    "LOST"            : "SHIPMENT_FAILED",
};

// Maps a ShipmentStage to the corresponding ShipmentStatus enum value in the database.
// This is used to persist the latest shipment state for idempotency and auditing.
function mapStageToShipmentStatus(stage: ShipmentStage): ShipmentStatus {
    switch (stage) {
        case "SHIPMENT_PICKED_UP"       : return "PICKED_UP";
        case "SHIPMENT_IN_TRANSIT"      : return "IN_TRANSIT";
        case "SHIPMENT_OUT_FOR_DELIVERY": return "OUT_FOR_DELIVERY";
        case "SHIPMENT_DELIVERED"       : return "DELIVERED";
        case "SHIPMENT_RTO"             : return "RTO";
        case "SHIPMENT_FAILED"          : return "FAILED";
    }
}

//  Typed webhook payload (based on documented Shiprocket fields) 
interface ShiprocketWebhookBody {
    event             ?: string;
    current_status    ?: string;
    awb               ?: string;
    order_id          ?: string; // Shiprocket's internal order ID
    courier_name      ?: string;
    tracking_url      ?: string;
    estimated_delivery?: string;
    scans             ?: Array<{ date: string; activity: string; location?: string }>;
    [key: string]      : unknown;
}

//  Handler 
export async function shiprocketWebhookHandler(req: Request, res: Response) {
    
    // Verify the x-api-key token (as per docs)
    const incomingToken = req.header("x-api-key") ?? "";
    const expectedToken = env.SHIPROCKET_WEBHOOK_SECRET;

    if (!expectedToken || incomingToken !== expectedToken) {
        console.warn("[shiprocket webhook] unauthorized: invalid x-api-key");
        res.status(401).json({ ok: false, error: "unauthorized" });
        return;
    }

    // 2. Parse the raw body (middleware must provide Buffer)
    let body: ShiprocketWebhookBody;
    try {
        const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : JSON.stringify(req.body);
        body = JSON.parse(raw);
    } catch {
        console.warn("[shiprocket webhook] invalid JSON");
        res.status(400).json({ ok: false, error: "invalid_json" });
        return;
    }

    //  Resolve the event. Shiprocket sends `event` or `current_status`.
    const eventName = (body.event ?? body.current_status ?? "").toUpperCase().trim();
    const stage     = STAGE_BY_STATUS[eventName];

    if (!stage) {
        console.log(`[shiprocket webhook] ignored event: "${eventName}"`);
        res.status(200).json({ ok: true, ignored: true });
        return;
    }

    console.log(stage);

    // Locate the order by AWB or Shiprocket Order ID
    const awb               = body.awb;
    const shiprocketOrderId = body.order_id;

    if (!awb && !shiprocketOrderId) {
        console.warn("[shiprocket webhook] missing awb and order_id");
        res.status(200).json({ ok: true, ignored: true });
        return;
    }

    // Find the order in our database
    const order = await prisma.orderRequest.findFirst({
        where: {
            OR: [
                ...(awb ? [{ awbCode: awb }] : []),
                ...(shiprocketOrderId ? [{ shiprocketOrderId: String(shiprocketOrderId) }] : []),
            ],
        },
    });

    if (!order) {
        console.warn(`[shiprocket webhook] order not found for awb=${awb} id=${shiprocketOrderId}`);
        res.status(200).json({ ok: true, ignored: true });
        return;
    }

    // Persist the latest shipment state (for idempotency and auditing)
    await prisma.orderRequest.update({
        where: { id: order.id },
        data: {
            ...(awb && { awbCode: awb }),
            ...(body.courier_name && { courierName: body.courier_name }),
            ...(body.tracking_url && { trackingUrl: body.tracking_url }),
            shipmentStatus: mapStageToShipmentStatus(stage),
            shipmentPushedAt: order.shipmentPushedAt ?? new Date(),
        },
    });

    // Fire the notification (fire-and-forget). Dedup is handled internally.
    sendShipmentUpdate(order.id, stage).catch((err) => {
        console.error("[shiprocket webhook] notification crashed", err);
    });

    res.status(200).json({ ok: true });
}