import scheduleDJson from "../../data/codes/schedule-d.json";
import scheduleKJson from "../../data/codes/schedule-k.json";

export type ScheduleDRow = { code: string; name: string };
export type ScheduleKRow = { code: string; country: string; name: string; change: string };

export const SCHEDULE_D = {
  ...scheduleDJson,
  table: "Schedule D" as const,
  rows: (scheduleDJson.rows as [string, string][]).map(([code, name]) => ({ code, name })),
} as const;

export const SCHEDULE_K = {
  ...scheduleKJson,
  table: "Schedule K" as const,
  rows: (scheduleKJson.rows as [string, string, string, string][]).map(([code, country, name, change]) => ({
    code,
    country,
    name,
    change,
  })),
} as const;

export const SCHEDULE_D_EDITION = "2026-02-03";
export const SCHEDULE_K_EDITION = "2024-08-27, changes to 04/2026";

export type CodeTableSource = {
  kind: "codeTable";
  table: "Schedule D" | "Schedule K";
  edition: string;
  code: string;
  name: string;
  country: string | null;
};

export type UsPortLookup = { kind: "one"; row: ScheduleDRow } | { kind: "several"; rows: ScheduleDRow[] } | { kind: "none" };
export type ForeignPortLookup =
  | { kind: "one"; rows: ScheduleKRow[] }
  | { kind: "several"; rows: ScheduleKRow[] }
  | { kind: "none"; allOther: ScheduleKRow[] };

export function codeTableSourceD(row: ScheduleDRow): CodeTableSource {
  return {
    kind: "codeTable",
    table: "Schedule D",
    edition: SCHEDULE_D_EDITION,
    code: row.code,
    name: row.name,
    country: null,
  };
}

export function codeTableSourceK(row: ScheduleKRow): CodeTableSource {
  return {
    kind: "codeTable",
    table: "Schedule K",
    edition: SCHEDULE_K_EDITION,
    code: row.code,
    name: row.name,
    country: row.country,
  };
}

/** Normalize text for port code lookup (Requirement 47.1) */
export function normalizeName(text: string): string {
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico",
  NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
  SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico", VI: "Virgin Islands", GU: "Guam", AS: "American Samoa", MP: "Northern Mariana Islands",
};

const STATE_NAME_TO_CODE = new Map<string, string>(Object.entries(US_STATES).map(([k, v]) => [normalizeName(v), k]));

/** Prebuilt Schedule D port rows with normalized pieces and state names */
const SCHEDULE_D_PORT_ROWS: Array<{
  row: ScheduleDRow;
  pieces: string[];
  stateName: string;
}> = (() => {
  const result = [];
  const facility = /\b(airport|air|airfield|user fee|hub|fedex|ups|dhl|eccf|courier|region|border patrol|cartage|tracking|alternate)\b/i;

  for (const row of SCHEDULE_D.rows) {
    const parts = row.name.split(",").map((p) => p.trim());
    if (parts.length !== 2) continue;

    const cityPart = parts[0];
    const statePart = parts[1];
    const cityPartN = normalizeName(cityPart);

    // Check if city part has any facility word as a whole word
    const cityPartWithSpaces = ` ${cityPartN} `;
    let hasFacility = false;
    for (const word of ["airport", "air", "airfield", "user fee", "hub", "fedex", "ups", "dhl", "eccf", "courier", "region", "border patrol", "cartage", "tracking", "alternate"]) {
      if (cityPartWithSpaces.includes(` ${word} `)) {
        hasFacility = true;
        break;
      }
    }

    if (hasFacility) continue;

    const pieces = [
      cityPartN,
      ...cityPart.split(/\/|-/).map((p) => normalizeName(p.trim())),
    ];

    result.push({
      row,
      pieces,
      stateName: statePart,
    });
  }

  return result;
})();

