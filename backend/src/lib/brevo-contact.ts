import { brevo } from "./brevo-client.js";

export interface BrevoContact {
    id       : string;
    email    : string;
    firstName: string;
    phone    : string;
}

export async function syncUserToBrevo(user : BrevoContact) : Promise<number | undefined> {
    try {
        const contact = await brevo.contacts.createContact({
            email: user.email,

            // Optional attributes
            attributes: {
                FIRSTNAME: user.firstName,
                PHONE    : user.phone,
                USER_ID  : user.id,
            },

            // Update existing contact instead of throwing error
            updateEnabled: true,
        });

        if (!contact) {
            throw new Error("Brevo sync failed: no contact returned");
        }

        return contact.id;

    } catch (error) {
        console.error("Brevo sync failed:", ( error as Error ).message );
        throw error;
    }
}