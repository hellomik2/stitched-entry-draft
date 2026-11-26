// Requirement 63: a person's exchange rate for an invoice that is not in USD.
// The app never chooses, suggests or looks up a rate: a person enters the rate, its date and where it came from,
// and the app only multiplies, exactly with whole numbers, then rounds once by P4.
import { normalizeSpace } from "./pdfText";
import { parseMoneyToCents, formatCents } from "./parse";
import type { VerifiedReading } from "./reading";
import { roundEnteredValue } from "../rules";

export type ExchangeRateInput = { rate: string; date: string; source: string };

export type ExchangeRateSource = {
  kind: "exchangeRate";
  currency: string;
  rate: string;
  date: string;
  source: string;
};

export const EXCHANGE_RATE_FIELD_ID = "FX.RATE";

/** Requirement 63.5: only what 19 CFR 159.31, 159.32, 152.1(c), 159.34 and 159.35 say; no rate, no threshold, no source is named. */
export const EXCHANGE_RATE_HELP =
  "Customs converts foreign currency only at a proclaimed or certified rate (19 CFR 159.31), for the date of exportation: the day the goods finally left the country of exportation for the United States (159.32, 152.1(c)). 159.34 and 159.35 say when the quarterly or the daily certified rate applies. Enter the rate, its date and where it came from. The app does not choose, suggest or look up a rate.";

export const MIXED_FORMS_REASON =
  "The invoice prints its amounts both with a decimal comma and in another form, so the draft does not convert them. A person enters the entered value.";

/**
 * Requirement 63.1: the invoice currency that the draft counts as accepted, in capitals, when it is not USD; otherwise null.
 * The draft counts accepted readings and the image readings outside the transcript or on a line with no usable place
 * that the reader was sure of (Requirements 50 and 58); the last one counted wins, as in the draft.
 */
export function invoiceForeignCurrency(readings: readonly VerifiedReading[]): string | null {
  let value: string | null = null;
  for (const r of readings) {
    if (r.field !== "invoice.currency") continue;
    const counted =
      r.status === "accepted" ||
      (r.status === "uncertain" && (r.notInTranscript === true || r.lineWithoutBox === true) && r.confidence !== "low");
    if (counted) value = r.value ? normalizeSpace(r.value) : null;
  }
  if (!value) return null;
  const upper = value.toUpperCase();
  return upper === "USD" ? null : upper;
}

const RATE_FORM = /^\d{1,6}(\.\d{1,8})?$/;
const DATE_FORM = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Requirement 63.1: why a person's rate, its date or its source cannot be used; null when they can. */
export function exchangeRateProblem(x: ExchangeRateInput): string | null {
  const rate = String(x?.rate ?? "").trim();
  if (!RATE_FORM.test(rate) || !/[1-9]/.test(rate)) {
    return "The rate must be a number greater than 0, with at most 6 digits before the decimal point and 8 after it, for example 1.0835.";
  }
  const d = DATE_FORM.exec(String(x?.date ?? "").trim());
  let real = false;
  if (d) {
    const y = Number(d[1]);
    const m = Number(d[2]);
    const day = Number(d[3]);
    const t = new Date(0);
    t.setUTCFullYear(y, m - 1, day);
    real = t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === day;
  }
  if (!real) {
    return "The rate date must be a real date written YYYY-MM-DD, for example 2026-11-09.";
  }
  const source = normalizeSpace(String(x?.source ?? ""));
  if (source.length < 1 || source.length > 200) {
    return "Say where the rate came from, in 1 to 200 characters.";
  }
  return null;
}

/** Requirement 63.1: the rate, the date and the source as the draft keeps them (trimmed; the source with its spaces normalized). */
export function exchangeRateSource(currency: string, x: ExchangeRateInput): ExchangeRateSource {
  return { kind: "exchangeRate", currency, rate: x.rate.trim(), date: x.date.trim(), source: normalizeSpace(x.source) };
}

const DECIMAL_COMMA_FORMS = [/^\d{1,3}(\.\d{3})+,\d{2}$/, /^\d+,\d{2}$/];
const isDecimalCommaForm = (t: string) => DECIMAL_COMMA_FORMS.some((re) => re.test(t));

/**
 * Requirement 63.4: the cents of an amount printed with a decimal comma, in one of the two forms that have one meaning
 * (exactly two digits after the comma, periods only between groups of three digits); null for every other text.
 * A text that today's money reading takes is never read here, so no text has two values.
 */
export function decimalCommaCents(text: string): number | null {
  const t = normalizeSpace(String(text ?? ""));
  if (parseMoneyToCents(t).ok) return null;
  if (!isDecimalCommaForm(t)) return null;
  const digits = t.replace(/[.,]/g, "");
  if (digits.length > 15) return null;
  return Number(digits);
}