/** Prebuilt Schedule K lookup maps and normalized names per row */
const SCHEDULE_K_BY_COUNTRY = new Map<string, ScheduleKRow[]>();
const SCHEDULE_K_BY_COUNTRY_NO_BRACKETS = new Map<string, string>();
const SCHEDULE_K_ROW_NAMES = new Map<ScheduleKRow, string[]>();

(() => {
  for (const row of SCHEDULE_K.rows) {
    const countryNorm = normalizeName(row.country);
    if (!SCHEDULE_K_BY_COUNTRY.has(row.country)) {
      SCHEDULE_K_BY_COUNTRY.set(row.country, []);
    }
    SCHEDULE_K_BY_COUNTRY.get(row.country)!.push(row);

    const countryWithoutBrackets = row.country.split(" (")[0];
    if (countryWithoutBrackets !== row.country) {
      const countryNormNoBrackets = normalizeName(countryWithoutBrackets);
      if (!SCHEDULE_K_BY_COUNTRY_NO_BRACKETS.has(countryNormNoBrackets)) {
        SCHEDULE_K_BY_COUNTRY_NO_BRACKETS.set(countryNormNoBrackets, row.country);
      }
    }

    // Build normalized names for this row
    let names: string[];
    if (row.name.startsWith("All Other")) {
      names = [row.name];
    } else {
      names = row.name.split(/[;,]/).map((n) => n.trim());
    }

    SCHEDULE_K_ROW_NAMES.set(row, names);
  }
})();

/** Groups of ports that always come together */
const PORT_GROUPS: Array<{ codes: string[]; cities: string[] }> = [
  { codes: ["2704", "2709"], cities: ["los angeles", "long beach"] },
  { codes: ["1001", "4601"], cities: ["new york", "newark", "port newark", "elizabeth", "port elizabeth"] },
];

/**
 * Lookup US port from text. Returns one code, several codes, or none.
 * Requirement 47.2
 */
