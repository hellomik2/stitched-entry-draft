import { RuleResult } from "../rules/types";
import iso3166Json from "../../data/codes/iso-3166-1.json";

// Requirement 52.1: every ISO 3166-1 code and each of its names (normalized: spaces, upper case) give the code.
const COUNTRY_CODES: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const country of iso3166Json.countries) {
    const code = country.code.toUpperCase();
    map[code] = code;
    for (const name of country.names) map[name.replace(/\s+/g, " ").trim().toUpperCase()] = code;
  }
  return map;
})();

/**
 * Requirement 35.1: a printed date in a document as day, month, year components and span in text.
 */
export interface PrintedDate {
  day: number;
  month: number;
  year: number;
  span: { start: number; end: number };
}

/**
 * Requirement 35.1: find all printed dates in text in formats: D Mon YYYY, Mon D YYYY, D Month YYYY, YYYY-MM-DD, DD.MM.YYYY
 */
export function findPrintedDates(text: string): PrintedDate[] {
  const dates: PrintedDate[] = [];
  
  // Month names (case-insensitive)
  const monthAbbr: { [key: string]: number } = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  const monthFull: { [key: string]: number } = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };

  // Helper: check if a span overlaps any existing date span
  const hasOverlap = (newSpan: PrintedDate['span']): boolean => {
    return dates.some(d => !(newSpan.end <= d.span.start || newSpan.start >= d.span.end));
  };

  // Pattern 1: D Mon YYYY or D-Mon-YYYY (case-insensitive, 1-2 digit day)
  // Examples: "03 Nov 2026", "03-NOV-2026", "03 Nov 2026"
  const pattern1 = /(\d{1,2})\s*[-\s]\s*([a-z]{3})\s*[-\s]\s*(\d{4})/gi;
  let match1;
  while ((match1 = pattern1.exec(text)) !== null) {
    const day = parseInt(match1[1], 10);
    const monthStr = match1[2].toLowerCase();
    const year = parseInt(match1[3], 10);
    const month = monthAbbr[monthStr];
    if (month && day >= 1 && day <= 31) {
      // Check it's a valid date
      const checkDate = new Date(year, month - 1, day);
      if (checkDate.getDate() === day && checkDate.getMonth() === month - 1) {
        const span = { start: match1.index, end: match1.index + match1[0].length };
        if (!hasOverlap(span)) {
          dates.push({ day, month, year, span });
        }
      }
    }
  }

  // Pattern 2: Mon D, YYYY or Mon D YYYY (case-insensitive)
  // Examples: "Nov 03, 2026", "Nov 03 2026"
  const pattern2 = /([a-z]{3})\s+(\d{1,2}),?\s+(\d{4})/gi;
  let match2;
  while ((match2 = pattern2.exec(text)) !== null) {
    const monthStr = match2[1].toLowerCase();
    const month = monthAbbr[monthStr];
    const day = parseInt(match2[2], 10);
    const year = parseInt(match2[3], 10);
    if (month && day >= 1 && day <= 31) {
      const checkDate = new Date(year, month - 1, day);
      if (checkDate.getDate() === day && checkDate.getMonth() === month - 1) {
        const span = { start: match2.index, end: match2.index + match2[0].length };
        if (!hasOverlap(span)) {
          dates.push({ day, month, year, span });
        }
      }
    }
  }

  // Pattern 3: Full month name D, YYYY or D YYYY (case-insensitive)
  // Examples: "November 3, 2026", "November 3 2026"
  const pattern3 = /([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/gi;
  let match3;
  while ((match3 = pattern3.exec(text)) !== null) {
    const monthStr = match3[1].toLowerCase();
    const month = monthFull[monthStr];
    const day = parseInt(match3[2], 10);
    const year = parseInt(match3[3], 10);
    if (month && day >= 1 && day <= 31) {
      const checkDate = new Date(year, month - 1, day);
      if (checkDate.getDate() === day && checkDate.getMonth() === month - 1) {
        const span = { start: match3.index, end: match3.index + match3[0].length };
        if (!hasOverlap(span)) {
          dates.push({ day, month, year, span });
        }
      }
    }
  }

  // Pattern 4: YYYY-MM-DD
  // Examples: "2026-11-03"
  const pattern4 = /(\d{4})-(\d{2})-(\d{2})/g;
  let match4;
  while ((match4 = pattern4.exec(text)) !== null) {
    const year = parseInt(match4[1], 10);
    const month = parseInt(match4[2], 10);
    const day = parseInt(match4[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const checkDate = new Date(year, month - 1, day);
      if (checkDate.getDate() === day && checkDate.getMonth() === month - 1) {
        const span = { start: match4.index, end: match4.index + match4[0].length };
        if (!hasOverlap(span)) {
          dates.push({ day, month, year, span });
        }
      }
    }
  }

  // Pattern 5: DD.MM.YYYY
  // Examples: "03.11.2026" - first is day (03), second is month (11)
  // Reject if first number > 31 or first number < 1, or second number not 1-12
  const pattern5 = /(\d{2})\.(\d{2})\.(\d{4})/g;
  let match5;
  while ((match5 = pattern5.exec(text)) !== null) {
    const day = parseInt(match5[1], 10);
    const month = parseInt(match5[2], 10);
    const year = parseInt(match5[3], 10);
    // Validate: first number is day (1-31), second is month (1-12)
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      const checkDate = new Date(year, month - 1, day);
      if (checkDate.getDate() === day && checkDate.getMonth() === month - 1) {
        const span = { start: match5.index, end: match5.index + match5[0].length };
        if (!hasOverlap(span)) {
          dates.push({ day, month, year, span });
        }
      }
    }
  }

  return dates;
}

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
 * Thousands commas in groups of three are read (e.g., "1,248.0" -> 12480).
 * Examples: "286.2" -> 2862 (tenths), "48.0" -> 480, "1,248.0" -> 12480, "1.25" -> NeedsReview
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

  // Match: digits with optional thousands commas (groups of three) and at most one decimal
  const kgRegex = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d))?$/;
  const match = trimmed.match(kgRegex);
  if (!match) {
    return { ok: false, reason: `Invalid weight format: "${text}"` };
  }

  const intPart = parseInt(match[1].replace(/,/g, ""), 10);
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
 * Thousands commas in groups of three are read (e.g., "1,200 CTNS" -> 1200).
 * Examples: "37 CTNS" -> 37, "50 PACKAGE" -> 50, "1,200 CTNS" -> 1200
 */
