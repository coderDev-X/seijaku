import cron from 'node-cron';
import {
    NotificationChannel,
    NotificationStatus,
    AbandonedCartNotificationType,
    CustomerStatus,
} from '@prisma/client';
import { prisma } from '../prisma.js';
import { sendAbandonedCartEmail } from '../email/notifire.js';
import { buildAbandonedCartParams } from '../email/builders/abandonedCart.js';
import { formatINR } from '../../utils/currency.js';
import { env } from '../../config.js';

/**
 * Temporary v1: Wishlist is being treated as the cart.
 * Runs every 10 minutes.
 */
export async function processAbandonedWishlist(): Promise<void> {

    const ABANDON_AFTER_HOURS = env.ABANDON_AFTER_HOURS;

    const cutoff = new Date(
        Date.now() - ABANDON_AFTER_HOURS * 60 * 60 * 1000,
    );

    try {
        const wishlistItems = await prisma.wishlistItem.findMany({
            where: {
                createdAt: {
                    lte: cutoff,
                },
                customer: {
                    status: CustomerStatus.ACTIVE,
                },
            },
            include: {
                customer: true,
                product: {
                    include: {
                        primaryImage: true,
                    },
                },
            },
            orderBy: {
                createdAt: 'asc',
            },
            take: 500,
        });

        if (wishlistItems.length === 0) {
            return;
        }

        /**
         * Group wishlist items by customer.
         */
        const grouped = new Map<string, typeof wishlistItems>();

        for (const item of wishlistItems) {
            const customerItems = grouped.get(item.customerId) ?? [];

            customerItems.push(item);

            grouped.set(item.customerId, customerItems);
        }

        /**
         * Process each customer.
         */
        for (const [customerId, items] of grouped) {
            try {
                /**
                 * Check whether reminder was already sent.
                 */
                const existingNotification = await prisma.cartAbandonedNotification.findUnique({
                    where: {
                        customerId_type: {
                            customerId,
                            type: AbandonedCartNotificationType.REMINDER_1,
                        },
                    },
                });

                if (existingNotification?.status === NotificationStatus.SENT) {
                    continue;
                }

                const customer = items[0].customer;

                /**
                 * Calculate subtotal.
                 */
                const subtotal = items.reduce((total, item) => total + Number(item.product.priceAmount), 0);

                const discount = 0;

                /**
                 * Create notification record if needed.
                 */
                let notification = existingNotification;

                if (!notification) {
                    notification = await prisma.cartAbandonedNotification.create({
                        data: {
                            customerId,
                            type        : AbandonedCartNotificationType.REMINDER_1,
                            status      : NotificationStatus.PENDING,
                            channel     : NotificationChannel.EMAIL,
                            scheduledAt : new Date(),
                            attemptCount: 0,
                        },
                    });
                }

                /**
                 * Already sent.
                 */
                if (notification.status === NotificationStatus.SENT) {
                    continue;
                }

                /**
                 * Send email.
                 */
                await sendAbandonedCartEmail(
                    {
                        email: customer.email,
                        name: customer.name ?? 'there',
                    },
                    buildAbandonedCartParams({
                        customerName: customer.name ?? 'there',
                        customerEmail: customer.email,

                        items: items.map((item) => ({
                            name    : item.product.title,
                            sku     : item.product.slug,
                            imageUrl: item.product.primaryImage?.url ?? null,
                            quantity: 1,
                            lineTotal: formatINR( Number(item.product.priceAmount)),
                        })),
                        subtotal: formatINR(subtotal),
                        discount: formatINR(discount),

                        cartUrl: `${env.PUBLIC_BASE_URL}/wishlist`,
                        shopUrl: `${env.PUBLIC_BASE_URL}/shop`,
                    })
                );

                /**
                 * Mark notification as sent.
                 */
                await prisma.cartAbandonedNotification.update({
                    where: {
                        id: notification.id,
                    },

                    data: {
                        status       : NotificationStatus.SENT,
                        sentAt       : new Date(),
                        attemptCount : { increment: 1},
                        lastAttemptAt: new Date(),
                        errorMessage : null,
                    },
                });

                console.log( `[AbandonedCart] Email sent to ${customer.email}`);
            } catch (error) {
                console.error(
                    `[AbandonedCart] Failed for customer ${customerId}`,
                    error,
                );

                /**
                 * Mark pending notification as failed.
                 * Next cron run can retry it.
                 */
                await prisma.cartAbandonedNotification.updateMany({
                    where: {
                        customerId,
                        type  : AbandonedCartNotificationType.REMINDER_1,
                        status: NotificationStatus.PENDING,
                    },

                    data: {
                        status: NotificationStatus.FAILED,
                        attemptCount: { increment: 1},
                        lastAttemptAt: new Date(),
                        errorMessage:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    },
                });
            }
        }
    } catch (error) {
        console.error(
            '[AbandonedCart] Failed to process wishlist',
            error,
        );
    }
}

/**
 * Run every 10 minutes.
 */
cron.schedule('*/10 * * * *', async () => {
    try {
        console.log('[AbandonedCart] Running abandoned wishlist job...');
        await processAbandonedWishlist();
        console.log('[AbandonedCart] Abandoned wishlist job complete.');
    } catch (error) {
        console.error('[AbandonedCart] Job failed:', error);
    }
});

try {
    console.log('[AbandonedCart] Running abandoned wishlist job...');
    await processAbandonedWishlist();
    console.log('[AbandonedCart] Abandoned wishlist job complete.');
} catch ( error ) {
    console.error('[AbandonedCart] Job failed:', error);
}