export function lookupUsPort(text: string): UsPortLookup {
  if (!text) return { kind: "none" };

  // 1. Split on commas, trim, drop empty parts
  let parts = text.split(",").map((p) => p.trim()).filter((p) => p);
  if (parts.length === 0) return { kind: "none" };

  // 2. Remove "port of " from first part (any case)
  const firstLower = parts[0].toLowerCase();
  if (firstLower.startsWith("port of ")) {
    parts[0] = parts[0].slice(8).trim();
    if (!parts[0]) parts.shift();
  }

  if (parts.length === 0) return { kind: "none" };

  // 3. Drop last part if it's a country reference
  const lastLower = normalizeName(parts[parts.length - 1]);
  if (["us", "usa", "u s", "u s a", "united states", "united states of america"].includes(lastLower)) {
    parts.pop();
  }

  if (parts.length === 0) return { kind: "none" };

  // 4. Remove 5-digit ZIP from last part, check for state
  let stateText = parts[parts.length - 1].replace(/\b\d{5}(-\d{4})?\b/, "").trim();
  let stateName: string | null = null;
  let city = parts[parts.length - 1];

  const stateTextNorm = normalizeName(stateText);
  const stateCode = STATE_NAME_TO_CODE.get(stateTextNorm);

  if (stateCode) {
    stateName = US_STATES[stateCode];
    city = parts.length > 1 ? parts.slice(0, -1).join(", ") : "";
    if (!city) return { kind: "none" };
  } else if (stateText.length === 2 && stateText.toUpperCase() in US_STATES) {
    stateName = US_STATES[stateText.toUpperCase()];
    city = parts.length > 1 ? parts.slice(0, -1).join(", ") : "";
    if (!city) return { kind: "none" };
  } else {
    city = parts[parts.length - 1];
  }

  // 5. Normalize city name
  const cityN = normalizeName(city);

  // 6. Check port groups (exact match only)
  for (const group of PORT_GROUPS) {
    if (group.cities.includes(cityN)) {
      // Check if state matches (or no state)
      let stateMatch = false;
      
      if (group.codes[0] === "2704") {
        // LA/LB group: state is CA or no state
        stateMatch = !stateName || stateName === "California";
      } else if (group.codes[0] === "1001") {
        // NY/NJ group: more complex
        if (cityN === "new york") {
          stateMatch = !stateName || stateName === "New York";
        } else {
          // newark, port newark, elizabeth, port elizabeth
          stateMatch = !stateName || stateName === "New Jersey";
        }
      }

      if (stateMatch) {
        const facility =
          /\b(airport|air|airfield|user fee|hub|fedex|ups|dhl|eccf|courier|region|border patrol|cartage|tracking|alternate)\b/i;
        const groupRows = SCHEDULE_D.rows.filter((r) => group.codes.includes(r.code) && !facility.test(r.name));
        if (groupRows.length > 0) {
          const byCode = new Map<string, ScheduleDRow>();
          for (const row of groupRows) {
            if (!byCode.has(row.code)) byCode.set(row.code, row);
          }
          const result: ScheduleDRow[] = [];
          for (const code of group.codes) {
            if (byCode.has(code)) result.push(byCode.get(code)!);
          }
          if (result.length === 1) return { kind: "one", row: result[0] };
          if (result.length > 1) return { kind: "several", rows: result };
        }
      }
    }
  }

  // 7. Match port rows using prebuilt data
  const matchingRows: ScheduleDRow[] = [];
  const usedCodes = new Set<string>();

  for (const { row, pieces, stateName: rowStateName } of SCHEDULE_D_PORT_ROWS) {
    // Check if pieces includes cityN and state matches
    if (pieces.includes(cityN)) {
      if (!stateName || rowStateName === stateName) {
        if (!usedCodes.has(row.code)) {
          matchingRows.push(row);
          usedCodes.add(row.code);
        }
      }
    }
  }

  if (matchingRows.length === 0) return { kind: "none" };
  if (matchingRows.length === 1) return { kind: "one", row: matchingRows[0] };

  // Multiple codes - return in table order
  const byCode = new Map<string, ScheduleDRow>();
  for (const row of matchingRows) {
    byCode.set(row.code, row);
  }

  const result: ScheduleDRow[] = [];
  for (const row of SCHEDULE_D.rows) {
    if (byCode.has(row.code)) result.push(byCode.get(row.code)!);
  }

  return { kind: "several", rows: result };
}

const COUNTRY_ALIASES: Record<string, string> = {
  "viet nam": "Vietnam",
  vietnam: "Vietnam",
  china: "China (Mainland)",
  prc: "China (Mainland)",
  "people s republic of china": "China (Mainland)",
  taiwan: "China (Taiwan)",
  korea: "South Korea",
  "republic of korea": "South Korea",
  "korea republic of": "South Korea",
  "korea south": "South Korea",
  uk: "United Kingdom",
  "united kingdom": "United Kingdom",
  "great britain": "United Kingdom",
  england: "United Kingdom",
  scotland: "United Kingdom",
  wales: "United Kingdom",
  holland: "Netherlands",
  "the netherlands": "Netherlands",
  burma: "Burma (Myanmar)",
  myanmar: "Burma (Myanmar)",
  "ivory coast": "Côte d'Ivoire",
  "russian federation": "Russia",
  turkiye: "Turkey",
  uae: "United Arab Emirates",
  macao: "Macau",
  macau: "Macau",
  "trinidad and tobago": "Trinidad",
};

/**
 * Lookup foreign port from text. Returns one code, several codes, none with allOther, or none.
 * Requirement 47.3
 */
