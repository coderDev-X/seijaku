import { env } from "../../../config.js";

interface CartItem {
    name      : string;
    sku       : string;
    imageUrl ?: string | null;
    quantity  : number;
    lineTotal : string;
}

export interface AbandonedCartForReminder {
    customerName ?: string;
    customerEmail?: string;
    items         : CartItem[];
    subtotal      : string;
    discount     ?: string;
    cartUrl       : string;
    shopUrl       : string;
}

export function buildAbandonedCartParams(cart: AbandonedCartForReminder) {
    const baseUrl = env.PUBLIC_BASE_URL ?? "https://seijaku.com";

    return {
        customerName: cart.customerName ?? "there",
        brandName   : "Seijaku",
        year        : String(new Date().getFullYear()),
        supportEmail: "help@seijaku.com",
        privacyUrl  : `${baseUrl}/privacy`,
        imprintUrl  : `${baseUrl}/imprint`,

        cartUrl: cart.cartUrl,
        shopUrl: cart.shopUrl,

        discount: cart.discount ?? "",
        subtotal: cart.subtotal,

        items: cart.items.map((i) => ({
            name: i.name,
            sku: i.sku,
            image: i.imageUrl ? `${baseUrl}/${i.imageUrl}` : `https://placehold.co/600x400/png`,
            quantity: i.quantity,
            lineTotal: i.lineTotal,
        })),
    };
}