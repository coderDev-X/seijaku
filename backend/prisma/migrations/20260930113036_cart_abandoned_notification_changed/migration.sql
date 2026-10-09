/*
  Warnings:

  - A unique constraint covering the columns `[customerId,type]` on the table `CartAbandonedNotification` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "CartAbandonedNotification_customerId_type_key" ON "CartAbandonedNotification"("customerId", "type");
