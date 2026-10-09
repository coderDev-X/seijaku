import { formatINR } from "../../../utils/currency.js";
import { buildPaymentFailedParams } from "../../email/builders/paymentFailed.js";
import { sendPaymentFailedEmail } from "../../email/notifire.js";
import { prisma } from "../../prisma.js";
import { notifyOnce } from "../notifyOnce.js";


export async function sendPaymentFailed(orderId: string, failureReason?: string) {
    const order = await prisma.orderRequest.findUnique({
        where: { id: orderId },
    });

    if (!order) {
        console.warn(`Order not found: ${orderId}`);
        return null;
    }

    // Don't send a "failed" email if the order is already paid
    // (e.g. customer retried and succeeded before this webhook arrived)
    if (order.paymentStatus === "PAID") {
        console.log(`Order ${orderId} already paid, skipping failure email`);
        return null;
    }

    return notifyOnce({
        subjectId: order.id,
        orderId  : order.id,
        recipient: order.email,
        channel  : "EMAIL",
        type     : "PAYMENT_FAILED",
        send     : async () => {
            const result = await sendPaymentFailedEmail(
                { email: order.email, name: order.name },
                buildPaymentFailedParams({
                    orderId      : order.id,
                    customerName : order.name,
                    customerEmail: order.email,
                    amount       : formatINR(order.totalAmount),
                    failedDate   : order.updatedAt,
                    paymentMethod: "Razorpay",
                    failureReason: failureReason ?? "Payment declined by bank",
                })
            );
            return { providerId: result.messageId };
        },
    });
}