/** Today's money reading, then the decimal comma reading of 63.4 (used only with a usable rate). */
export function exchangeMoneyCents(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = normalizeSpace(text);
  const today = parseMoneyToCents(t);
  return today.ok ? today.value : decimalCommaCents(t);
}

/**
 * Requirement 63.4: true when one money value is in a decimal comma form and another has a comma or a period in some
 * other form, each with one leading and one trailing three-capital-letter code, "€" or "$" removed.
 */
export function mixesNumberForms(values: readonly string[]): boolean {
  let comma = false;
  let other = false;
  for (const raw of values) {
    const t = normalizeSpace(String(raw ?? ""))
      .replace(/^(?:[A-Z]{3}|€|\$)\s*/, "")
      .replace(/\s*(?:[A-Z]{3}|€|\$)$/, "");
    if (isDecimalCommaForm(t)) comma = true;
    else if (/[.,]/.test(t)) other = true;
  }
  return comma && other;
}

/**
 * Requirement 63.3: the P1 detail of an invoice line whose quantity, unit price and amount are all read (money by
 * `exchangeMoneyCents`) and whose quantity times unit price differs from the amount by more than 1 cent; otherwise null.
 */
export function exchangeLineMismatch(
  quantity: number | null,
  unitPriceText: string | null | undefined,
  amountText: string | null | undefined,
): string | null {
  const price = exchangeMoneyCents(unitPriceText);
  const amount = exchangeMoneyCents(amountText);
  if (quantity === null || price === null || amount === null) return null;
  const computed = quantity * price;
  const diff = Math.abs(computed - amount);
  if (diff <= 1) return null;
  return `quantity × unitPrice = ${(computed / 100).toFixed(2)}, amount = ${(amount / 100).toFixed(2)}, diff = ${(diff / 100).toFixed(2)}`;
}

/**
 * Requirement 63.3: the exact product of an amount in cents of the invoice currency and the rate, its text, and P4 of it.
 * Whole numbers only (BigInt). The exact product's whole cents, rounded down, give `roundEnteredValue` the same whole
 * dollars as P4 of the exact product: floor((x + 50) / 100) = floor((floor(x) + 50) / 100) for any x >= 0.
 */
export function convertedEnteredValue(
  foreignCents: number,
  rate: string,
): { ok: true; exactUsd: string; dollars: number } | { ok: false; reason: string } {
  const r = String(rate ?? "").trim();
  if (!Number.isSafeInteger(foreignCents) || foreignCents < 0 || !RATE_FORM.test(r)) {
    return { ok: false, reason: "The amount or the rate cannot be converted. A person enters the entered value." };
  }
  const [whole, frac = ""] = r.split(".");
  const scale = BigInt(frac.length);
  const product = BigInt(foreignCents) * BigInt(whole + frac); // in units of 10^-(2 + scale) USD
  const cents = product / 10n ** scale; // whole cents, rounded down
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, reason: "The converted value is too large to compute. A person enters the entered value." };
  }
  const rounded = roundEnteredValue(Number(cents));
  if (!rounded.ok) return { ok: false, reason: rounded.reason };
  const unit = 10n ** (2n + scale);
  let fraction = (product % unit).toString().padStart(Number(2n + scale), "0").replace(/0+$/, "");
  if (fraction.length < 2) fraction = fraction.padEnd(2, "0");
  return { ok: true, exactUsd: `${product / unit}.${fraction}`, dollars: rounded.value };
}

/** Requirement 63.6: the text of an exchange rate source (the CSV doubles a quote inside the source). */
export function exchangeRateSourceText(s: ExchangeRateSource): string {
  return `Exchange rate entered by a person: 1 ${s.currency} = ${s.rate} USD, rate date ${s.date}, source "${s.source}"`;
}

/** Requirement 63.2: the note of FX.RATE. */
export function exchangeRateNote(s: ExchangeRateSource): string {
  return `Entered by a person: 1 ${s.currency} = ${s.rate} USD, rate date ${s.date}, source "${s.source}". The app does not choose, suggest or look up a rate.`;
}

/** Requirement 63.3: the note of a 36A computed with the rate. */
export function convertedNote(
  amountsCents: readonly number[],
  currency: string,
  rate: string,
  exactUsd: string,
  decimalComma: readonly { line: number; printed: string; cents: number }[],
): string {
  const parts = amountsCents.map((c) => formatCents(c));
  const amount = parts.length === 1 ? parts[0] : `(${parts.join(" + ")})`;
  const read = decimalComma
    .map((x) => ` Invoice line ${x.line} amount printed "${x.printed}", read as ${formatCents(x.cents)} (decimal comma).`)
    .join("");
  return `${amount} ${currency} × ${rate} = ${exactUsd} USD, rounded to whole dollars (P4).${read} Nothing was deducted. A person confirms the entered value.`;
}