export function lookupForeignPort(text: string): ForeignPortLookup {
  if (!text) return { kind: "none", allOther: [] };

  // Split on commas
  const parts = text.split(",").map((p) => p.trim()).filter((p) => p);
  if (parts.length === 0) return { kind: "none", allOther: [] };

  // Build country lookup from normalized names
  const countryByNorm = new Map<string, string>();
  const countryByNormNoBrackets = new Map<string, string>();

  for (const [country] of SCHEDULE_K_BY_COUNTRY) {
    const countryNorm = normalizeName(country);
    if (!countryByNorm.has(countryNorm)) {
      countryByNorm.set(countryNorm, country);
    }

    const countryWithoutBrackets = country.split(" (")[0];
    if (countryWithoutBrackets !== country) {
      const countryNormNoBrackets = normalizeName(countryWithoutBrackets);
      if (!countryByNormNoBrackets.has(countryNormNoBrackets)) {
        countryByNormNoBrackets.set(countryNormNoBrackets, country);
      }
    }
  }

  // Try to find country by taking 1, 2, 3 parts from the end
  let countryName: string | null = null;
  let portParts = parts;

  for (let take = 1; take < parts.length + 1; take++) {
    const candParts = parts.slice(-take);
    const cand = normalizeName(candParts.join(", "));

    // Check alias
    if (COUNTRY_ALIASES[cand]) {
      countryName = COUNTRY_ALIASES[cand];
      portParts = parts.slice(0, parts.length - take);
      break;
    }

    // Check countryByNorm
    if (countryByNorm.has(cand)) {
      countryName = countryByNorm.get(cand)!;
      portParts = parts.slice(0, parts.length - take);
      break;
    }

    // Check countryByNormNoBrackets
    if (countryByNormNoBrackets.has(cand)) {
      countryName = countryByNormNoBrackets.get(cand)!;
      portParts = parts.slice(0, parts.length - take);
      break;
    }
  }

  // Build port name
  const portName = portParts.join(", ");
  const portNameNorm = normalizeName(portName);

  // Find matching rows
  const matchingRows: ScheduleKRow[] = [];
  const matchedCodes = new Set<string>();
  let allOtherRows: ScheduleKRow[] = [];

  if (countryName) {
    const countryRows = SCHEDULE_K_BY_COUNTRY.get(countryName) || [];

    for (const row of countryRows) {
      if (row.name.startsWith("All Other")) {
        allOtherRows.push(row);
      }

      const names = SCHEDULE_K_ROW_NAMES.get(row) || [];

      for (const name of names) {
        if (normalizeName(name) === portNameNorm) {
          if (!matchedCodes.has(row.code)) {
            matchingRows.push(row);
            matchedCodes.add(row.code);
          }
          break;
        }
      }
    }
  } else {
    // No country found, search all rows
    for (const row of SCHEDULE_K.rows) {
      const names = SCHEDULE_K_ROW_NAMES.get(row) || [];

      for (const name of names) {
        if (normalizeName(name) === portNameNorm) {
          if (!matchedCodes.has(row.code)) {
            matchingRows.push(row);
            matchedCodes.add(row.code);
          }
          break;
        }
      }
    }
  }

  // If no match and portParts.length > 1, try first part
  if (matchingRows.length === 0 && portParts.length > 1) {
    const firstPartNorm = normalizeName(portParts[0]);

    if (countryName) {
      const countryRows = SCHEDULE_K_BY_COUNTRY.get(countryName) || [];

      for (const row of countryRows) {
        const names = SCHEDULE_K_ROW_NAMES.get(row) || [];

        for (const name of names) {
          if (normalizeName(name) === firstPartNorm) {
            if (!matchedCodes.has(row.code)) {
              matchingRows.push(row);
              matchedCodes.add(row.code);
            }
            break;
          }
        }
      }
    }
  }

  if (matchingRows.length === 0) return { kind: "none", allOther: allOtherRows };

  // Check unique codes
  const uniqueCodes = new Set(matchingRows.map((r) => r.code));
  if (uniqueCodes.size === 1) {
    return { kind: "one", rows: matchingRows };
  }

  return { kind: "several", rows: matchingRows };
}
