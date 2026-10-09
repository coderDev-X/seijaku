import type { BrevoTemplateKey } from "./template.config.js";

export interface Recipient {
  email: string;
  name?: string;
}

export interface SendTransactionalArgs {
  template: BrevoTemplateKey;
  to: Recipient;
  params: Record<string, unknown>;
  subject?: string;
  replyTo?: Recipient;
}

export interface SendTransactionalResult {
  messageId: string;
}