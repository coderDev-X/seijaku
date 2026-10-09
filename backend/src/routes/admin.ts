import { AdminRole, AdminStatus, CategoryKind, CollectionKind, MediaKind, Prisma, ProductMediaType, ProductStatus, ProductWorkflowStatus } from "@prisma/client";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import sharp from "sharp";

import { signAdminToken, verifyPassword, hashPassword } from "../lib/auth.js";
import { prisma } from "../lib/prisma.js";
import { defaultBridgeSlugForProductType } from "../lib/product-bridge.js";
import { storeUpload } from "../lib/storage.js";
import { requireAdmin, requireAdminRole } from "../middleware/requireAdmin.js";
import {
  serializeAdmin,
  serializeArticle,
  serializeBridgePage,
  serializeBulkOrderInquiry,
  serializeCategory,
  serializeCollection,
  serializeMediaAsset,
  serializeOrderRequest,
  serializeProduct,
  serializeProductNotification,
  serializeProgram,
  serializeRetreat,
  serializeShippingSetting,
  serializeSiteSettings,
  serializeStory,
  serializeStorySummary,
} from "../utils/serializers.js";
import {
  listPickupLocations,
  testShiprocketAuth,
} from "../lib/shiprocket.js";
import { pushOrderToShiprocket } from "../lib/shiprocket-dispatch.js";
import { asyncHandler, HttpError, parseBody } from "../utils/http.js";
import { sendOrderConfirmation } from "../lib/notifications/features/orderConfirmation.js";

export const adminRouter = Router();

// 50 MB cap covers short product-marketing video clips (15-30s typical) while
// still rejecting obviously-wrong payloads. Images comfortably sit well below.
// If a limit change is needed, also update `AddMediaDialog`'s helper copy and
// backend/CLAUDE.md.
// Narrow helper: maps a Prisma unique-constraint violation on Product.slug to
// HttpError(409) with a precise message. Any other Prisma error is rethrown
// untouched so the generic error middleware handles it. Always throws, so TS
// treats code after the call site as unreachable.
function throwIfSlugCollision(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    (error.meta as { target?: string[] | string } | undefined)?.target &&
    String((error.meta as { target?: string[] | string }).target).includes("slug")
  ) {
    throw new HttpError(409, "Slug already taken — pick a different slug.");
  }
  throw error;
}

async function compressImageBuffer(
  buffer: Buffer,
  mimetype: string
): Promise<{ buffer: Buffer; mimetype: string; width?: number; height?: number }> {
  try {
    const img = sharp(buffer);
    let compressedBuffer = buffer;
    if (mimetype === "image/jpeg" || mimetype === "image/jpg") {
      compressedBuffer = await img.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    } else if (mimetype === "image/png") {
      compressedBuffer = await img.png({ quality: 80, compressionLevel: 9, palette: true }).toBuffer();
    } else if (mimetype === "image/webp") {
      compressedBuffer = await img.webp({ quality: 80 }).toBuffer();
    } else if (mimetype === "image/gif") {
      try {
        compressedBuffer = await img.gif({ reuse: true }).toBuffer();
      } catch {
        compressedBuffer = buffer;
      }
    }

    const finalImg = sharp(compressedBuffer);
    const finalMetadata = await finalImg.metadata();

    return {
      buffer: compressedBuffer,
      mimetype,
      width: finalMetadata.width ?? undefined,
      height: finalMetadata.height ?? undefined,
    };
  } catch (error) {
    console.error("[compressImageBuffer] failed to compress image:", error);
    return { buffer, mimetype };
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const optionalString = z.string().optional().nullable();
const optionalDateTime = z.string().datetime().optional().nullable();
const optionalJsonRecord = z.record(z.any()).optional();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const adminCreateSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.nativeEnum(AdminRole).default("EDITOR"),
  status: z.nativeEnum(AdminStatus).default("ACTIVE"),
});

const adminUpdateSchema = z.object({
  email: z.string().email().optional(),
  role: z.nativeEnum(AdminRole).optional(),
  status: z.nativeEnum(AdminStatus).optional(),
});

const adminPasswordSchema = z.object({
  password: z.string().min(8),
});

const mediaCreateSchema = z.object({
  url: z.string().url(),
  altText: optionalString,
  kind: z.nativeEnum(MediaKind).default("IMAGE"),
  width: z.number().int().positive().optional().nullable(),
  height: z.number().int().positive().optional().nullable(),
});

const mediaUpdateSchema = z.object({
  url: z.string().url().optional(),
  altText: optionalString,
  kind: z.nativeEnum(MediaKind).optional(),
  width: z.number().int().positive().optional().nullable(),
  height: z.number().int().positive().optional().nullable(),
});

const siteSettingsSchema = z.object({
  footerEmail: z.string().email().optional().nullable(),
  footerPhone: optionalString,
  addressLines: z.array(z.string()).optional(),
  newsletterHeading: optionalString,
  newsletterBody: optionalString,
  misc: optionalJsonRecord,
  logoImageId: z.string().optional().nullable(),
});

const categorySchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  kind: z.nativeEnum(CategoryKind),
});

const productInputSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  shortDescription: optionalString,
  longDescription: optionalString,
  type: z.string().min(1),
  material: optionalString,
  useCase: optionalString,
  priceAmount: z.number().int().nonnegative(),
  currency: z.string().default("INR"),
  status: z.nativeEnum(ProductStatus),
  workflowStatus: z.nativeEnum(ProductWorkflowStatus).optional(),
  releaseDate: optionalDateTime,
  seoTitle: optionalString,
  seoDescription: optionalString,
  imageAlt: optionalString,
  ctaLabel: optionalString,
  metadata: optionalJsonRecord,
  publishedAt: optionalDateTime,
  primaryImageId: z.string().optional().nullable(),
  // Shiprocket dimensions. All nullable — runtime falls back to
  // ShippingSetting defaults when a product hasn't been measured.
  weightGrams: z.number().int().positive().nullable().optional(),
  lengthCm: z.number().int().positive().nullable().optional(),
  breadthCm: z.number().int().positive().nullable().optional(),
  heightCm: z.number().int().positive().nullable().optional(),
  hsnCode: optionalString,
});

const productMediaSchema = z.object({
  primaryImageId: z.string().optional().nullable(),
  items: z.array(
    z.object({
      mediaAssetId: z.string().min(1),
      sortOrder: z.number().int().default(0),
      mediaType: z.nativeEnum(ProductMediaType).default("GALLERY"),
    })
  ),
});

const categoryAssignmentsSchema = z.object({
  assignments: z.array(
    z.object({
      categoryId: z.string().min(1),
      sortOrder: z.number().int().default(0),
    })
  ),
});

const collectionAssignmentsSchema = z.object({
  assignments: z.array(
    z.object({
      collectionId: z.string().min(1),
      sortOrder: z.number().int().default(0),
    })
  ),
});

const bridgePageAssignmentsSchema = z.object({
  assignments: z.array(
    z.object({
      bridgePageId: z.string().min(1),
      sortOrder: z.number().int().default(0),
    })
  ),
});

const productOptionSchema = z.object({
  productId: z.string().min(1),
  code: z.string().min(1),
  label: z.string().min(1),
  selectionMode: z.enum(["SINGLE", "MULTI"]).default("SINGLE"),
  required: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  metadata: optionalJsonRecord,
});

const productOptionValueSchema = z.object({
  productOptionId: z.string().min(1),
  value: z.string().min(1),
  label: z.string().min(1),
  priceDeltaAmount: z.number().int().default(0),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
});

const bridgePageSchema = z.object({
  slug: z.string().min(1),
  navLabel: z.string().min(1),
  heroEyebrow: z.string().min(1),
  heroTitle: z.string().min(1),
  heroDescription: z.array(z.string()),
  heroImage: z.string().default(""),
  heroImageAlt: z.string().default(""),
  heroImagePosition: optionalString,
  heroQuote: z.string().min(1),
  introEyebrow: optionalString,
  introTitle: z.string().min(1),
  introDescription: z.string().min(1),
  interludeImage: optionalString,
  interludeImageAlt: optionalString,
  productSectionEyebrow: optionalString,
  productSectionTitle: optionalString,
  productSectionDescription: optionalString,
  postCtaTitle: optionalString,
  postCtaDescription: optionalString,
  postCtaPrimaryLabel: optionalString,
  postCtaPrimaryHref: optionalString,
  postCtaSecondaryLabel: optionalString,
  postCtaSecondaryHref: optionalString,
  seoTitle: optionalString,
  seoDescription: optionalString,
  seoFootnote: optionalString,
  content: optionalJsonRecord,
  // Editorial-page media slots (Decision #31). All optional; only the
  // bridge whose slug matches the consuming page reads them.
  homeCard1Image: optionalString,
  homeCard1Alt: optionalString,
  homeCard2Image: optionalString,
  homeCard2Alt: optionalString,
  homeCard3Image: optionalString,
  homeCard3Alt: optionalString,
  homeCard4Image: optionalString,
  homeCard4Alt: optionalString,
  ritualVideo1Url: optionalString,
  ritualVideo1Poster: optionalString,
  ritualVideo2Url: optionalString,
  ritualVideo2Poster: optionalString,
  formCard1Image: optionalString,
  formCard1Alt: optionalString,
  formCard2Image: optionalString,
  formCard2Alt: optionalString,
  formCard3Image: optionalString,
  formCard3Alt: optionalString,
  formCard4Image: optionalString,
  formCard4Alt: optionalString,
  imageBreak1Image: optionalString,
  imageBreak1Alt: optionalString,
  imageBreak2Image: optionalString,
  imageBreak2Alt: optionalString,
  imageBreak3Image: optionalString,
  imageBreak3Alt: optionalString,
});

