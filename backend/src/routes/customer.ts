import { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";

import { hashPassword, signCustomerToken, verifyPassword } from "../lib/auth.js";
import { prisma } from "../lib/prisma.js";
import { requireCustomer } from "../middleware/requireCustomer.js";
import { asyncHandler, HttpError, parseBody } from "../utils/http.js";
import { syncUserToBrevo } from "../lib/brevo-contact.js";
import { serializeCartItem, serializeCustomer, serializeProduct } from "../utils/serializers.js";

export const customerRouter = Router();

const productInclude = {
  primaryImage: true,
  media: { include: { mediaAsset: true } },
  options: { include: { values: true } },
  collections: { include: { collection: true } },
  categories: { include: { category: true } },
} satisfies Prisma.ProductInclude;

function generateCartKey(productSlug: string, variantLabel?: string | null, options?: Record<string, string> | null) {
  const optionsKey = options ? Object.entries(options).sort().map(([k, v]) => `${k}:${v}`).join("|") : "";
  return `${productSlug}__${variantLabel || "default"}__${optionsKey}`;
}

async function getCustomerCart(customerId: string) {
  const items = await prisma.cartItem.findMany({
    where: { customerId },
    include: {
      product: {
        include: productInclude,
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const validItems = items.filter((item) => item.product.workflowStatus === "PUBLISHED");
  const serialized = validItems.map(serializeCartItem);
  const count = serialized.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = serialized.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);

  return {
    cart: serialized,
    count,
    subtotal,
  };
}

const registerSchema = z.object({
  email: z.string().email("Invalid email format").max(254),
  password: z.string().min(6, "Password must be at least 6 characters"),
  name: z.string().max(120).optional(),
  phone: z.string().max(30).optional(),
});

const loginSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(1, "Password is required"),
});

const profileUpdateSchema = z.object({
  name: z.string().max(120).optional(),
  phone: z.string().max(30).optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(6, "New password must be at least 6 characters"),
});

const wishlistAddSchema = z.object({
  productSlug: z.string().min(1, "Product slug is required"),
});

const wishlistSyncSchema = z.object({
  slugs: z.array(z.string()),
});

const cartItemAddSchema = z.object({
  productSlug: z.string().min(1, "Product slug is required"),
  quantity: z.number().int().min(1).default(1),
  variantLabel: z.string().nullable().optional(),
  selectedOptions: z.record(z.string()).nullable().optional(),
});

const cartItemUpdateSchema = z.object({
  cartKey: z.string().min(1, "Cart key is required"),
  quantity: z.number().int().min(0),
});

const cartSyncSchema = z.object({
  items: z.array(
    z.object({
      productSlug: z.string().min(1),
      quantity: z.number().int().min(1).default(1),
      variantLabel: z.string().nullable().optional(),
      selectedOptions: z.record(z.string()).nullable().optional(),
    })
  ),
});

function routeParam(req: { params: Record<string, string | string[] | undefined> }, key: string) {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] : value;
}

// Register new customer account
customerRouter.post(
  "/auth/register",
  asyncHandler(async (req, res) => {
    const input = parseBody(registerSchema, req.body);
    const normalizedEmail = input.email.trim().toLowerCase();

    const existing = await prisma.customer.findUnique({
      where: { email: normalizedEmail },
    });

    if (existing?.passwordHash) {
      throw new HttpError(409, "An account with this email already exists. Please sign in.");
    }

    const passwordHash = await hashPassword(input.password);

    const customer = existing
      ? await prisma.customer.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          name: input.name?.trim() || existing.name,
          phone: input.phone?.trim() || existing.phone,
        },
      })
      : await prisma.customer.create({
        data: {
          email: normalizedEmail,
          passwordHash,
          name: input.name?.trim() || null,
          phone: input.phone?.trim() || null,
        },
      });

    try {
      await syncUserToBrevo({
        id       : customer.id,
        email    : customer.email,
        firstName: customer.name || "",
        phone    : customer.phone || "",
      });
    } catch (error) {
      console.error("Brevo sync failed:", error);
    }

    const token = signCustomerToken({
      customerId: customer.id,
      email: customer.email,
    });

    res.status(201).json({
      token,
      customer: serializeCustomer(customer),
      wishlist: [],
      cart: [],
      cartCount: 0,
      cartSubtotal: 0,
    });
  })
);

