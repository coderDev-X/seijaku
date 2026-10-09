import { env } from "../../../config.js";

export interface OrderForPaymentFailed {
    orderId: string;
    customerName: string;
    customerEmail: string;
    amount: string;                // pre-formatted, e.g. "₹1,575.20"
    failedDate: Date | string;
    paymentMethod: string;         // "UPI · Razorpay", "Card", "Netbanking"
    failureReason?: string;        // from Razorpay error, e.g. "Insufficient funds"
}

export function buildPaymentFailedParams(order: OrderForPaymentFailed) {
    const baseUrl = env.PUBLIC_BASE_URL ?? "https://seijaku.com";
    const failed = new Date(order.failedDate);

    return {
        customerName: order.customerName,
        orderId: order.orderId,

        privacyUrl: `${baseUrl}/privacy`,
        imprintUrl: `${baseUrl}/imprint`,
        retryUrl  : `${baseUrl}/orders/${order.orderId}/retry-payment`,

        amount: order.amount,
        failedDate: failed.toLocaleDateString("en-GB", {
            day  : "2-digit",
            month: "short",
            year : "numeric",
        }),
        paymentMethod: order.paymentMethod,
        failureReason: order.failureReason ?? "Payment declined by bank",
    };
}