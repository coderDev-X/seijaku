import { env } from "../../../config.js";

export interface OrderForPaymentSuccess {
    orderId      : string;
    customerName : string;
    customerEmail: string;
    amount       : string;         // pre-formatted, e.g. "₹1,575.20"
    paymentDate  : Date | string;
    paymentMethod: string;         // "UPI · Razorpay", "Card", "Netbanking"
    paymentId    : string;         // Razorpay payment ID
}

export function buildPaymentSuccessParams(order: OrderForPaymentSuccess) {
    const baseUrl = env.PUBLIC_BASE_URL ?? "https://seijaku.com";
    const paid    = new Date(order.paymentDate);

    return {
        customerName: order.customerName,
        orderId     : order.orderId,

        privacyUrl: `${baseUrl}/privacy`,
        imprintUrl: `${baseUrl}/imprint`,
        orderUrl  : `${baseUrl}/orders/${order.orderId}`,

        amount: order.amount,
        paymentDate: paid.toLocaleDateString("en-GB", {
            day  : "2-digit",
            month: "short",
            year : "numeric",
        }),
        paymentMethod: order.paymentMethod,
        paymentId    : order.paymentId,
    };
}