// Customer Login
customerRouter.post(
  "/auth/login",
  asyncHandler(async (req, res) => {
    const input = parseBody(loginSchema, req.body);
    const normalizedEmail = input.email.trim().toLowerCase();

    const customer = await prisma.customer.findUnique({
      where: { email: normalizedEmail },
      include: {
        wishlistItems: {
          include: {
            product: {
              select: { slug: true },
            },
          },
        },
      },
    });

    if (!customer || !customer.passwordHash) {
      throw new HttpError(401, "Invalid email or password");
    }

    const isValid = await verifyPassword(input.password, customer.passwordHash);
    if (!isValid) {
      throw new HttpError(401, "Invalid email or password");
    }

    if (customer.status === "INACTIVE") {
      throw new HttpError(403, "Account is disabled. Please contact support.");
    }

    const token = signCustomerToken({
      customerId: customer.id,
      email: customer.email,
    });

    const wishlistSlugs = customer.wishlistItems.map((item) => item.product.slug);
    const cartData = await getCustomerCart(customer.id);

    res.json({
      token,
      customer: serializeCustomer(customer),
      wishlist: wishlistSlugs,
      cart: cartData.cart,
      cartCount: cartData.count,
      cartSubtotal: cartData.subtotal,
    });
  })
);

// Get currently logged-in customer profile & full wishlist
customerRouter.get(
  "/auth/me",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const customer = await prisma.customer.findUnique({
      where: { id: req.customer!.customerId },
      include: {
        wishlistItems: {
          include: {
            product: {
              include: productInclude,
            },
          },
          orderBy: { createdAt: "desc" },
        },
        orderRequests: {
          take: 10,
          orderBy: { createdAt: "desc" },
          include: {
            items: {
              include: {
                product: {
                  select: {
                    id: true,
                    slug: true,
                    title: true,
                    priceAmount: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!customer) {
      throw new HttpError(404, "Customer not found");
    }

    const wishlistedProducts = customer.wishlistItems
      .filter((item) => item.product.workflowStatus === "PUBLISHED")
      .map((item) => serializeProduct(item.product));

    const wishlistSlugs = customer.wishlistItems.map((item) => item.product.slug);
    const cartData = await getCustomerCart(customer.id);

    res.json({
      customer: serializeCustomer(customer),
      wishlistSlugs,
      wishlistProducts: wishlistedProducts,
      cart: cartData.cart,
      cartCount: cartData.count,
      cartSubtotal: cartData.subtotal,
      orders: customer.orderRequests.map((order) => ({
        id: order.id,
        status: order.status,
        paymentStatus: order.paymentStatus,
        totalAmount: order.totalAmount,
        currency: order.currency,
        createdAt: order.createdAt.toISOString(),
        itemsCount: order.items.length,
        items: order.items.map((it) => ({
          productSlug: it.product.slug,
          productTitle: it.product.title,
          quantity: it.quantity,
          unitPriceAmount: it.unitPriceAmount,
          variantSummary: it.variantSummary,
        })),
      })),
    });
  })
);

// Update customer profile (name, phone)
customerRouter.put(
  "/profile",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const input = parseBody(profileUpdateSchema, req.body);

    const updated = await prisma.customer.update({
      where: { id: req.customer!.customerId },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() || null } : {}),
        ...(input.phone !== undefined ? { phone: input.phone.trim() || null } : {}),
      },
    });

    res.json({
      customer: serializeCustomer(updated),
    });
  })
);

// Change password
customerRouter.post(
  "/change-password",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const input = parseBody(changePasswordSchema, req.body);

    const customer = await prisma.customer.findUnique({
      where: { id: req.customer!.customerId },
    });

    if (!customer || !customer.passwordHash) {
      throw new HttpError(404, "Customer account not found");
    }

    const isValid = await verifyPassword(input.currentPassword, customer.passwordHash);
    if (!isValid) {
      throw new HttpError(400, "Current password is incorrect");
    }

    const newHash = await hashPassword(input.newPassword);
    await prisma.customer.update({
      where: { id: customer.id },
      data: { passwordHash: newHash },
    });

    res.json({ ok: true, message: "Password updated successfully" });
  })
);

