import { RuleResult } from "../rules/types";

/**
 * Parse money text to integer cents.
 * Optional leading "$"; thousands commas; up to 2 decimal places.
 * Examples: "3,294.20" -> 329420, "4.5" -> 450, "$12" -> 1200
 * Bad grouping like "1,23.00" or letters -> NeedsReview
 */
export function parseMoneyToCents(text: string): RuleResult<number> {
  if (typeof text !== "string") {
    return { ok: false, reason: "Money text must be a string" };
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, reason: "Money text is empty" };
  }

  // Remove optional leading $
  let working = trimmed;
  if (working.startsWith("$")) {
    working = working.slice(1);
  }

  // Validate format: matches ^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$
  const numberRegex = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/;
  if (!numberRegex.test(working)) {
    return { ok: false, reason: `Invalid money format: "${text}"` };
  }

  // Remove commas and convert to cents
  const normalized = working.replace(/,/g, "");
  const parts = normalized.split(".");

  let dollars: number;
  let cents: number;

  if (parts.length === 1) {
    // No decimal part
    dollars = parseInt(parts[0], 10);
    cents = 0;
  } else if (parts.length === 2) {
    // Has decimal part
    dollars = parseInt(parts[0], 10);
    const decimalPart = parts[1];
    // Pad or truncate to 2 digits
    if (decimalPart.length === 1) {
      cents = parseInt(decimalPart, 10) * 10;
    } else {
      cents = parseInt(decimalPart.slice(0, 2), 10);
    }
  } else {
    return { ok: false, reason: `Invalid money format: "${text}"` };
  }

  const totalCents = dollars * 100 + cents;

  if (!Number.isSafeInteger(totalCents)) {
    return { ok: false, reason: "Money value is not a safe integer" };
  }

  return { ok: true, value: totalCents };
}

/**
 * Parse whole numbers with optional thousands commas.
 * Examples: "1,236" -> 1236
 * Decimal: "12.5" -> NeedsReview
 */
export function parseCount(text: string): RuleResult<number> {
  if (typeof text !== "string") {
    return { ok: false, reason: "Count text must be a string" };
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, reason: "Count text is empty" };
  }

  // Match: either 1-3 digits followed by groups of comma + 3 digits, or plain digits
  const countRegex = /^(?:\d{1,3}(?:,\d{3})+|\d+)$/;
  if (!countRegex.test(trimmed)) {
    return { ok: false, reason: `Invalid count format: "${text}"` };
  }

  const normalized = trimmed.replace(/,/g, "");
  const count = parseInt(normalized, 10);

  if (!Number.isSafeInteger(count)) {
    return { ok: false, reason: "Count is not a safe integer" };
  }

  return { ok: true, value: count };
}

/**
 * Parse weight in kg to tenths (stored as integer tenths).
 * Optional trailing "kg"; at most one decimal place.
 * Examples: "286.2" -> 2862 (tenths), "48.0" -> 480, "1.25" -> NeedsReview
 */
export function parseKgToTenths(text: string): RuleResult<number> {
  if (typeof text !== "string") {
    return { ok: false, reason: "Weight text must be a string" };
  }

  let trimmed = text.trim().toUpperCase();
  if (!trimmed) {
    return { ok: false, reason: "Weight text is empty" };
  }

  // Remove optional trailing "kg"
  if (trimmed.endsWith("KG")) {
    trimmed = trimmed.slice(0, -2).trim();
  }

  // Match: digits with at most one decimal
  const kgRegex = /^(\d+)(?:\.(\d))?$/;
  const match = trimmed.match(kgRegex);
  if (!match) {
    return { ok: false, reason: `Invalid weight format: "${text}"` };
  }

  const intPart = parseInt(match[1], 10);
  const decimalPart = match[2] ? parseInt(match[2], 10) : 0;

  const tenths = intPart * 10 + decimalPart;

  if (!Number.isSafeInteger(tenths)) {
    return { ok: false, reason: "Weight value is not a safe integer" };
  }

  return { ok: true, value: tenths };
}