const bridgePageProductsSchema = z.object({
  assignments: z.array(
    z.object({
      productId: z.string().min(1),
      sortOrder: z.number().int().default(0),
    })
  ),
});

const articleSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  category: z.string().min(1),
  excerpt: z.string().min(1),
  bodyMarkdown: optionalString,
  featured: z.boolean().default(false),
  status: z.enum(["DRAFT", "PUBLISHED"]).default("DRAFT"),
  publishedAt: optionalDateTime,
  primaryImageId: z.string().optional().nullable(),
  seoTitle: optionalString,
  seoDescription: optionalString,
});

const retreatSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  shortDescription: z.string().min(1),
  detailDescription: z.string().min(1),
  location: z.string().min(1),
  season: z.string().min(1),
  format: z.string().min(1),
  groupSize: z.string().min(1),
  status: z.enum(["DRAFT", "UPCOMING", "INQUIRY_OPEN", "CLOSED"]).default("DRAFT"),
  primaryImageId: z.string().optional().nullable(),
});

const programSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  shortDescription: z.string().min(1),
  detailDescription: optionalString,
  durationLabel: optionalString,
  groupSizeLabel: optionalString,
  status: z.enum(["DRAFT", "UPCOMING", "BOOKING_OPEN", "CLOSED"]).default("DRAFT"),
});

const programSessionSchema = z.object({
  programId: z.string().min(1),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  timezone: z.string().min(1),
  city: z.string().min(1),
  venueName: optionalString,
  capacity: z.number().int().positive(),
  spotsRemaining: z.number().int().nonnegative(),
  status: z.enum(["UPCOMING", "BOOKING_OPEN", "FULL", "CLOSED", "CANCELLED"]).default("UPCOMING"),
});

const collectionSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: optionalString,
  kind: z.nativeEnum(CollectionKind),
});

const leadStatusSchema = z.object({
  status: z.enum(["NEW", "REVIEWED", "CONTACTED", "CLOSED"]),
});

const shippingSettingSchema = z.object({
  pickupLocationName: optionalString,
  defaultWeightGrams: z.number().int().positive().optional(),
  defaultLengthCm: z.number().int().positive().optional(),
  defaultBreadthCm: z.number().int().positive().optional(),
  defaultHeightCm: z.number().int().positive().optional(),
  autoPushEnabled: z.boolean().optional(),
});

const productInclude = {
  primaryImage: true,
  media: { include: { mediaAsset: true } },
  options: { include: { values: true } },
  collections: { include: { collection: true } },
  categories: { include: { category: true } },
  bridgePages: { include: { bridgePage: true } },
} satisfies Prisma.ProductInclude;

const bridgePageInclude = {
  products: {
    include: {
      product: {
        include: productInclude,
      },
    },
  },
} satisfies Prisma.ShopBridgePageInclude;

function routeParam(req: { params: Record<string, string | string[] | undefined> }, key: string) {
  const value = req.params[key];
  const normalized = Array.isArray(value) ? value[0] : value;

  if (!normalized) {
    throw new HttpError(400, `Missing route param: ${key}`);
  }

  return normalized;
}

function assertSuperAdmin(role?: AdminRole) {
  if (role !== "SUPER_ADMIN") {
    throw new HttpError(403, "Super admin access required");
  }
}

function assertCanManagePublishing(
  role: AdminRole | undefined,
  details: { status?: string | null; publishedAt?: string | null; workflowStatus?: string | null }
) {
  if (role === "SUPER_ADMIN") {
    return;
  }

  if (
    (details.status && details.status !== "DRAFT") ||
    details.publishedAt ||
    (details.workflowStatus && details.workflowStatus !== "DRAFT")
  ) {
    throw new HttpError(403, "Only super admins can publish content");
  }
}

async function ensureAdminUpdateAllowed(currentAdminId: string, targetId: string, nextRole?: AdminRole, nextStatus?: AdminStatus) {
  const targetAdmin = await prisma.admin.findUnique({ where: { id: targetId } });

  if (!targetAdmin) {
    throw new HttpError(404, "Admin not found");
  }

  const resultingRole = nextRole ?? targetAdmin.role;
  const resultingStatus = nextStatus ?? targetAdmin.status;
  const isDowngradingActiveSuper = targetAdmin.role === "SUPER_ADMIN" && (resultingRole !== "SUPER_ADMIN" || resultingStatus !== "ACTIVE");

  if (currentAdminId === targetId && isDowngradingActiveSuper) {
    throw new HttpError(400, "You cannot remove your own super admin access");
  }

  if (isDowngradingActiveSuper) {
    const activeSuperAdminCount = await prisma.admin.count({
      where: {
        role: "SUPER_ADMIN",
        status: "ACTIVE",
      },
    });

    if (activeSuperAdminCount <= 1) {
      throw new HttpError(400, "At least one active super admin must remain");
    }
  }
}

async function ensureAdminExists(adminId: string) {
  const admin = await prisma.admin.findUnique({ where: { id: adminId } });

  if (!admin || admin.status !== "ACTIVE") {
    throw new HttpError(401, "Unauthorized");
  }

  return admin;
}

adminRouter.post(
  "/auth/login",
  asyncHandler(async (req, res) => {
    const payload = parseBody(loginSchema, req.body);
    const admin = await prisma.admin.findUnique({ where: { email: payload.email } });

    if (!admin || admin.status !== "ACTIVE") {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const valid = await verifyPassword(payload.password, admin.passwordHash);

    if (!valid) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const token = signAdminToken({
      adminId: admin.id,
      email: admin.email,
      role: admin.role,
    });

    res.json({
      token,
      admin: serializeAdmin(admin),
    });
  })
);

adminRouter.use(requireAdmin);

adminRouter.get(
  "/auth/me",
  asyncHandler(async (req, res) => {
    const admin = await ensureAdminExists(req.admin!.adminId);
    res.json({ admin: serializeAdmin(admin) });
  })
);

adminRouter.get(
  "/dashboard",
  asyncHandler(async (_req, res) => {
    const [
      products,
      articles,
      retreats,
      programs,
      mediaAssets,
      orderRequests,
      newsletterSubscriptions,
      programReservations,
      retreatInquiries,
      recentOrders,
      recentReservations,
      recentRetreats,
    ] = await prisma.$transaction([
      prisma.product.count(),
      prisma.article.count(),
      prisma.retreat.count(),
      prisma.program.count(),
      prisma.mediaAsset.count(),
      prisma.orderRequest.count(),
      prisma.newsletterSubscription.count(),
      prisma.programReservation.count(),
      prisma.retreatInquiry.count(),
      prisma.orderRequest.findMany({ include: { items: { include: { product: true } } }, orderBy: { createdAt: "desc" }, take: 5 }),
      prisma.programReservation.findMany({ include: { program: true, programSession: true }, orderBy: { createdAt: "desc" }, take: 5 }),
      prisma.retreatInquiry.findMany({ include: { retreat: true }, orderBy: { createdAt: "desc" }, take: 5 }),
    ]);

    res.json({
      counts: {
        products,
        articles,
        retreats,
        programs,
        mediaAssets,
        orderRequests,
        newsletterSubscriptions,
        programReservations,
        retreatInquiries,
      },
      recent: {
        orderRequests: recentOrders,
        programReservations: recentReservations,
        retreatInquiries: recentRetreats,
      },
    });
  })
);

adminRouter.get(
  "/admins",
  requireAdminRole("SUPER_ADMIN"),
  asyncHandler(async (_req, res) => {
    const admins = await prisma.admin.findMany({ orderBy: { createdAt: "asc" } });
    res.json({ items: admins.map(serializeAdmin) });
  })
);

adminRouter.post(
  "/admins",
  requireAdminRole("SUPER_ADMIN"),
  asyncHandler(async (req, res) => {
    const payload = parseBody(adminCreateSchema, req.body);
    const admin = await prisma.admin.create({
      data: {
        email: payload.email,
        passwordHash: await hashPassword(payload.password),
        role: payload.role,
        status: payload.status,
      },
    });

    res.status(201).json({ item: serializeAdmin(admin) });
  })
);

adminRouter.patch(
  "/admins/:id",
  requireAdminRole("SUPER_ADMIN"),
  asyncHandler(async (req, res) => {
    const targetId = routeParam(req, "id");
    const payload = parseBody(adminUpdateSchema, req.body);
    await ensureAdminUpdateAllowed(req.admin!.adminId, targetId, payload.role, payload.status);

    const admin = await prisma.admin.update({
      where: { id: targetId },
      data: {
        ...(payload.email !== undefined ? { email: payload.email } : {}),
        ...(payload.role !== undefined ? { role: payload.role } : {}),
        ...(payload.status !== undefined ? { status: payload.status } : {}),
      },
    });

    res.json({ item: serializeAdmin(admin) });
  })
);

adminRouter.post(
  "/admins/:id/password",
  requireAdminRole("SUPER_ADMIN"),
  asyncHandler(async (req, res) => {
    const targetId = routeParam(req, "id");
    await ensureAdminUpdateAllowed(req.admin!.adminId, targetId);
    const payload = parseBody(adminPasswordSchema, req.body);
    const admin = await prisma.admin.update({
      where: { id: targetId },
      data: {
        passwordHash: await hashPassword(payload.password),
      },
    });

    res.json({ item: serializeAdmin(admin) });
  })
);

adminRouter.get(
  "/media",
  asyncHandler(async (req, res) => {
    const pageParam = typeof req.query.page === "string" ? parseInt(req.query.page, 10) : undefined;
    const limitParam = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;

    if (pageParam !== undefined && limitParam !== undefined && !isNaN(pageParam) && !isNaN(limitParam)) {
      const page = Math.max(1, pageParam);
      const limit = Math.max(1, limitParam);
      const skip = (page - 1) * limit;

      const [items, totalCount] = await prisma.$transaction([
        prisma.mediaAsset.findMany({
          orderBy: { createdAt: "desc" },
          skip,
          take: limit,
        }),
        prisma.mediaAsset.count(),
      ]);

      const totalPages = Math.ceil(totalCount / limit);

      res.json({
        items: items.map(serializeMediaAsset),
        totalCount,
        totalPages,
        currentPage: page,
      });
    } else {
      const items = await prisma.mediaAsset.findMany({ orderBy: { createdAt: "desc" } });
      res.json({ items: items.map(serializeMediaAsset) });
    }
  })
);

adminRouter.post(
  "/media",
  asyncHandler(async (req, res) => {
    const payload = parseBody(mediaCreateSchema, req.body);
    const item = await prisma.mediaAsset.create({
      data: {
        url: payload.url,
        altText: payload.altText,
        kind: payload.kind,
        width: payload.width,
        height: payload.height,
      },
    });

    res.status(201).json({ item: serializeMediaAsset(item) });
  })
);

adminRouter.post(
  "/media/upload",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw new HttpError(400, "A file is required");
    }

    const kind = req.body.kind && z.nativeEnum(MediaKind).safeParse(req.body.kind).success ? req.body.kind : "IMAGE";

    let fileBuffer = req.file.buffer;
    let fileMimetype = req.file.mimetype;
    let width: number | undefined;
    let height: number | undefined;

    if (fileMimetype.startsWith("image/")) {
      const compressionResult = await compressImageBuffer(fileBuffer, fileMimetype);
      fileBuffer = compressionResult.buffer;
      fileMimetype = compressionResult.mimetype;
      width = compressionResult.width;
      height = compressionResult.height;
    }

    const uploadResult = await storeUpload({
      buffer: fileBuffer,
      contentType: fileMimetype,
      originalName: req.file.originalname,
    });

    const item = await prisma.mediaAsset.create({
      data: {
        url: uploadResult.url,
        altText: typeof req.body.altText === "string" ? req.body.altText : null,
        kind,
        width: width ?? uploadResult.width ?? null,
        height: height ?? uploadResult.height ?? null,
      },
    });

    res.status(201).json({ item: serializeMediaAsset(item) });
  })
);

