/**
 * Convert paise (Int in DB) to a formatted INR string.
 *
 * @param amountInPaise - Integer amount in paise (1 rupee = 100 paise)
 * @param options.withDecimals - Show 2 decimals. Default: true.
 * @param options.withSymbol   - Prefix with ₹. Default: true.
 *
 * @example
 *   formatINR(150000)                           // "₹1,500.00"
 *   formatINR(150000, { withDecimals: false })  // "₹1,500"
 *   formatINR(0)                                // "₹0.00"
 */

interface FormatINROptions {
    withDecimals?: boolean;
    withSymbol?: boolean;
}

export function formatINR(
    amountInPaise: number,
    options: FormatINROptions = {
        withDecimals: true,
        withSymbol  : true,
    },
): string {
    const { withDecimals = true, withSymbol = true } = options;

    const rupees = amountInPaise / 100;

    const formatted = rupees.toLocaleString("en-IN", {
        minimumFractionDigits: withDecimals ? 2 : 0,
        maximumFractionDigits: withDecimals ? 2 : 0,
    });

    return withSymbol ? `₹ ${formatted}` : formatted;
}