// Get Wishlist items
customerRouter.get(
  "/wishlist",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const items = await prisma.wishlistItem.findMany({
      where: { customerId: req.customer!.customerId },
      include: {
        product: {
          include: productInclude,
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const validItems = items.filter((item) => item.product.workflowStatus === "PUBLISHED");
    const products = validItems.map((item) => serializeProduct(item.product));
    const slugs = items.map((item) => item.product.slug);

    res.json({
      slugs,
      products,
    });
  })
);

// Add item to Wishlist
customerRouter.post(
  "/wishlist",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const { productSlug } = parseBody(wishlistAddSchema, req.body);

    const product = await prisma.product.findUnique({
      where: { slug: productSlug },
    });

    if (!product) {
      throw new HttpError(404, "Product not found");
    }

    await prisma.wishlistItem.upsert({
      where: {
        customerId_productId: {
          customerId: req.customer!.customerId,
          productId: product.id,
        },
      },
      create: {
        customerId: req.customer!.customerId,
        productId: product.id,
      },
      update: {},
    });

    const allItems = await prisma.wishlistItem.findMany({
      where: { customerId: req.customer!.customerId },
      select: { product: { select: { slug: true } } },
    });

    res.json({
      ok: true,
      slugs: allItems.map((item) => item.product.slug),
    });
  })
);

// Remove item from Wishlist
customerRouter.delete(
  "/wishlist/:slug",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const slug = routeParam(req, "slug");
    if (!slug) {
      throw new HttpError(400, "Missing product slug");
    }

    const product = await prisma.product.findUnique({
      where: { slug },
    });

    if (product) {
      await prisma.wishlistItem.deleteMany({
        where: {
          customerId: req.customer!.customerId,
          productId: product.id,
        },
      });
    }

    const allItems = await prisma.wishlistItem.findMany({
      where: { customerId: req.customer!.customerId },
      select: { product: { select: { slug: true } } },
    });

    res.json({
      ok: true,
      slugs: allItems.map((item) => item.product.slug),
    });
  })
);

// Sync local guest wishlist to customer's account (merge)
customerRouter.post(
  "/wishlist/sync",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const { slugs } = parseBody(wishlistSyncSchema, req.body);

    if (slugs.length > 0) {
      const products = await prisma.product.findMany({
        where: { slug: { in: slugs } },
        select: { id: true, slug: true },
      });

      for (const p of products) {
        await prisma.wishlistItem.upsert({
          where: {
            customerId_productId: {
              customerId: req.customer!.customerId,
              productId: p.id,
            },
          },
          create: {
            customerId: req.customer!.customerId,
            productId: p.id,
          },
          update: {},
        });
      }
    }

    const allItems = await prisma.wishlistItem.findMany({
      where: { customerId: req.customer!.customerId },
      include: {
        product: {
          include: productInclude,
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const validItems = allItems.filter((item) => item.product.workflowStatus === "PUBLISHED");
    const products = validItems.map((item) => serializeProduct(item.product));
    const allSlugs = allItems.map((item) => item.product.slug);

    res.json({
      slugs: allSlugs,
      products,
    });
  })
);

// Get Cart items
customerRouter.get(
  "/cart",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const result = await getCustomerCart(req.customer!.customerId);
    res.json(result);
  })
);

