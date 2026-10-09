import { env } from "../../../config.js";
import type { NotificationType } from "@prisma/client";

// Only these NotificationType values are valid shipment stages.
export const SHIPMENT_STAGES = [
    "SHIPMENT_PICKED_UP",
    "SHIPMENT_IN_TRANSIT",
    "SHIPMENT_OUT_FOR_DELIVERY",
    "SHIPMENT_DELIVERED",
    "SHIPMENT_RTO",
    "SHIPMENT_FAILED",
] as const;

export type ShipmentStage = (typeof SHIPMENT_STAGES)[number];

// Compile-time guarantee that every ShipmentStage is a real NotificationType
const _assertSubset: ShipmentStage extends NotificationType ? true : never = true;

const STAGE_COPY: Record<ShipmentStage, { title: string; message: string }> = {
    SHIPMENT_PICKED_UP: {
        title  : "Your order has shipped",
        message: "We've handed your parcel to the courier.",
    },
    SHIPMENT_IN_TRANSIT: {
        title  : "On the way",
        message: "Your parcel is moving through the courier network.",
    },
    SHIPMENT_OUT_FOR_DELIVERY: {
        title  : "Out for delivery",
        message: "Your parcel will be delivered today.",
    },
    SHIPMENT_DELIVERED: {
        title  : "Delivered",
        message: "Your parcel has been delivered. Enjoy!",
    },
    SHIPMENT_RTO: {
        title  : "Return to sender",
        message: "Your parcel couldn't be delivered and is returning to us.",
    },
    SHIPMENT_FAILED: {
        title  : "Delivery failed",
        message: "There was a problem with the delivery of your parcel.",
    },
};

export interface OrderForShipment {
    orderId           : string;
    customerName      : string;
    customerEmail     : string;
    courier           : string;
    awb               : string;
    trackingUrl       : string;
    estimatedDelivery?: string | Date;
    stage             : ShipmentStage;
}

export function buildShipmentStageParams(order: OrderForShipment) {
    const baseUrl = env.PUBLIC_BASE_URL ?? "https://seijaku.com";
    const copy = STAGE_COPY[order.stage];

    const eta = order.estimatedDelivery
        ? new Date(order.estimatedDelivery).toLocaleDateString("en-GB", {
              day  : "2-digit",
              month: "short",
              year : "numeric",
          })
        : "--";

    return {
        customerName: order.customerName,
        orderId     : order.orderId,

        privacyUrl: `${baseUrl}/privacy`,
        imprintUrl: `${baseUrl}/imprint`,

        stageTitle  : copy.title,
        stageMessage: copy.message,

        courier          : order.courier,
        awb              : order.awb,
        estimatedDelivery: eta,
        trackingUrl      : order.trackingUrl,
    };
}