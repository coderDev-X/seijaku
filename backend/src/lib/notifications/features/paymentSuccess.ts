import { formatINR } from "../../../utils/currency.js";
import { buildPaymentSuccessParams } from "../../email/builders/paymentSuccess.js";
import { sendPaymentSuccessEmail } from "../../email/notifire.js";
import { prisma } from "../../prisma.js";
import { notifyOnce } from "../notifyOnce.js";


export async function sendPaymentSuccess(orderId: string) {
    const order = await prisma.orderRequest.findUnique({
        where: { id: orderId },
    });

    if (!order) {
        console.warn(`Order not found: ${orderId}`);
        return null;
    }

    return notifyOnce({
        subjectId: order.id,
        orderId  : order.id,
        recipient: order.email,
        channel  : "EMAIL",
        type     : "PAYMENT_SUCCESS",
        send     : async () => {
            const result = await sendPaymentSuccessEmail(
                { email: order.email, name: order.name },
                buildPaymentSuccessParams({
                    orderId      : order.id,
                    customerName : order.name,
                    customerEmail: order.email,
                    amount       : formatINR(order.totalAmount),
                    paymentDate  : order.updatedAt,                  // or a dedicated paidAt field
                    paymentMethod: "Razorpay",                       // see note below
                    paymentId    : order.razorpayPaymentId ?? "—",
                })
            );
            return { providerId: result.messageId };
        },
    });
}