/**
 * Parse package count and unit.
 * Accepts: CTN, CTNS, CARTON, CARTONS, PKG, PKGS, PACKAGE, PACKAGES (case-insensitive).
 * Examples: "37 CTNS" -> 37, "50 PACKAGE" -> 50
 */
export function parsePackages(text: string): RuleResult<number> {
  if (typeof text !== "string") {
    return { ok: false, reason: "Packages text must be a string" };
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, reason: "Packages text is empty" };
  }

  // Match: number followed by optional whitespace and unit
  const packagesRegex =
    /^(\d+)\s*(?:CTN|CTNS|CARTON|CARTONS|PKG|PKGS|PACKAGE|PACKAGES)?$/i;
  const match = trimmed.match(packagesRegex);
  if (!match) {
    return {
      ok: false,
      reason: `Invalid packages format: "${text}" (expected number and optional unit like CTN, PKG, CARTON)`,
    };
  }

  const count = parseInt(match[1], 10);

  if (!Number.isSafeInteger(count)) {
    return { ok: false, reason: "Package count is not a safe integer" };
  }

  return { ok: true, value: count };
}

/**
 * Parse US date in MM/DD/YYYY format and validate as a real calendar date.
 * Examples: "10/28/2026" -> "10/28/2026", "02/30/2026" -> NeedsReview (invalid date)
 * Returns the date string if valid, NeedsReview otherwise.
 */
export function parseUsDate(text: string): RuleResult<string> {
  if (typeof text !== "string") {
    return { ok: false, reason: "Date text must be a string" };
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, reason: "Date text is empty" };
  }

  // Match MM/DD/YYYY format
  const dateRegex = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
  const match = trimmed.match(dateRegex);
  if (!match) {
    return {
      ok: false,
      reason: `Invalid date format: "${text}" (expected MM/DD/YYYY)`,
    };
  }

  const month = parseInt(match[1], 10);
  const day = parseInt(match[2], 10);
  const year = parseInt(match[3], 10);

  // Validate as a real calendar date
  const date = new Date(year, month - 1, day);
  const isValid =
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day;

  if (!isValid) {
    return { ok: false, reason: `Invalid calendar date: "${text}"` };
  }

  // Return formatted MM/DD/YYYY (with zero-padding)
  const formatted = `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}`;
  return { ok: true, value: formatted };
}

/**
 * Parse country name or code to ISO 2-letter code.
 * Small table: VIETNAM/VIET NAM -> VN, PORTUGAL -> PT, CZECHIA/CZECH REPUBLIC -> CZ, CHINA -> CN, USA/UNITED STATES -> US
 * Also accepts the codes themselves (VN, PT, etc.)
 * Case-insensitive.
 */
export function countryCode(text: string): RuleResult<string> {
  if (typeof text !== "string") {
    return { ok: false, reason: "Country text must be a string" };
  }

  const trimmed = text.trim().toUpperCase();
  if (!trimmed) {
    return { ok: false, reason: "Country text is empty" };
  }

  // Mapping of country names and aliases to ISO codes
  const countryMap: Record<string, string> = {
    // Codes themselves
    VN: "VN",
    PT: "PT",
    CZ: "CZ",
    CN: "CN",
    US: "US",
    // Country names
    VIETNAM: "VN",
    "VIET NAM": "VN",
    PORTUGAL: "PT",
    CZECHIA: "CZ",
    "CZECH REPUBLIC": "CZ",
    CHINA: "CN",
    USA: "US",
    "UNITED STATES": "US",
  };

  const code = countryMap[trimmed];
  if (!code) {
    return { ok: false, reason: `Unknown country: "${text}"` };
  }

  return { ok: true, value: code };
}

/**
 * Format integer cents to string money format.
 * Examples: 2772 -> "27.72", 5 -> "0.05", 100 -> "1.00"
 * No separators, no "$"
 * Throws on non-integer or negative input.
 */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) {
    throw new Error("Cents must be a safe integer");
  }

  if (cents < 0) {
    throw new Error("Cents must be non-negative");
  }

  const dollars = Math.floor(cents / 100);
  const centsPart = cents % 100;

  return `${dollars}.${String(centsPart).padStart(2, "0")}`;
}
