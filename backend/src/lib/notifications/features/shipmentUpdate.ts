import { buildShipmentStageParams, type ShipmentStage } from "../../email/builders/shipmentStage.js";
import { sendShipmentUpdateEmail } from "../../email/notifire.js";
import { prisma } from "../../prisma.js";
import { notifyOnce } from "../notifyOnce.js";


export async function sendShipmentUpdate(orderId: string, stage: ShipmentStage) {
    const order = await prisma.orderRequest.findUnique({
        where: { id: orderId },
    });

    if (!order) {
        console.warn(`Order not found: ${orderId}`);
        return null;
    }

    if (!order.awbCode) {
        console.warn(`Order ${orderId} has no AWB code yet, skipping shipment update`);
        return null;
    }

    return notifyOnce({
        subjectId: order.id,
        orderId  : order.id,
        recipient: order.email,
        channel  : "EMAIL",
        type     : stage,
        variant  : order.awbCode,   // ← per-AWB dedup for multi-package orders
        send     : async () => {
            const result = await sendShipmentUpdateEmail(
                { email: order.email, name: order.name },
                buildShipmentStageParams({
                    orderId          : order.id,
                    customerName     : order.name,
                    customerEmail    : order.email,
                    courier          : order.courierName ?? "Courier",
                    awb              : order.awbCode!,
                    trackingUrl      : order.trackingUrl ?? `https://shiprocket.co/tracking/${order.awbCode}`,
                    estimatedDelivery: undefined,   // add column if you want to pass ETA
                    stage,
                })
            );
            return { providerId: result.messageId };
        },
    });
}