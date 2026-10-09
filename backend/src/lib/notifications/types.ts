import type {
  NotificationChannel,
  NotificationStatus,
  NotificationType,
} from "@prisma/client";

export interface Recipient {
  email?: string;
  phone?: string;
  name ?: string;
}

export interface NotifyArgs {
  subjectId : string;
  orderId  ?: string | null;
  recipient : string;
  channel   : NotificationChannel;
  type      : NotificationType;
  variant  ?: string;
  send      : () => Promise<{ providerId?: string }>;
}

export interface NotifyResult {
  logId      : string;
  providerId?: string;
  status     : NotificationStatus;
  skipped   ?: boolean;
}