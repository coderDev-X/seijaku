-- CreateEnum
CREATE TYPE "AbandonedCartNotificationType" AS ENUM ('REMINDER_1', 'REMINDER_2', 'REMINDER_3');

-- AlterEnum
ALTER TYPE "NotificationStatus" ADD VALUE 'PENDING';

-- CreateTable
CREATE TABLE "CartAbandonedNotification" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" "AbandonedCartNotificationType" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'SENT',
    "channel" "NotificationChannel" NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CartAbandonedNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CartAbandonedNotification_customerId_idx" ON "CartAbandonedNotification"("customerId");

-- CreateIndex
CREATE INDEX "CartAbandonedNotification_status_scheduledAt_idx" ON "CartAbandonedNotification"("status", "scheduledAt");

-- AddForeignKey
ALTER TABLE "CartAbandonedNotification" ADD CONSTRAINT "CartAbandonedNotification_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