export function parsePackages(text: string): RuleResult<number> {
  if (typeof text !== "string") {
    return { ok: false, reason: "Packages text must be a string" };
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, reason: "Packages text is empty" };
  }

  // Match: number with optional thousands commas followed by optional whitespace and unit
  const packagesRegex =
    /^(\d{1,3}(?:,\d{3})+|\d+)\s*(?:CTN|CTNS|CARTON|CARTONS|PKG|PKGS|PACKAGE|PACKAGES)?$/i;
  const match = trimmed.match(packagesRegex);
  if (!match) {
    return {
      ok: false,
      reason: `Invalid packages format: "${text}" (expected number and optional unit like CTN, PKG, CARTON)`,
    };
  }

  const count = parseInt(match[1].replace(/,/g, ""), 10);

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
 * Requirement 52.2: a document date as MM/DD/YYYY. A value parseUsDate accepts gives what it gives; else, when the
 * whole value (spaces normalized) is one printed date of Requirement 35.1, that date; else the reason of parseUsDate.
 */
export function parseDocumentDate(text: string): RuleResult<string> {
  const us = parseUsDate(text);
  if (us.ok || typeof text !== "string") return us;
  const t = text.replace(/\s+/g, " ").trim();
  const dates = findPrintedDates(t);
  if (dates.length === 1 && dates[0].span.start === 0 && dates[0].span.end === t.length) {
    const d = dates[0];
    return { ok: true, value: `${String(d.month).padStart(2, "0")}/${String(d.day).padStart(2, "0")}/${d.year}` };
  }
  return us;
}

/**
 * Parse country name or code to ISO 2-letter code.
 * Requirement 52.1: normalize with spaces, look up in iso-3166-1.json.
 * Code itself or any name (all normalized the same way) gives the code.
 * Returns the ISO 2-letter code if found, needs review otherwise.
 */
export function countryCode(text: string): RuleResult<string> {
  if (typeof text !== "string") {
    return { ok: false, reason: "Country text must be a string" };
  }

  const trimmed = text.replace(/\s+/g, " ").trim().toUpperCase();
  if (!trimmed) {
    return { ok: false, reason: "Country text is empty" };
  }

  const result = COUNTRY_CODES[trimmed];
  if (!result) {
    return { ok: false, reason: `Unknown country: "${text}"` };
  }

  return { ok: true, value: result };
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