adminRouter.patch(
  "/media/:id",
  asyncHandler(async (req, res) => {
    const payload = parseBody(mediaUpdateSchema, req.body);
    const item = await prisma.mediaAsset.update({
      where: { id: routeParam(req, "id") },
      data: {
        ...(payload.url !== undefined ? { url: payload.url } : {}),
        ...(payload.altText !== undefined ? { altText: payload.altText } : {}),
        ...(payload.kind !== undefined ? { kind: payload.kind } : {}),
        ...(payload.width !== undefined ? { width: payload.width } : {}),
        ...(payload.height !== undefined ? { height: payload.height } : {}),
      },
    });

    res.json({ item: serializeMediaAsset(item) });
  })
);

adminRouter.delete(
  "/media/:id",
  requireAdminRole("SUPER_ADMIN"),
  asyncHandler(async (req, res) => {
    await prisma.mediaAsset.delete({ where: { id: routeParam(req, "id") } });
    res.status(204).send();
  })
);

adminRouter.get(
  "/categories",
  asyncHandler(async (_req, res) => {
    const items = await prisma.productCategory.findMany({ orderBy: { name: "asc" } });
    res.json({ items: items.map(serializeCategory) });
  })
);

adminRouter.post(
  "/categories",
  asyncHandler(async (req, res) => {
    const payload = parseBody(categorySchema, req.body);
    const item = await prisma.productCategory.create({ data: payload });
    res.status(201).json({ item: serializeCategory(item) });
  })
);

adminRouter.patch(
  "/categories/:id",
  asyncHandler(async (req, res) => {
    const payload = parseBody(categorySchema.partial(), req.body);
    const item = await prisma.productCategory.update({
      where: { id: routeParam(req, "id") },
      data: payload,
    });
    res.json({ item: serializeCategory(item) });
  })
);

adminRouter.delete(
  "/categories/:id",
  requireAdminRole("SUPER_ADMIN"),
  asyncHandler(async (req, res) => {
    await prisma.productCategory.delete({ where: { id: routeParam(req, "id") } });
    res.status(204).send();
  })
);

adminRouter.get(
  "/products",
  asyncHandler(async (req, res) => {
    const workflowParam = typeof req.query.workflow === "string" ? req.query.workflow : undefined;
    const statusParam = typeof req.query.status === "string" ? req.query.status : undefined;
    const searchParam = typeof req.query.search === "string" ? req.query.search.trim() : undefined;
    const categoryParam = typeof req.query.category === "string" ? req.query.category : undefined;

    const where: Prisma.ProductWhereInput = {};

    if (workflowParam && workflowParam !== "all") {
      const normalized = workflowParam.toUpperCase() as ProductWorkflowStatus;
      if (normalized in ProductWorkflowStatus) {
        where.workflowStatus = normalized;
      }
    }

    if (statusParam) {
      const normalized = statusParam.toUpperCase().replace(/\s+/g, "_") as ProductStatus;
      if (normalized in ProductStatus) {
        where.status = normalized;
      }
    }

    if (searchParam) {
      where.OR = [
        { title: { contains: searchParam, mode: "insensitive" } },
        { slug: { contains: searchParam, mode: "insensitive" } },
      ];
    }

    if (categoryParam) {
      where.categories = { some: { category: { slug: categoryParam } } };
    }

    const items = await prisma.product.findMany({
      where,
      include: productInclude,
      orderBy: { updatedAt: "desc" },
    });

    // Counts per workflow bucket for the admin list UI ("All / Draft / Published" tabs).
    const [draftCount, publishedCount] = await Promise.all([
      prisma.product.count({ where: { workflowStatus: "DRAFT" } }),
      prisma.product.count({ where: { workflowStatus: "PUBLISHED" } }),
    ]);

    res.json({
      items: items.map(serializeProduct),
      counts: {
        all: draftCount + publishedCount,
        draft: draftCount,
        published: publishedCount,
      },
    });
  })
);

const productBulkSchema = z.object({
  action: z.enum(["publish", "unpublish", "delete"]),
  ids: z.array(z.string().min(1)).min(1),
});

adminRouter.post(
  "/products/bulk",
  asyncHandler(async (req, res) => {
    const payload = parseBody(productBulkSchema, req.body);

    if (payload.action === "delete") {
      // Deletes are SUPER_ADMIN-only, matching the single-delete route.
      if (req.admin?.role !== "SUPER_ADMIN") {
        throw new HttpError(403, "Only super admins can delete products");
      }
      await prisma.product.deleteMany({ where: { id: { in: payload.ids } } });
      res.json({ ok: true, count: payload.ids.length });
      return;
    }

    // Publish + unpublish require publishing privileges (same as single-product updates).
    assertCanManagePublishing(req.admin?.role, {
      workflowStatus: payload.action === "publish" ? "PUBLISHED" : "DRAFT",
    });

    const now = new Date();

    if (payload.action === "publish") {
      // Stamp publishedAt only for rows that don't have one yet, preserving
      // first-publish semantics. Two-step because Prisma updateMany cannot
      // express "set field only where currently null" inline.
      await prisma.product.updateMany({
        where: { id: { in: payload.ids }, publishedAt: null },
        data: { publishedAt: now },
      });
      await prisma.product.updateMany({
        where: { id: { in: payload.ids } },
        data: { workflowStatus: "PUBLISHED" },
      });
    } else {
      await prisma.product.updateMany({
        where: { id: { in: payload.ids } },
        data: { workflowStatus: "DRAFT" },
      });
    }

    res.json({ ok: true, count: payload.ids.length });
  })
);

adminRouter.get(
  "/products/:id",
  asyncHandler(async (req, res) => {
    const item = await prisma.product.findUnique({
      where: { id: routeParam(req, "id") },
      include: productInclude,
    });

    if (!item) {
      throw new HttpError(404, "Product not found");
    }

    res.json({ item: serializeProduct(item) });
  })
);

