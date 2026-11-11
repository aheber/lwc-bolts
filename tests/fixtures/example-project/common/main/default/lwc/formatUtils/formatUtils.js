// @ts-check

/**
 * Formats a number as currency.
 * @param {number} amount
 * @param {string} [currencyCode]
 * @returns {string}
 */
export function formatCurrency(amount, currencyCode = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currencyCode }).format(amount);
}

/**
 * Formats an ISO date string (Apex `Date` values arrive as strings).
 * @param {string} isoDate
 * @returns {string}
 */
export function formatDate(isoDate) {
  return new Date(isoDate).toLocaleDateString("en-US");
}
