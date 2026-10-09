import { BrevoClient } from "@getbrevo/brevo";
import { env } from "../config.js";

// Create a singleton Brevo client for all API calls.
export const brevo = new BrevoClient({
    apiKey: env.BREVO_API_KEY,
    timeoutInSeconds: 30,
    maxRetries: 3,
});