adminRouter.post(
  "/products",
  asyncHandler(async (req, res) => {
    const payload = parseBody(productInputSchema, req.body);
    assertCanManagePublishing(req.admin?.role, {
      publishedAt: payload.publishedAt,
      workflowStatus: payload.workflowStatus,
    });

    const isPublishing = payload.workflowStatus === "PUBLISHED";

    let item;
    try {
      item = await prisma.product.create({
        data: {
          slug: payload.slug,
          title: payload.title,
          shortDescription: payload.shortDescription,
          longDescription: payload.longDescription,
          type: payload.type,
          material: payload.material ?? null,
          useCase: payload.useCase,
          priceAmount: payload.priceAmount,
          currency: payload.currency,
          status: payload.status,
          workflowStatus: payload.workflowStatus ?? "DRAFT",
          releaseDate: payload.releaseDate ? new Date(payload.releaseDate) : null,
          seoTitle: payload.seoTitle,
          seoDescription: payload.seoDescription,
          imageAlt: payload.imageAlt,
          ctaLabel: payload.ctaLabel,
          metadataJson: payload.metadata,
          // Auto-stamp publishedAt on first publish if not explicitly supplied.
          publishedAt: payload.publishedAt
            ? new Date(payload.publishedAt)
            : isPublishing
              ? new Date()
              : null,
          primaryImageId: payload.primaryImageId,
          weightGrams: payload.weightGrams ?? null,
          lengthCm: payload.lengthCm ?? null,
          breadthCm: payload.breadthCm ?? null,
          heightCm: payload.heightCm ?? null,
          hsnCode: payload.hsnCode ?? null,
        },
        include: productInclude,
      });
    } catch (error) {
      throwIfSlugCollision(error);
    }

    // Best-effort auto-assign to the default bridge page keyed by product
    // type. Only runs on create, not update (Decision #28). Failure is
    // logged and swallowed — the product save itself is the primary
    // contract, and admin can always add/remove bridge links manually.
    if (item) {
      const defaultBridgeSlug = defaultBridgeSlugForProductType(payload.type);
      if (defaultBridgeSlug) {
        try {
          const bridgePage = await prisma.shopBridgePage.findUnique({
            where: { slug: defaultBridgeSlug },
            select: { id: true },
          });
          if (bridgePage) {
            const existingMax = await prisma.shopBridgePageProduct.aggregate({
              where: { bridgePageId: bridgePage.id },
              _max: { sortOrder: true },
            });
            await prisma.shopBridgePageProduct.create({
              data: {
                bridgePageId: bridgePage.id,
                productId: item.id,
                sortOrder: (existingMax._max.sortOrder ?? -1) + 1,
              },
            });
            // Re-fetch so the response reflects the new link. Admin UI
            // that consumes the 201 body sees the auto-assignment
            // immediately without a separate round trip.
            item = await prisma.product.findUniqueOrThrow({
              where: { id: item.id },
              include: productInclude,
            });
          }
        } catch (error) {
          console.warn(
            "[admin/products] auto-assign to default bridge page failed:",
            error,
          );
        }
      }
    }

    res.status(201).json({ item: serializeProduct(item) });
  })
);

adminRouter.patch(
  "/products/:id",
  asyncHandler(async (req, res) => {
    const payload = parseBody(productInputSchema.partial(), req.body);
    assertCanManagePublishing(req.admin?.role, {
      publishedAt: payload.publishedAt ?? undefined,
      workflowStatus: payload.workflowStatus ?? undefined,
    });

    const id = routeParam(req, "id")!;

    // If caller is transitioning to PUBLISHED and did not explicitly supply
    // publishedAt, stamp it with now() on first publish (leave untouched if
    // the product was already published before).
    let publishedAtUpdate: Prisma.ProductUpdateInput["publishedAt"] = undefined;
    if (payload.publishedAt !== undefined) {
      publishedAtUpdate = payload.publishedAt ? new Date(payload.publishedAt) : null;
    } else if (payload.workflowStatus === "PUBLISHED") {
      const existing = await prisma.product.findUnique({
        where: { id },
        select: { publishedAt: true },
      });
      if (existing && !existing.publishedAt) {
        publishedAtUpdate = new Date();
      }
    }

    let item;
    try {
      item = await prisma.product.update({
        where: { id },
        data: {
          ...(payload.slug !== undefined ? { slug: payload.slug } : {}),
          ...(payload.title !== undefined ? { title: payload.title } : {}),
          ...(payload.shortDescription !== undefined ? { shortDescription: payload.shortDescription } : {}),
          ...(payload.longDescription !== undefined ? { longDescription: payload.longDescription } : {}),
          ...(payload.type !== undefined ? { type: payload.type } : {}),
          ...(payload.material !== undefined ? { material: payload.material } : {}),
          ...(payload.useCase !== undefined ? { useCase: payload.useCase } : {}),
          ...(payload.priceAmount !== undefined ? { priceAmount: payload.priceAmount } : {}),
          ...(payload.currency !== undefined ? { currency: payload.currency } : {}),
          ...(payload.status !== undefined ? { status: payload.status } : {}),
          ...(payload.workflowStatus !== undefined ? { workflowStatus: payload.workflowStatus } : {}),
          ...(payload.releaseDate !== undefined ? { releaseDate: payload.releaseDate ? new Date(payload.releaseDate) : null } : {}),
          ...(payload.seoTitle !== undefined ? { seoTitle: payload.seoTitle } : {}),
          ...(payload.seoDescription !== undefined ? { seoDescription: payload.seoDescription } : {}),
          ...(payload.imageAlt !== undefined ? { imageAlt: payload.imageAlt } : {}),
          ...(payload.ctaLabel !== undefined ? { ctaLabel: payload.ctaLabel } : {}),
          ...(payload.metadata !== undefined ? { metadataJson: payload.metadata } : {}),
          ...(publishedAtUpdate !== undefined ? { publishedAt: publishedAtUpdate } : {}),
          ...(payload.primaryImageId !== undefined ? { primaryImageId: payload.primaryImageId } : {}),
          ...(payload.weightGrams !== undefined ? { weightGrams: payload.weightGrams } : {}),
          ...(payload.lengthCm !== undefined ? { lengthCm: payload.lengthCm } : {}),
          ...(payload.breadthCm !== undefined ? { breadthCm: payload.breadthCm } : {}),
          ...(payload.heightCm !== undefined ? { heightCm: payload.heightCm } : {}),
          ...(payload.hsnCode !== undefined ? { hsnCode: payload.hsnCode } : {}),
        },
        include: productInclude,
      });
    } catch (error) {
      throwIfSlugCollision(error);
    }

    res.json({ item: serializeProduct(item) });
  })
);

adminRouter.delete(
  "/products/:id",
  requireAdminRole("SUPER_ADMIN"),
  asyncHandler(async (req, res) => {
    await prisma.product.delete({ where: { id: routeParam(req, "id") } });
    res.status(204).send();
  })
);

adminRouter.put(
  "/products/:id/media",
  asyncHandler(async (req, res) => {
    const payload = parseBody(productMediaSchema, req.body);
    const productId = routeParam(req, "id");

    await prisma.$transaction([
      prisma.product.update({
        where: { id: productId },
        data: {
          primaryImageId: payload.primaryImageId ?? null,
        },
      }),
      prisma.productMedia.deleteMany({ where: { productId } }),
      ...(payload.items.length > 0
        ? [
            prisma.productMedia.createMany({
              data: payload.items.map((item) => ({
                productId,
                mediaAssetId: item.mediaAssetId,
                sortOrder: item.sortOrder,
                mediaType: item.mediaType,
              })),
            }),
          ]
        : []),
    ]);

    const item = await prisma.product.findUnique({
      where: { id: productId },
      include: productInclude,
    });

    if (!item) {
      throw new HttpError(404, "Product not found");
    }

    res.json({ item: serializeProduct(item) });
  })
);

adminRouter.put(
  "/products/:id/categories",
  asyncHandler(async (req, res) => {
    const payload = parseBody(categoryAssignmentsSchema, req.body);
    const productId = routeParam(req, "id");

    await prisma.$transaction([
      prisma.productCategoryMembership.deleteMany({ where: { productId } }),
      ...(payload.assignments.length > 0
        ? [
            prisma.productCategoryMembership.createMany({
              data: payload.assignments.map((assignment) => ({
                productId,
                categoryId: assignment.categoryId,
                sortOrder: assignment.sortOrder,
              })),
            }),
          ]
        : []),
    ]);

    const item = await prisma.product.findUnique({
      where: { id: productId },
      include: productInclude,
    });

    if (!item) {
      throw new HttpError(404, "Product not found");
    }

    res.json({ item: serializeProduct(item) });
  })
);

adminRouter.put(
  "/products/:id/collections",
  asyncHandler(async (req, res) => {
    const payload = parseBody(collectionAssignmentsSchema, req.body);
    const productId = routeParam(req, "id");

    await prisma.$transaction([
      prisma.collectionProductLink.deleteMany({ where: { productId } }),
      ...(payload.assignments.length > 0
        ? [
            prisma.collectionProductLink.createMany({
              data: payload.assignments.map((assignment) => ({
                productId,
                collectionId: assignment.collectionId,
                sortOrder: assignment.sortOrder,
              })),
            }),
          ]
        : []),
    ]);

    const item = await prisma.product.findUnique({
      where: { id: productId },
      include: productInclude,
    });

    if (!item) {
      throw new HttpError(404, "Product not found");
    }

    res.json({ item: serializeProduct(item) });
  })
);

adminRouter.put(
  "/products/:id/bridge-pages",
  asyncHandler(async (req, res) => {
    const payload = parseBody(bridgePageAssignmentsSchema, req.body);
    const productId = routeParam(req, "id");

    await prisma.$transaction([
      prisma.shopBridgePageProduct.deleteMany({ where: { productId } }),
      ...(payload.assignments.length > 0
        ? [
            prisma.shopBridgePageProduct.createMany({
              data: payload.assignments.map((assignment) => ({
                productId,
                bridgePageId: assignment.bridgePageId,
                sortOrder: assignment.sortOrder,
              })),
            }),
          ]
        : []),
    ]);

    const item = await prisma.product.findUnique({
      where: { id: productId },
      include: productInclude,
    });

    if (!item) {
      throw new HttpError(404, "Product not found");
    }

    res.json({ item: serializeProduct(item) });
  })
);

adminRouter.post(
  "/product-options",
  asyncHandler(async (req, res) => {
    const payload = parseBody(productOptionSchema, req.body);
    const item = await prisma.productOption.create({
      data: {
        productId: payload.productId,
        code: payload.code,
        label: payload.label,
        selectionMode: payload.selectionMode,
        required: payload.required,
        sortOrder: payload.sortOrder,
        metadataJson: payload.metadata,
      },
      include: { values: true },
    });

    res.status(201).json({ item });
  })
);

