import { env } from "../../../config.js";

interface Address {
    name: string;
    line1: string;
    line2?: string;
    city: string;
    country: string;
}

interface OrderItem {
    name: string;
    sku: string;
    imageUrl?: string | null;
    quantity: number;
    lineTotal: string;
}

export interface OrderForConfirmation {
    orderId: string;
    customerName: string;
    customerEmail: string;
    shipping: Address;
    billing: Address;
    discount: string;
    subtotal: string;
    tax: string;
    shippingCost: string;
    total: string;
    items: OrderItem[];
}

export function buildOrderConfirmationParams(order: OrderForConfirmation) {
    const baseUrl = env.PUBLIC_BASE_URL ?? "https://seijaku.com";

    return {
        customerName: order.customerName,
        orderId: order.orderId,
        brandName: "Seijaku",
        year: String(new Date().getFullYear()),
        supportEmail: "help@seijaku.com",
        trackingUrl: `${baseUrl}/orders/${order.orderId}/track`,
        privacyUrl: `${baseUrl}/privacy`,
        imprintUrl: `${baseUrl}/imprint`,

        shippingName: order.shipping.name,
        shippingLine1: order.shipping.line1,
        shippingLine2: order.shipping.line2 ?? "",
        shippingCity: order.shipping.city,
        shippingCountry: order.shipping.country,

        billingName: order.billing.name,
        billingLine1: order.billing.line1,
        billingLine2: order.billing.line2 ?? "",
        billingCity: order.billing.city,
        billingCountry: order.billing.country,

        discount: order.discount,
        subtotal: order.subtotal,
        tax     : order.tax,
        shipping: order.shippingCost,
        total   : order.total,

        items: order.items.map((i) => ({
            name     : i.name,
            sku      : i.sku,
            image    : i.imageUrl ? `${baseUrl}/${i.imageUrl}` : `https://placehold.co/600x400/png`,
            quantity : i.quantity,
            lineTotal: i.lineTotal,
        })),
    };
}