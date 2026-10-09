import { formatINR } from "../../../utils/currency.js";
import { buildOrderConfirmationParams } from "../../email/builders/orderConfirmation.js";
import { sendOrderConfirmationEmail } from "../../email/notifire.js";
import { prisma } from "../../prisma.js";
import { notifyOnce } from "../notifyOnce.js";


export async function sendOrderConfirmation(orderId: string) {
    const order = await prisma.orderRequest.findUnique({
        where: { id: orderId },
        include: {
            items: {
                include: {
                    product: { include: { primaryImage: true } },
                },
            },
        },
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
        type     : "ORDER_CONFIRMATION",
        send     : async () => {
            const result = await sendOrderConfirmationEmail(
                { email: order.email, name: order.name },
                buildOrderConfirmationParams({
                    orderId      : order.id,
                    customerName : order.name,
                    customerEmail: order.email,
                    shipping     : {
                        name   : order.name,
                        line1  : order.shippingLine1 ?? "",
                        line2  : order.shippingLine2 ?? "",
                        city   : order.shippingCity ?? "",
                        country: order.shippingCountry ?? "",
                    },
                    billing      : {
                        name   : order.name,
                        line1  : order.shippingLine1 ?? "",
                        line2  : order.shippingLine2 ?? "",
                        city   : order.shippingCity ?? "",
                        country: order.shippingCountry ?? "",
                    },
                    discount     : formatINR(0),
                    subtotal     : formatINR(order.totalAmount),
                    tax          : formatINR(0),
                    shippingCost : formatINR(0),
                    total        : formatINR(order.totalAmount),
                    items        : order.items.map((item) => ({
                        name     : item.product.title,
                        sku      : item.product.slug,
                        imageUrl : item.product.primaryImage?.url,
                        quantity : item.quantity,
                        lineTotal: formatINR(item.unitPriceAmount * item.quantity),
                    })),
                })
            );
            return { providerId: result.messageId };
        },
    });
}