adminRouter.patch(
  "/product-options/:id",
  asyncHandler(async (req, res) => {
    const payload = parseBody(productOptionSchema.partial(), req.body);
    const item = await prisma.productOption.update({
      where: { id: routeParam(req, "id") },
      data: {
        ...(payload.productId !== undefined ? { productId: payload.productId } : {}),
        ...(payload.code !== undefined ? { code: payload.code } : {}),
        ...(payload.label !== undefined ? { label: payload.label } : {}),
        ...(payload.selectionMode !== undefined ? { selectionMode: payload.selectionMode } : {}),
        ...(payload.required !== undefined ? { required: payload.required } : {}),
        ...(payload.sortOrder !== undefined ? { sortOrder: payload.sortOrder } : {}),
        ...(payload.metadata !== undefined ? { metadataJson: payload.metadata } : {}),
      },
      include: { values: true },
    });

    res.json({ item });
  })
);

adminRouter.delete(
  "/product-options/:id",
  requireAdminRole("SUPER_ADMIN"),
  asyncHandler(async (req, res) => {
    await prisma.productOption.delete({ where: { id: routeParam(req, "id") } });
    res.status(204).send();
  })
);

adminRouter.post(
  "/product-option-values",
  asyncHandler(async (req, res) => {
    const payload = parseBody(productOptionValueSchema, req.body);
    const item = await prisma.productOptionValue.create({ data: payload });
    res.status(201).json({ item });
  })
);

adminRouter.patch(
  "/product-option-values/:id",
  asyncHandler(async (req, res) => {
    const payload = parseBody(productOptionValueSchema.partial(), req.body);
    const item = await prisma.productOptionValue.update({
      where: { id: routeParam(req, "id") },
      data: payload,
    });
    res.json({ item });
  })
);

adminRouter.delete(
  "/product-option-values/:id",
  requireAdminRole("SUPER_ADMIN"),
  asyncHandler(async (req, res) => {
    await prisma.productOptionValue.delete({ where: { id: routeParam(req, "id") } });
    res.status(204).send();
  })
);

adminRouter.get(
  "/bridge-pages",
  asyncHandler(async (_req, res) => {
    const items = await prisma.shopBridgePage.findMany({
      include: bridgePageInclude,
      orderBy: { navLabel: "asc" },
    });
    res.json({ items: items.map(serializeBridgePage) });
  })
);

adminRouter.get(
  "/bridge-pages/:id",
  asyncHandler(async (req, res) => {
    const item = await prisma.shopBridgePage.findUnique({
      where: { id: routeParam(req, "id") },
      include: bridgePageInclude,
    });

    if (!item) {
      throw new HttpError(404, "Bridge page not found");
    }

    res.json({ item: serializeBridgePage(item) });
  })
);

adminRouter.post(
  "/bridge-pages",
  asyncHandler(async (req, res) => {
    const payload = parseBody(bridgePageSchema, req.body);
    const item = await prisma.shopBridgePage.create({
      data: {
        slug: payload.slug,
        navLabel: payload.navLabel,
        heroEyebrow: payload.heroEyebrow,
        heroTitle: payload.heroTitle,
        heroDescriptionJson: payload.heroDescription,
        heroImage: payload.heroImage ?? "",
        heroImageAlt: payload.heroImageAlt ?? "",
        heroImagePosition: payload.heroImagePosition,
        heroQuote: payload.heroQuote,
        introEyebrow: payload.introEyebrow,
        introTitle: payload.introTitle,
        introDescription: payload.introDescription,
        interludeImage: payload.interludeImage,
        interludeImageAlt: payload.interludeImageAlt,
        productSectionEyebrow: payload.productSectionEyebrow,
        productSectionTitle: payload.productSectionTitle,
        productSectionDescription: payload.productSectionDescription,
        postCtaTitle: payload.postCtaTitle,
        postCtaDescription: payload.postCtaDescription,
        postCtaPrimaryLabel: payload.postCtaPrimaryLabel,
        postCtaPrimaryHref: payload.postCtaPrimaryHref,
        postCtaSecondaryLabel: payload.postCtaSecondaryLabel,
        postCtaSecondaryHref: payload.postCtaSecondaryHref,
        seoTitle: payload.seoTitle,
        seoDescription: payload.seoDescription,
        seoFootnote: payload.seoFootnote,
        contentJson: payload.content,
        homeCard1Image: payload.homeCard1Image,
        homeCard1Alt: payload.homeCard1Alt,
        homeCard2Image: payload.homeCard2Image,
        homeCard2Alt: payload.homeCard2Alt,
        homeCard3Image: payload.homeCard3Image,
        homeCard3Alt: payload.homeCard3Alt,
        homeCard4Image: payload.homeCard4Image,
        homeCard4Alt: payload.homeCard4Alt,
        ritualVideo1Url: payload.ritualVideo1Url,
        ritualVideo1Poster: payload.ritualVideo1Poster,
        ritualVideo2Url: payload.ritualVideo2Url,
        ritualVideo2Poster: payload.ritualVideo2Poster,
        formCard1Image: payload.formCard1Image,
        formCard1Alt: payload.formCard1Alt,
        formCard2Image: payload.formCard2Image,
        formCard2Alt: payload.formCard2Alt,
        formCard3Image: payload.formCard3Image,
        formCard3Alt: payload.formCard3Alt,
        formCard4Image: payload.formCard4Image,
        formCard4Alt: payload.formCard4Alt,
        imageBreak1Image: payload.imageBreak1Image,
        imageBreak1Alt: payload.imageBreak1Alt,
        imageBreak2Image: payload.imageBreak2Image,
        imageBreak2Alt: payload.imageBreak2Alt,
        imageBreak3Image: payload.imageBreak3Image,
        imageBreak3Alt: payload.imageBreak3Alt,
      },
      include: bridgePageInclude,
    });

    res.status(201).json({ item: serializeBridgePage(item) });
  })
);

adminRouter.patch(
  "/bridge-pages/:id",
  asyncHandler(async (req, res) => {
    const payload = parseBody(bridgePageSchema.partial(), req.body);
    const item = await prisma.shopBridgePage.update({
      where: { id: routeParam(req, "id") },
      data: {
        ...(payload.slug !== undefined ? { slug: payload.slug } : {}),
        ...(payload.navLabel !== undefined ? { navLabel: payload.navLabel } : {}),
        ...(payload.heroEyebrow !== undefined ? { heroEyebrow: payload.heroEyebrow } : {}),
        ...(payload.heroTitle !== undefined ? { heroTitle: payload.heroTitle } : {}),
        ...(payload.heroDescription !== undefined ? { heroDescriptionJson: payload.heroDescription } : {}),
        ...(payload.heroImage !== undefined ? { heroImage: payload.heroImage } : {}),
        ...(payload.heroImageAlt !== undefined ? { heroImageAlt: payload.heroImageAlt } : {}),
        ...(payload.heroImagePosition !== undefined ? { heroImagePosition: payload.heroImagePosition } : {}),
        ...(payload.heroQuote !== undefined ? { heroQuote: payload.heroQuote } : {}),
        ...(payload.introEyebrow !== undefined ? { introEyebrow: payload.introEyebrow } : {}),
        ...(payload.introTitle !== undefined ? { introTitle: payload.introTitle } : {}),
        ...(payload.introDescription !== undefined ? { introDescription: payload.introDescription } : {}),
        ...(payload.interludeImage !== undefined ? { interludeImage: payload.interludeImage } : {}),
        ...(payload.interludeImageAlt !== undefined ? { interludeImageAlt: payload.interludeImageAlt } : {}),
        ...(payload.productSectionEyebrow !== undefined ? { productSectionEyebrow: payload.productSectionEyebrow } : {}),
        ...(payload.productSectionTitle !== undefined ? { productSectionTitle: payload.productSectionTitle } : {}),
        ...(payload.productSectionDescription !== undefined ? { productSectionDescription: payload.productSectionDescription } : {}),
        ...(payload.postCtaTitle !== undefined ? { postCtaTitle: payload.postCtaTitle } : {}),
        ...(payload.postCtaDescription !== undefined ? { postCtaDescription: payload.postCtaDescription } : {}),
        ...(payload.postCtaPrimaryLabel !== undefined ? { postCtaPrimaryLabel: payload.postCtaPrimaryLabel } : {}),
        ...(payload.postCtaPrimaryHref !== undefined ? { postCtaPrimaryHref: payload.postCtaPrimaryHref } : {}),
        ...(payload.postCtaSecondaryLabel !== undefined ? { postCtaSecondaryLabel: payload.postCtaSecondaryLabel } : {}),
        ...(payload.postCtaSecondaryHref !== undefined ? { postCtaSecondaryHref: payload.postCtaSecondaryHref } : {}),
        ...(payload.seoTitle !== undefined ? { seoTitle: payload.seoTitle } : {}),
        ...(payload.seoDescription !== undefined ? { seoDescription: payload.seoDescription } : {}),
        ...(payload.seoFootnote !== undefined ? { seoFootnote: payload.seoFootnote } : {}),
        ...(payload.content !== undefined ? { contentJson: payload.content } : {}),
        ...(payload.homeCard1Image !== undefined ? { homeCard1Image: payload.homeCard1Image } : {}),
        ...(payload.homeCard1Alt !== undefined ? { homeCard1Alt: payload.homeCard1Alt } : {}),
        ...(payload.homeCard2Image !== undefined ? { homeCard2Image: payload.homeCard2Image } : {}),
        ...(payload.homeCard2Alt !== undefined ? { homeCard2Alt: payload.homeCard2Alt } : {}),
        ...(payload.homeCard3Image !== undefined ? { homeCard3Image: payload.homeCard3Image } : {}),
        ...(payload.homeCard3Alt !== undefined ? { homeCard3Alt: payload.homeCard3Alt } : {}),
        ...(payload.homeCard4Image !== undefined ? { homeCard4Image: payload.homeCard4Image } : {}),
        ...(payload.homeCard4Alt !== undefined ? { homeCard4Alt: payload.homeCard4Alt } : {}),
        ...(payload.ritualVideo1Url !== undefined ? { ritualVideo1Url: payload.ritualVideo1Url } : {}),
        ...(payload.ritualVideo1Poster !== undefined ? { ritualVideo1Poster: payload.ritualVideo1Poster } : {}),
        ...(payload.ritualVideo2Url !== undefined ? { ritualVideo2Url: payload.ritualVideo2Url } : {}),
        ...(payload.ritualVideo2Poster !== undefined ? { ritualVideo2Poster: payload.ritualVideo2Poster } : {}),
        ...(payload.formCard1Image !== undefined ? { formCard1Image: payload.formCard1Image } : {}),
        ...(payload.formCard1Alt !== undefined ? { formCard1Alt: payload.formCard1Alt } : {}),
        ...(payload.formCard2Image !== undefined ? { formCard2Image: payload.formCard2Image } : {}),
        ...(payload.formCard2Alt !== undefined ? { formCard2Alt: payload.formCard2Alt } : {}),
        ...(payload.formCard3Image !== undefined ? { formCard3Image: payload.formCard3Image } : {}),
        ...(payload.formCard3Alt !== undefined ? { formCard3Alt: payload.formCard3Alt } : {}),
        ...(payload.formCard4Image !== undefined ? { formCard4Image: payload.formCard4Image } : {}),
        ...(payload.formCard4Alt !== undefined ? { formCard4Alt: payload.formCard4Alt } : {}),
        ...(payload.imageBreak1Image !== undefined ? { imageBreak1Image: payload.imageBreak1Image } : {}),
        ...(payload.imageBreak1Alt !== undefined ? { imageBreak1Alt: payload.imageBreak1Alt } : {}),
        ...(payload.imageBreak2Image !== undefined ? { imageBreak2Image: payload.imageBreak2Image } : {}),
        ...(payload.imageBreak2Alt !== undefined ? { imageBreak2Alt: payload.imageBreak2Alt } : {}),
        ...(payload.imageBreak3Image !== undefined ? { imageBreak3Image: payload.imageBreak3Image } : {}),
        ...(payload.imageBreak3Alt !== undefined ? { imageBreak3Alt: payload.imageBreak3Alt } : {}),
      },
      include: bridgePageInclude,
    });

    res.json({ item: serializeBridgePage(item) });
  })
);

