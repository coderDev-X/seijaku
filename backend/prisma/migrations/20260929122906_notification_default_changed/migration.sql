-- AlterTable
ALTER TABLE "CartAbandonedNotification" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "NotificationLog" ALTER COLUMN "status" SET DEFAULT 'PENDING';
