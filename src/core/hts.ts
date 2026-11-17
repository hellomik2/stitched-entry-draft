export type HtsRow = {
  htsno: string;
  indent: number;
  description: string;
  units: string[];
  general: string;
  special: string;
  footnotes: string[];
};

export type HtsTable = {
  revision: string;
  revisionTitle: string;
  fetchedOn: string;
  rows: HtsRow[];
};

export type HtsNumber = {
  digits: string;
  entry: string;
  schedule: string;
};

export type HtsLookup =
  | {
      found: true;
      number: HtsNumber;
      row: HtsRow;
      rateText: string;
      rateFrom: string;
      unit: string | null;
      chapter99: string[];
    }
  | { found: false; number: HtsNumber | null; reason: string };

export type RuleResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

/**
 * Normalize an HTS number by removing dots and spaces.
 * Must be exactly 10 digits; otherwise returns NeedsReview.
 *
 * Returns:
 * - entry: "NNNN.NN.NNNN" (7501 form, e.g., 6913.90.5000)
 * - schedule: "NNNN.NN.NN.NN" (tariff schedule form)
 */
export function normalizeHts(raw: string): RuleResult<HtsNumber> {
  // Remove dots and spaces
  const cleaned = raw.replace(/[\s.]/g, "");

  // Must be exactly 10 digits
  if (!/^\d{10}$/.test(cleaned)) {
    return {
      ok: false,
      reason: `HTS number must be exactly 10 digits (got "${raw}")`,
    };
  }

  const digits = cleaned;

  // Format as entry: NNNN.NN.NNNN
  const entry = `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6)}`;

  // Format as schedule: NNNN.NN.NN.NN
  const schedule = `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6, 8)}.${digits.slice(8)}`;

  return {
    ok: true,
    value: { digits, entry, schedule },
  };
}

/**
 * Look up an HTS number in a table.
 *
 * - If not 10 digits: returns { found: false, number: null, reason }.
 * - If no matching row: returns { found: false, number, reason }.
 * - Finds ancestors (rows whose htsno without dots is a prefix of the number,
 *   longest first) to locate a rate if the row itself has no rate.
 * - Extracts Chapter 99 references from footnotes (pattern 99NN.NN.NN).
 */
export function lookupHts(table: HtsTable, raw: string): HtsLookup {
  const normalized = normalizeHts(raw);

  if (!normalized.ok) {
    return {
      found: false,
      number: null,
      reason: normalized.reason,
    };
  }

  const htsNumber = normalized.value;
  const { digits } = htsNumber;

  // Find the exact row matching this 10-digit number
  const row = table.rows.find((r) => r.htsno.replace(/\./g, "") === digits);

  if (!row) {
    return {
      found: false,
      number: htsNumber,
      reason: `${htsNumber.entry} is not in ${table.revisionTitle}.`,
    };
  }

  // Find ancestors: rows whose htsno (without dots) is a prefix of our digits,
  // sorted by length descending (longest first)
  const ancestors = table.rows
    .filter((r) => {
      const rDigits = r.htsno.replace(/\./g, "");
      return (
        rDigits.length < digits.length &&
        digits.startsWith(rDigits)
      );
    })
    .sort((a, b) => {
      const aLen = a.htsno.replace(/\./g, "").length;
      const bLen = b.htsno.replace(/\./g, "").length;
      return bLen - aLen; // longest first
    });

  // Find the rate: use row's general if non-empty, otherwise first ancestor's
  let rateText = row.general;
  let rateFrom = row.htsno;

  if (!rateText) {
    const ancestorWithRate = ancestors.find((a) => a.general);
    if (ancestorWithRate) {
      rateText = ancestorWithRate.general;
      rateFrom = ancestorWithRate.htsno;
    }
  }

  if (!rateText) {
    return {
      found: false,
      number: htsNumber,
      reason: `No rate found for ${htsNumber.entry} in ${table.revisionTitle}.`,
    };
  }

  // Extract unit (first unit or null)
  const unit = row.units[0] ?? null;

  // Extract Chapter 99 footnotes: keep complete footnotes that contain pattern 99NN.NN.NN
  // Collect from row and ancestors, de-duplicated, in that order
  const chapter99Candidates = [row, ...ancestors];
  const chapter99Set = new Set<string>();
  const chapter99: string[] = [];

  const chapter99Pattern = /99\d{2}\.\d{2}\.\d{2}/;

  for (const candidate of chapter99Candidates) {
    for (const footnote of candidate.footnotes) {
      if (chapter99Pattern.test(footnote)) {
        if (!chapter99Set.has(footnote)) {
          chapter99Set.add(footnote);
          chapter99.push(footnote);
        }
      }
    }
  }

  return {
    found: true,
    number: htsNumber,
    row,
    rateText,
    rateFrom,
    unit,
    chapter99,
  };
}