adminRouter.put(
  "/bridge-pages/:id/products",
  asyncHandler(async (req, res) => {
    const payload = parseBody(bridgePageProductsSchema, req.body);
    const bridgePageId = routeParam(req, "id");

    await prisma.$transaction([
      prisma.shopBridgePageProduct.deleteMany({ where: { bridgePageId } }),
      ...(payload.assignments.length > 0
        ? [
            prisma.shopBridgePageProduct.createMany({
              data: payload.assignments.map((assignment) => ({
                bridgePageId,
                productId: assignment.productId,
                sortOrder: assignment.sortOrder,
              })),
            }),
          ]
        : []),
    ]);

    const item = await prisma.shopBridgePage.findUnique({
      where: { id: bridgePageId },
      include: bridgePageInclude,
    });

    if (!item) {
      throw new HttpError(404, "Bridge page not found");
    }

    res.json({ item: serializeBridgePage(item) });
  })
);

adminRouter.delete(
  "/bridge-pages/:id",
  requireAdminRole("SUPER_ADMIN"),
  asyncHandler(async (req, res) => {
    await prisma.shopBridgePage.delete({ where: { id: routeParam(req, "id") } });
    res.status(204).send();
  })
);

adminRouter.get(
  "/articles",
  asyncHandler(async (_req, res) => {
    const items = await prisma.article.findMany({
      include: { primaryImage: true },
      orderBy: [{ featured: "desc" }, { publishedAt: "desc" }],
    });
    res.json({ items: items.map(serializeArticle) });
  })
);

adminRouter.post(
  "/articles",
  asyncHandler(async (req, res) => {
    const payload = parseBody(articleSchema, req.body);
    assertCanManagePublishing(req.admin?.role, payload);
    const item = await prisma.article.create({
      data: {
        ...payload,
        publishedAt: payload.publishedAt ? new Date(payload.publishedAt) : null,
      },
      include: { primaryImage: true },
    });
    res.status(201).json({ item: serializeArticle(item) });
  })
);

adminRouter.patch(
  "/articles/:id",
  asyncHandler(async (req, res) => {
    const payload = parseBody(articleSchema.partial(), req.body);
    assertCanManagePublishing(req.admin?.role, {
      status: payload.status,
      publishedAt: payload.publishedAt ?? undefined,
    });
    const item = await prisma.article.update({
      where: { id: routeParam(req, "id") },
      data: {
        ...payload,
        ...(payload.publishedAt !== undefined ? { publishedAt: payload.publishedAt ? new Date(payload.publishedAt) : null } : {}),
      },
      include: { primaryImage: true },
    });
    res.json({ item: serializeArticle(item) });
  })
);

adminRouter.delete(
  "/articles/:id",
  requireAdminRole("SUPER_ADMIN"),
  asyncHandler(async (req, res) => {
    await prisma.article.delete({ where: { id: routeParam(req, "id") } });
    res.status(204).send();
  })
);

adminRouter.get(
  "/retreats",
  asyncHandler(async (_req, res) => {
    const items = await prisma.retreat.findMany({ include: { primaryImage: true }, orderBy: { name: "asc" } });
    res.json({ items: items.map(serializeRetreat) });
  })
);

adminRouter.post(
  "/retreats",
  asyncHandler(async (req, res) => {
    const payload = parseBody(retreatSchema, req.body);
    assertCanManagePublishing(req.admin?.role, { status: payload.status });
    const item = await prisma.retreat.create({
      data: payload,
      include: { primaryImage: true },
    });
    res.status(201).json({ item: serializeRetreat(item) });
  })
);

adminRouter.patch(
  "/retreats/:id",
  asyncHandler(async (req, res) => {
    const payload = parseBody(retreatSchema.partial(), req.body);
    assertCanManagePublishing(req.admin?.role, { status: payload.status });
    const item = await prisma.retreat.update({
      where: { id: routeParam(req, "id") },
      data: payload,
      include: { primaryImage: true },
    });
    res.json({ item: serializeRetreat(item) });
  })
);

adminRouter.delete(
  "/retreats/:id",
  requireAdminRole("SUPER_ADMIN"),
  asyncHandler(async (req, res) => {
    await prisma.retreat.delete({ where: { id: routeParam(req, "id") } });
    res.status(204).send();
  })
);

adminRouter.get(
  "/programs",
  asyncHandler(async (_req, res) => {
    const items = await prisma.program.findMany({ include: { sessions: true }, orderBy: { name: "asc" } });
    res.json({ items: items.map(serializeProgram) });
  })
);

adminRouter.post(
  "/programs",
  asyncHandler(async (req, res) => {
    const payload = parseBody(programSchema, req.body);
    assertCanManagePublishing(req.admin?.role, { status: payload.status });
    const item = await prisma.program.create({
      data: payload,
      include: { sessions: true },
    });
    res.status(201).json({ item: serializeProgram(item) });
  })
);

adminRouter.patch(
  "/programs/:id",
  asyncHandler(async (req, res) => {
    const payload = parseBody(programSchema.partial(), req.body);
    assertCanManagePublishing(req.admin?.role, { status: payload.status });
    const item = await prisma.program.update({
      where: { id: routeParam(req, "id") },
      data: payload,
      include: { sessions: true },
    });
    res.json({ item: serializeProgram(item) });
  })
);

adminRouter.delete(
  "/programs/:id",
  requireAdminRole("SUPER_ADMIN"),
  asyncHandler(async (req, res) => {
    await prisma.program.delete({ where: { id: routeParam(req, "id") } });
    res.status(204).send();
  })
);

adminRouter.get(
  "/program-sessions",
  asyncHandler(async (_req, res) => {
    const items = await prisma.programSession.findMany({
      include: { program: true },
      orderBy: { startsAt: "asc" },
    });
    res.json({ items });
  })
);

adminRouter.post(
  "/program-sessions",
  asyncHandler(async (req, res) => {
    const payload = parseBody(programSessionSchema, req.body);
    const item = await prisma.programSession.create({
      data: {
        ...payload,
        startsAt: new Date(payload.startsAt),
        endsAt: new Date(payload.endsAt),
      },
      include: { program: true },
    });
    res.status(201).json({ item });
  })
);

