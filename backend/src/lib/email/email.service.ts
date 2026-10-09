// The ONLY place in the app that talks to Brevo's transactional API.

import { brevo } from "../brevo-client.js";
import { BREVO_TEMPLATES } from "./template.config.js";
import type { SendTransactionalArgs, SendTransactionalResult } from "./types.js";

export async function sendTransactional({
    template,
    to,
    params,
    subject,
    replyTo,
}: SendTransactionalArgs): Promise<SendTransactionalResult> {
    const templateId = BREVO_TEMPLATES[template];

    if (!templateId) {
        throw new Error(`Unknown Brevo template key: ${template}`);
    }

    const payload: Record<string, unknown> = {
        templateId,
        to: [to],
        params,
    };

    if (subject) payload.subject = subject;
    if (replyTo) payload.replyTo = replyTo;

    try {
        const result = await brevo.transactionalEmails.sendTransacEmail(payload);
        
        console.log(
            `[email:${template}] ::: ${to.email} | ${result.messageId}`,
        );
        
        return { messageId: String(result.messageId) };
    } catch (err: any) {
        
        console.error(
            `[email:${template}] ::: ${to.email} | ${err.message}`,
        );
        
        throw err;
    }
}