import { prisma } from "../prisma.js";
import type { NotifyArgs, NotifyResult } from "./types.js";

/**
 * Atomically claims a (subjectId, channel, type, variant) slot and sends.
 *
 * - If the slot is already taken (P2002 on unique constraint) → returns null,
 *   no send happens. This is the duplicate-prevention gate.
 * - If send fails, the log row is deleted so a retry can attempt again.
 */
export async function notifyOnce(args: NotifyArgs): Promise<NotifyResult | null> {
    const {
        subjectId,
        orderId = null,
        recipient,
        channel,
        type,
        variant = "",
        send,
    } = args;

    // Clear any prior FAILED attempt for this exact key, so we can retry.
    await prisma.notificationLog.deleteMany({
        where: {
            subjectId,
            channel,
            type,
            variant,
            status: "FAILED",
        },
    });

    // Claim
    let log;
    try {
        log = await prisma.notificationLog.create({
            data: {
                subjectId,
                orderId,
                recipient,
                channel,
                type,
                variant,
                status: "SENT",
            },
        });
    } catch (err: any) {
        if (err.code === "P2002") {
            console.log(
                `[notif] ${type} ${channel} already sent for ${subjectId}${variant ? ` (${variant})` : ""}`,
            );
            return null;
        }
        throw err;
    }

    // Send
    try {
        const result = await send();
        await prisma.notificationLog.update({
            where: { id: log.id },
            data: {
                providerId: result.providerId ?? null,
                status: "SENT",
            },
        });
        console.log(
            `[notif] ${type} ${channel} ::: ${recipient} | ${result.providerId}`,
        );
        return {
            logId: log.id,
            providerId: result.providerId,
            status: "SENT",
        };
    } catch (err: any) {
        // keep the log and mark FAILED for auditing.
        await prisma.notificationLog.update({
            where: { id: log.id },
            data: {
                status: "FAILED",
            },
        });
        console.error(
            `[notif] ${type} ${channel} ::: ${recipient} | ${err.message}`,
        );
        throw err;
    }
}