-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'WHATSAPP', 'SMS');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('ORDER_CONFIRMATION', 'PAYMENT_SUCCESS', 'PAYMENT_FAILED', 'SHIPMENT_PICKED_UP', 'SHIPMENT_IN_TRANSIT', 'SHIPMENT_OUT_FOR_DELIVERY', 'SHIPMENT_DELIVERED', 'SHIPMENT_RTO', 'SHIPMENT_FAILED', 'WELCOME', 'WAITLIST_RESTOCK', 'INQUIRY_RECEIVED');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "type" "NotificationType" NOT NULL,
    "recipient" TEXT NOT NULL,
    "providerId" TEXT,
    "variant" TEXT NOT NULL DEFAULT '',
    "status" "NotificationStatus" NOT NULL DEFAULT 'SENT',
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderId" TEXT,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationLog_subjectId_idx" ON "NotificationLog"("subjectId");

-- CreateIndex
CREATE INDEX "NotificationLog_orderId_idx" ON "NotificationLog"("orderId");

-- CreateIndex
CREATE INDEX "NotificationLog_recipient_idx" ON "NotificationLog"("recipient");

-- CreateIndex
CREATE INDEX "NotificationLog_channel_sentAt_idx" ON "NotificationLog"("channel", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationLog_subjectId_channel_type_variant_key" ON "NotificationLog"("subjectId", "channel", "type", "variant");

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "OrderRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