// Add item to Cart
customerRouter.post(
  "/cart",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const input = parseBody(cartItemAddSchema, req.body);
    const product = await prisma.product.findUnique({
      where: { slug: input.productSlug },
    });

    if (!product || product.workflowStatus !== "PUBLISHED") {
      throw new HttpError(404, "Product not found or unavailable");
    }

    const cartKey = generateCartKey(product.slug, input.variantLabel, input.selectedOptions);
    const existing = await prisma.cartItem.findUnique({
      where: {
        customerId_cartKey: {
          customerId: req.customer!.customerId,
          cartKey,
        },
      },
    });

    const quantityToAdd = input.quantity ?? 1;

    if (existing) {
      await prisma.cartItem.update({
        where: { id: existing.id },
        data: {
          quantity: existing.quantity + quantityToAdd,
          variantLabel: input.variantLabel || null,
          selectedOptions: input.selectedOptions || undefined,
        },
      });
    } else {
      await prisma.cartItem.create({
        data: {
          customerId: req.customer!.customerId,
          productId: product.id,
          cartKey,
          quantity: quantityToAdd,
          variantLabel: input.variantLabel || null,
          selectedOptions: input.selectedOptions || undefined,
        },
      });
    }

    const result = await getCustomerCart(req.customer!.customerId);
    res.json(result);
  })
);

// Update item quantity
customerRouter.put(
  "/cart/quantity",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const input = parseBody(cartItemUpdateSchema, req.body);

    if (input.quantity <= 0) {
      await prisma.cartItem.deleteMany({
        where: {
          customerId: req.customer!.customerId,
          cartKey: input.cartKey,
        },
      });
    } else {
      await prisma.cartItem.updateMany({
        where: {
          customerId: req.customer!.customerId,
          cartKey: input.cartKey,
        },
        data: {
          quantity: input.quantity,
        },
      });
    }

    const result = await getCustomerCart(req.customer!.customerId);
    res.json(result);
  })
);

// Remove specific item from Cart
customerRouter.delete(
  "/cart/item/:cartKey",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const cartKey = routeParam(req, "cartKey");
    if (!cartKey) {
      throw new HttpError(400, "Missing cartKey");
    }

    await prisma.cartItem.deleteMany({
      where: {
        customerId: req.customer!.customerId,
        cartKey,
      },
    });

    const result = await getCustomerCart(req.customer!.customerId);
    res.json(result);
  })
);

// Clear Cart
customerRouter.delete(
  "/cart",
  requireCustomer,
  asyncHandler(async (req, res) => {
    await prisma.cartItem.deleteMany({
      where: {
        customerId: req.customer!.customerId,
      },
    });

    res.json({
      ok: true,
      cart: [],
      count: 0,
      subtotal: 0,
    });
  })
);

// Sync local guest cart to customer's account (merge)
customerRouter.post(
  "/cart/sync",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const { items } = parseBody(cartSyncSchema, req.body);

    if (items.length > 0) {
      const slugs = [...new Set(items.map((it) => it.productSlug))];
      const products = await prisma.product.findMany({
        where: { slug: { in: slugs } },
        select: { id: true, slug: true, workflowStatus: true },
      });
      const productMap = new Map(products.map((p) => [p.slug, p]));

      for (const item of items) {
        const product = productMap.get(item.productSlug);
        if (!product || product.workflowStatus !== "PUBLISHED") continue;

        const cartKey = generateCartKey(product.slug, item.variantLabel, item.selectedOptions);
        const existing = await prisma.cartItem.findUnique({
          where: {
            customerId_cartKey: {
              customerId: req.customer!.customerId,
              cartKey,
            },
          },
        });

        const syncQty = item.quantity ?? 1;

        if (existing) {
          await prisma.cartItem.update({
            where: { id: existing.id },
            data: {
              quantity: Math.max(existing.quantity, syncQty),
              variantLabel: item.variantLabel || null,
              selectedOptions: item.selectedOptions || undefined,
            },
          });
        } else {
          await prisma.cartItem.create({
            data: {
              customerId: req.customer!.customerId,
              productId: product.id,
              cartKey,
              quantity: syncQty,
              variantLabel: item.variantLabel || null,
              selectedOptions: item.selectedOptions || undefined,
            },
          });
        }
      }
    }

    const result = await getCustomerCart(req.customer!.customerId);
    res.json(result);
  })
);