adminRouter.patch(
  "/program-sessions/:id",
  asyncHandler(async (req, res) => {
    const payload = parseBody(programSessionSchema.partial(), req.body);
    const item = await prisma.programSession.update({
      where: { id: routeParam(req, "id") },
      data: {
        ...(payload.programId !== undefined ? { programId: payload.programId } : {}),
        ...(payload.startsAt !== undefined ? { startsAt: new Date(payload.startsAt) } : {}),
        ...(payload.endsAt !== undefined ? { endsAt: new Date(payload.endsAt) } : {}),
        ...(payload.timezone !== undefined ? { timezone: payload.timezone } : {}),
        ...(payload.city !== undefined ? { city: payload.city } : {}),
        ...(payload.venueName !== undefined ? { venueName: payload.venueName } : {}),
        ...(payload.capacity !== undefined ? { capacity: payload.capacity } : {}),
        ...(payload.spotsRemaining !== undefined ? { spotsRemaining: payload.spotsRemaining } : {}),
        ...(payload.status !== undefined ? { status: payload.status } : {}),
      },
      include: { program: true },
    });
    res.json({ item });
  })
);

adminRouter.delete(
  "/program-sessions/:id",
  requireAdminRole("SUPER_ADMIN"),
  asyncHandler(async (req, res) => {
    await prisma.programSession.delete({ where: { id: routeParam(req, "id") } });
    res.status(204).send();
  })
);

adminRouter.get(
  "/collections",
  asyncHandler(async (_req, res) => {
    const items = await prisma.collection.findMany({
      include: {
        products: {
          include: {
            product: true,
          },
        },
      },
      orderBy: { name: "asc" },
    });
    res.json({ items: items.map(serializeCollection) });
  })
);

adminRouter.post(
  "/collections",
  asyncHandler(async (req, res) => {
    const payload = parseBody(collectionSchema, req.body);
    const item = await prisma.collection.create({ data: payload, include: { products: { include: { product: true } } } });
    res.status(201).json({ item: serializeCollection(item) });
  })
);

adminRouter.patch(
  "/collections/:id",
  asyncHandler(async (req, res) => {
    const payload = parseBody(collectionSchema.partial(), req.body);
    const item = await prisma.collection.update({
      where: { id: routeParam(req, "id") },
      data: payload,
      include: { products: { include: { product: true } } },
    });
    res.json({ item: serializeCollection(item) });
  })
);

adminRouter.delete(
  "/collections/:id",
  requireAdminRole("SUPER_ADMIN"),
  asyncHandler(async (req, res) => {
    await prisma.collection.delete({ where: { id: routeParam(req, "id") } });
    res.status(204).send();
  })
);

adminRouter.get(
  "/site-settings",
  requireAdminRole("SUPER_ADMIN"),
  asyncHandler(async (_req, res) => {
    const item = await prisma.siteSetting.findUnique({
      where: { key: "default" },
      include: { logoImage: true },
    });

    if (!item) {
      throw new HttpError(404, "Site settings not found");
    }

    res.json({ item: serializeSiteSettings(item) });
  })
);

adminRouter.put(
  "/site-settings",
  requireAdminRole("SUPER_ADMIN"),
  asyncHandler(async (req, res) => {
    const payload = parseBody(siteSettingsSchema, req.body);
    const item = await prisma.siteSetting.upsert({
      where: { key: "default" },
      update: {
        footerEmail: payload.footerEmail,
        footerPhone: payload.footerPhone,
        addressLinesJson: payload.addressLines,
        newsletterHeading: payload.newsletterHeading,
        newsletterBody: payload.newsletterBody,
        miscJson: payload.misc,
        logoImageId: payload.logoImageId,
      },
      create: {
        key: "default",
        footerEmail: payload.footerEmail,
        footerPhone: payload.footerPhone,
        addressLinesJson: payload.addressLines,
        newsletterHeading: payload.newsletterHeading,
        newsletterBody: payload.newsletterBody,
        miscJson: payload.misc,
        logoImageId: payload.logoImageId,
      },
      include: { logoImage: true },
    });

    res.json({ item: serializeSiteSettings(item) });
  })
);

// Shipping settings (Shiprocket integration — Decision #34). SUPER_ADMIN
// only because the pickup location and auto-push toggle have real
// dispatch consequences. Singleton row keyed by "default" — upserted
// so the page is always reachable even on a fresh install.
adminRouter.get(
  "/shipping-settings",
  requireAdminRole("SUPER_ADMIN"),
  asyncHandler(async (_req, res) => {
    const item = await prisma.shippingSetting.upsert({
      where: { key: "default" },
      update: {},
      create: { key: "default" },
    });
    res.json({ item: serializeShippingSetting(item) });
  })
);

adminRouter.put(
  "/shipping-settings",
  requireAdminRole("SUPER_ADMIN"),
  asyncHandler(async (req, res) => {
    const payload = parseBody(shippingSettingSchema, req.body);
    const item = await prisma.shippingSetting.upsert({
      where: { key: "default" },
      update: {
        ...(payload.pickupLocationName !== undefined ? { pickupLocationName: payload.pickupLocationName } : {}),
        ...(payload.defaultWeightGrams !== undefined ? { defaultWeightGrams: payload.defaultWeightGrams } : {}),
        ...(payload.defaultLengthCm !== undefined ? { defaultLengthCm: payload.defaultLengthCm } : {}),
        ...(payload.defaultBreadthCm !== undefined ? { defaultBreadthCm: payload.defaultBreadthCm } : {}),
        ...(payload.defaultHeightCm !== undefined ? { defaultHeightCm: payload.defaultHeightCm } : {}),
        ...(payload.autoPushEnabled !== undefined ? { autoPushEnabled: payload.autoPushEnabled } : {}),
      },
      create: {
        key: "default",
        pickupLocationName: payload.pickupLocationName ?? null,
        ...(payload.defaultWeightGrams !== undefined ? { defaultWeightGrams: payload.defaultWeightGrams } : {}),
        ...(payload.defaultLengthCm !== undefined ? { defaultLengthCm: payload.defaultLengthCm } : {}),
        ...(payload.defaultBreadthCm !== undefined ? { defaultBreadthCm: payload.defaultBreadthCm } : {}),
        ...(payload.defaultHeightCm !== undefined ? { defaultHeightCm: payload.defaultHeightCm } : {}),
        ...(payload.autoPushEnabled !== undefined ? { autoPushEnabled: payload.autoPushEnabled } : {}),
      },
    });
    res.json({ item: serializeShippingSetting(item) });
  })
);

// Live read from Shiprocket so admin can pick the pickup-location name
// from a dropdown instead of typing it (typos here are the most common
// cause of order-push failures). Single timed call; errors bubble up
// with the upstream message so admin sees what's wrong.
adminRouter.get(
  "/shipping-settings/pickup-locations",
  requireAdminRole("SUPER_ADMIN"),
  asyncHandler(async (_req, res) => {
    const items = await listPickupLocations();
    res.json({ items });
  })
);

// Health check: forces a fresh Shiprocket auth round-trip and persists
// the result on the settings row so the admin page can show an
// at-a-glance indicator across refreshes.
adminRouter.post(
  "/shipping-settings/test-connection",
  requireAdminRole("SUPER_ADMIN"),
  asyncHandler(async (_req, res) => {
    let status = "ok";
    let httpStatus = 200;
    let errorMessage: string | null = null;
    try {
      await testShiprocketAuth();
    } catch (err) {
      status = err instanceof Error ? err.message : "shiprocket_unreachable";
      errorMessage = status;
      httpStatus = 502;
    }
    await prisma.shippingSetting.upsert({
      where: { key: "default" },
      update: { lastTestedAt: new Date(), lastTestStatus: status },
      create: { key: "default", lastTestedAt: new Date(), lastTestStatus: status },
    });
    res.status(httpStatus).json({ ok: errorMessage === null, status, error: errorMessage });
  })
);

