import { sendTransactional } from "./email.service.js";

/**
 * Sends an order confirmation email.
 */
export async function sendOrderConfirmationEmail(
    to: { email: string; name: string },
    params: Record<string, unknown>
) {
    return sendTransactional({
        template: "ORDER_CONFIRMATION",
        to: { email: to.email, name: to.name },
        params: params,
    });
}

/**
 * Sends a payment success email.
 */
export async function sendPaymentSuccessEmail(
    to: { email: string; name: string },
    params: Record<string, unknown>
) {
    return sendTransactional({
        template: "PAYMENT_SUCCESS",
        to: { email: to.email, name: to.name },
        params: params,
    });
}

/**
 * Sends a payment failed email.
 */
export async function sendPaymentFailedEmail(
    to: { email: string; name: string },
    params: Record<string, unknown>
) {
    return sendTransactional({
        template: "PAYMENT_FAILED",
        to: { email: to.email, name: to.name },
        params: params,
    });
}

/**
 * Sends a shipment update email.
 */
export async function sendShipmentUpdateEmail(
    to: { email: string; name: string },
    params: Record<string, unknown>
) {
    return sendTransactional({
        template: "SHIPMENT_UPDATE",
        to: { email: to.email, name: to.name },
        params: params,
    });
}

/**
 * Sends an abandoned cart reminder email.
 */
export async function sendAbandonedCartEmail(
    to: { email: string; name: string },
    params: Record<string, unknown>
) {
    return sendTransactional({
        template: "ABANDONED_CART",
        to: { email: to.email, name: to.name },
        params: params,
    });
}