adminRouter.get(
  "/lead/order-requests",
  asyncHandler(async (_req, res) => {
    const items = await prisma.orderRequest.findMany({
      include: { items: { include: { product: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ items: items.map(serializeOrderRequest) });
  })
);

adminRouter.patch(
  "/lead/order-requests/:id",
  asyncHandler(async (req, res) => {
    const payload = parseBody(leadStatusSchema, req.body);
    const item = await prisma.orderRequest.update({
      where: { id: routeParam(req, "id") },
      data: { status: payload.status },
      include: { items: { include: { product: true } } },
    });
    res.json({ item: serializeOrderRequest(item) });
  })
);

// Admin retry: re-push a paid order to Shiprocket. Used when the
// fire-and-forget path on payment-success failed (network, missing
// pickup location, etc.). Guarded so duplicate retries can't create
// duplicate Shiprocket orders — see `canPushToShiprocket` in
// shiprocket-dispatch.ts.
adminRouter.post(
  "/lead/order-requests/:id/shiprocket/push",
  asyncHandler(async (req, res) => {
    const id = routeParam(req, "id");
    if (!id) throw new HttpError(400, "missing_id");
    
    const outcome = await pushOrderToShiprocket(id);

    sendOrderConfirmation(id).catch((err) => {
      console.error("[admin/leads] order confirmation crashed", err);
    });
    
    if (!outcome.ok) {
      throw new HttpError(400, outcome.error);
    }
    const item = await prisma.orderRequest.findUnique({
      where: { id },
      include: { items: { include: { product: true } } },
    });
    if (!item) throw new HttpError(404, "order_not_found");
    res.json({ item: serializeOrderRequest(item) });
  })
);

adminRouter.get(
  "/lead/newsletter-subscriptions",
  asyncHandler(async (_req, res) => {
    const items = await prisma.newsletterSubscription.findMany({
      orderBy: { subscribedAt: "desc" },
    });
    res.json({ items });
  })
);

adminRouter.get(
  "/lead/program-reservations",
  asyncHandler(async (_req, res) => {
    const items = await prisma.programReservation.findMany({
      include: { program: true, programSession: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ items });
  })
);

adminRouter.patch(
  "/lead/program-reservations/:id",
  asyncHandler(async (req, res) => {
    const payload = parseBody(leadStatusSchema, req.body);
    const item = await prisma.programReservation.update({
      where: { id: routeParam(req, "id") },
      data: { status: payload.status },
    });
    res.json({ item });
  })
);

adminRouter.get(
  "/lead/retreat-inquiries",
  asyncHandler(async (_req, res) => {
    const items = await prisma.retreatInquiry.findMany({
      include: { retreat: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ items });
  })
);

adminRouter.patch(
  "/lead/retreat-inquiries/:id",
  asyncHandler(async (req, res) => {
    const payload = parseBody(leadStatusSchema, req.body);
    const item = await prisma.retreatInquiry.update({
      where: { id: routeParam(req, "id") },
      data: { status: payload.status },
    });
    res.json({ item });
  })
);

adminRouter.get(
  "/lead/product-notifications",
  asyncHandler(async (_req, res) => {
    const items = await prisma.productNotification.findMany({
      include: { product: { select: { id: true, slug: true, title: true, status: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ items: items.map(serializeProductNotification) });
  })
);

adminRouter.patch(
  "/lead/product-notifications/:id",
  asyncHandler(async (req, res) => {
    const payload = parseBody(leadStatusSchema, req.body);
    const item = await prisma.productNotification.update({
      where: { id: routeParam(req, "id") },
      data: { status: payload.status },
      include: { product: { select: { id: true, slug: true, title: true, status: true } } },
    });
    res.json({ item: serializeProductNotification(item) });
  })
);

adminRouter.get(
  "/lead/bulk-orders",
  asyncHandler(async (_req, res) => {
    const items = await prisma.bulkOrderInquiry.findMany({
      include: { customer: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ items: items.map(serializeBulkOrderInquiry) });
  })
);

adminRouter.patch(
  "/lead/bulk-orders/:id",
  asyncHandler(async (req, res) => {
    const payload = parseBody(leadStatusSchema, req.body);
    const item = await prisma.bulkOrderInquiry.update({
      where: { id: routeParam(req, "id") },
      data: { status: payload.status },
      include: { customer: true },
    });
    res.json({ item: serializeBulkOrderInquiry(item) });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Story (homepage "How Seijaku Works" curation) — Decision #29.
// ─────────────────────────────────────────────────────────────────────────────

const storyInputBaseSchema = z.object({
  perfume1Id: z.string().min(1),
  perfume2Id: z.string().min(1),
  perfume3Id: z.string().min(1),
  artifact1Id: z.string().min(1),
  artifact2Id: z.string().min(1),
  artifact3Id: z.string().min(1),
  launchDate: z.string().datetime(),
  videoUrl: z.string().url().max(500),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

const storyInputSchema = storyInputBaseSchema
  .refine(
    (data) => {
      const perfumes = [data.perfume1Id, data.perfume2Id, data.perfume3Id];
      return new Set(perfumes).size === perfumes.length;
    },
    { message: "Perfume slots must reference three distinct products", path: ["perfume2Id"] },
  )
  .refine(
    (data) => {
      const artifacts = [data.artifact1Id, data.artifact2Id, data.artifact3Id];
      return new Set(artifacts).size === artifacts.length;
    },
    { message: "Artifact slots must reference three distinct products", path: ["artifact2Id"] },
  );

const storyUpdateSchema = storyInputBaseSchema.partial();

const storyInclude = {
  perfume1: { include: productInclude },
  perfume2: { include: productInclude },
  perfume3: { include: productInclude },
  artifact1: { include: productInclude },
  artifact2: { include: productInclude },
  artifact3: { include: productInclude },
} satisfies Prisma.StoryInclude;

const storySummaryInclude = {
  perfume1: { select: { title: true } },
  perfume2: { select: { title: true } },
  perfume3: { select: { title: true } },
  artifact1: { select: { title: true } },
  artifact2: { select: { title: true } },
  artifact3: { select: { title: true } },
} satisfies Prisma.StoryInclude;

// Cross-validate that perfume slots reference perfumes-bridge products and
// artifact slots reference non-perfumes-bridge products. Throws HttpError on
// violation so the admin form can surface a clear message.
async function validateStorySlots(payload: z.infer<typeof storyInputSchema>) {
  const perfumeIds = [payload.perfume1Id, payload.perfume2Id, payload.perfume3Id];
  const artifactIds = [payload.artifact1Id, payload.artifact2Id, payload.artifact3Id];
  const allIds = [...perfumeIds, ...artifactIds];

  const products = await prisma.product.findMany({
    where: { id: { in: allIds } },
    include: { bridgePages: { include: { bridgePage: true } } },
  });

  const byId = new Map(products.map((p) => [p.id, p]));
  for (const id of allIds) {
    if (!byId.has(id)) {
      throw new HttpError(400, `Product not found: ${id}`);
    }
  }

  const isInPerfumesBridge = (id: string) =>
    byId.get(id)!.bridgePages.some((bp) => bp.bridgePage.slug === "perfumes");

  for (const id of perfumeIds) {
    if (!isInPerfumesBridge(id)) {
      throw new HttpError(400, `Perfume slot product is not assigned to /shop/perfumes: ${byId.get(id)!.slug}`);
    }
  }
  for (const id of artifactIds) {
    if (isInPerfumesBridge(id)) {
      throw new HttpError(400, `Artifact slot cannot reference a perfume: ${byId.get(id)!.slug}`);
    }
  }
}

adminRouter.get(
  "/stories",
  asyncHandler(async (_req, res) => {
    const items = await prisma.story.findMany({
      include: storySummaryInclude,
      orderBy: { launchDate: "desc" },
    });
    res.json({ items: items.map(serializeStorySummary) });
  })
);

adminRouter.get(
  "/stories/:id",
  asyncHandler(async (req, res) => {
    const item = await prisma.story.findUnique({
      where: { id: routeParam(req, "id") },
      include: storyInclude,
    });
    if (!item) {
      throw new HttpError(404, "Story not found");
    }
    res.json({ item: serializeStory(item) });
  })
);

adminRouter.post(
  "/stories",
  asyncHandler(async (req, res) => {
    const payload = parseBody(storyInputSchema, req.body);
    await validateStorySlots(payload);

    const item = await prisma.story.create({
      data: {
        perfume1Id: payload.perfume1Id,
        perfume2Id: payload.perfume2Id,
        perfume3Id: payload.perfume3Id,
        artifact1Id: payload.artifact1Id,
        artifact2Id: payload.artifact2Id,
        artifact3Id: payload.artifact3Id,
        launchDate: new Date(payload.launchDate),
        videoUrl: payload.videoUrl,
        status: payload.status ?? "INACTIVE",
      },
      include: storyInclude,
    });
    res.status(201).json({ item: serializeStory(item) });
  })
);

adminRouter.patch(
  "/stories/:id",
  asyncHandler(async (req, res) => {
    const payload = parseBody(storyUpdateSchema, req.body);

    // If any slot id is being changed, re-validate the full set against
    // bridge-page rules. Cheap (one query) and prevents drift.
    const isSlotChange = [
      payload.perfume1Id,
      payload.perfume2Id,
      payload.perfume3Id,
      payload.artifact1Id,
      payload.artifact2Id,
      payload.artifact3Id,
    ].some((v) => v !== undefined);

    if (isSlotChange) {
      const existing = await prisma.story.findUnique({
        where: { id: routeParam(req, "id") },
      });
      if (!existing) {
        throw new HttpError(404, "Story not found");
      }
      await validateStorySlots({
        perfume1Id: payload.perfume1Id ?? existing.perfume1Id,
        perfume2Id: payload.perfume2Id ?? existing.perfume2Id,
        perfume3Id: payload.perfume3Id ?? existing.perfume3Id,
        artifact1Id: payload.artifact1Id ?? existing.artifact1Id,
        artifact2Id: payload.artifact2Id ?? existing.artifact2Id,
        artifact3Id: payload.artifact3Id ?? existing.artifact3Id,
        launchDate: existing.launchDate.toISOString(),
        videoUrl: existing.videoUrl,
      });
    }

    const item = await prisma.story.update({
      where: { id: routeParam(req, "id") },
      data: {
        ...(payload.perfume1Id !== undefined ? { perfume1Id: payload.perfume1Id } : {}),
        ...(payload.perfume2Id !== undefined ? { perfume2Id: payload.perfume2Id } : {}),
        ...(payload.perfume3Id !== undefined ? { perfume3Id: payload.perfume3Id } : {}),
        ...(payload.artifact1Id !== undefined ? { artifact1Id: payload.artifact1Id } : {}),
        ...(payload.artifact2Id !== undefined ? { artifact2Id: payload.artifact2Id } : {}),
        ...(payload.artifact3Id !== undefined ? { artifact3Id: payload.artifact3Id } : {}),
        ...(payload.launchDate !== undefined ? { launchDate: new Date(payload.launchDate) } : {}),
        ...(payload.videoUrl !== undefined ? { videoUrl: payload.videoUrl } : {}),
        ...(payload.status !== undefined ? { status: payload.status } : {}),
      },
      include: storyInclude,
    });
    res.json({ item: serializeStory(item) });
  })
);

adminRouter.delete(
  "/stories/:id",
  requireAdminRole("SUPER_ADMIN"),
  asyncHandler(async (req, res) => {
    await prisma.story.delete({ where: { id: routeParam(req, "id") } });
    res.status(204).send();
  })
);

adminRouter.use((_req, res) => {
  res.status(404).json({ error: "Admin endpoint not found" });
});
