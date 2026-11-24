/**
 * Manufacturer ID (MID) calculation per CBP Form 7501 Appendix 2.
 * Requirement 48 (tasks 60.1 to 60.8).
 */

export type MidResult =
  | {
      ok: true;
      value: string;
      parts: { country: string; name: string; number: string; city: string };
      genericPrefix: string | null;
      withoutGeneric: string | null;
      notes: string[];
    }
  | { ok: false; reason: string };

/** Normalize text for name and address parsing. */
function normalize(text: string): string {
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

const STATE_NAMES_TO_CODES = new Map<string, string>(Object.entries(US_STATES).map(([k, v]) => [normalize(v), k]));

const CANADIAN_PROVINCES: Record<string, string> = {
  AB: "XA", BC: "XC", MB: "XM", NB: "XB", NL: "XW", NT: "XT", NS: "XN", NU: "XV", ON: "XO", PE: "XP", QC: "XQ", SK: "XS", YT: "XY",
};

const CANADIAN_PROVINCE_NAMES = new Map<string, string>([
  ["Alberta", "XA"],
  ["British Columbia", "XC"],
  ["Manitoba", "XM"],
  ["New Brunswick", "XB"],
  ["Newfoundland", "XW"],
  ["Newfoundland and Labrador", "XW"],
  ["Northwest Territories", "XT"],
  ["Nova Scotia", "XN"],
  ["Nunavut", "XV"],
  ["Ontario", "XO"],
  ["Prince Edward Island", "XP"],
  ["Quebec", "XQ"],
  ["Saskatchewan", "XS"],
  ["Yukon", "XY"],
  ["Yukon Territory", "XY"],
]);

const COUNTRY_ALIASES: Record<string, string> = {
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "united kingdom": "GB",
  "great britain": "GB",
  uk: "GB",
  korea: "KR",
  "south korea": "KR",
  "republic of korea": "KR",
  macao: "MO",
  macau: "MO",
  "viet nam": "VN",
  vietnam: "VN",
  "united states": "US",
  usa: "US",
  "u s a": "US",
  "czech republic": "CZ",
  czechia: "CZ",
  france: "FR",
  venezuela: "VE",
  australia: "AU",
  japan: "JP",
  italy: "IT",
  greece: "GR",
  portugal: "PT",
  canada: "CA",
  "hong kong": "HK",
  singapore: "SG",
  germany: "DE",
  spain: "ES",
  netherlands: "NL",
  turkey: "TR",
  mexico: "MX",
  india: "IN",
  indonesia: "ID",
  thailand: "TH",
  malaysia: "MY",
  philippines: "PH",
  taiwan: "TW",
  china: "CN",
};

/** Extract the name part per Requirement 48.2 */
function extractNamePart(nameInput: string): string {
  if (!nameInput) return "";

  // 1. Upper case; replace hyphens with spaces then join; remove punctuation; split and drop empty
  let text = nameInput.toUpperCase();
  text = text.replace(/\s*-\s*/g, "");
  text = text.replace(/[,''&]/g, "");
  let tokens = text.split(/\s+/).filter((t) => t);

  // 2. Map each token: handle initials or remove periods
  const processedTokens: string[] = [];

  for (const token of tokens) {
    // Check for initials: (letter/digit + period) 2+ times, or any letter/digit + periods with optional final char
    const initialsRegex = /^([A-Z0-9]\.){2,}$|^([A-Z0-9]\.)+[A-Z0-9]$/;

    if (initialsRegex.test(token)) {
      // Remove all periods to get the letters
      const letters = token.replace(/\./g, "");
      processedTokens.push(letters);
    } else {
      // Remove periods from token
      const withoutPeriods = token.replace(/\./g, "");
      if (withoutPeriods) {
        processedTokens.push(withoutPeriods);
      }
    }
  }

  // 3. Walk the tokens: runs of 2+ one-char tokens become one word, single one-char tokens that aren't next to others are dropped
  const words: string[] = [];
  let i = 0;

  while (i < processedTokens.length) {
    const token = processedTokens[i];

    if (token.length === 1) {
      // Check if next token is also one character
      let j = i + 1;
      let runLength = 1;

      while (j < processedTokens.length && processedTokens[j].length === 1) {
        runLength++;
        j++;
      }

      if (runLength >= 2) {
        // This is a run of 2+ one-char tokens
        let word = token;
        for (let k = i + 1; k < j; k++) {
          word += processedTokens[k];
        }
        words.push(word);
        i = j;
      } else {
        // Single one-char token with no one-char neighbor: drop it
        i++;
      }
    } else {
      // Multi-char token: keep it
      words.push(token);
      i++;
    }
  }

  // 4. Drop stopwords A, AN, AND, OF, THE
  const stopwords = new Set(["A", "AN", "AND", "OF", "THE"]);
  const withoutStopwords = words.filter((w) => !stopwords.has(w));

  // Build name part: first 3 chars of word 1 + first 3 chars of word 2
  if (withoutStopwords.length === 0) return "";
  if (withoutStopwords.length === 1) return withoutStopwords[0].slice(0, 3);
  return withoutStopwords[0].slice(0, 3) + withoutStopwords[1].slice(0, 3);
}

/** Extract the street number part per Requirement 48.4 */
function extractNumberPart(streetInput: string): string {
  if (!streetInput) return "";

  // Find all runs of digits joined only by "," or "-" (no space)
  const matches = streetInput.match(/\d+(?:[,-]\d+)*/g) || [];
  if (matches.length === 0) return "";

  // Remove punctuation from each match
  const numbers = matches.map((m) => m.replace(/[,-]/g, ""));

  // Find the largest by length, then by string comparison
  let largest = numbers[0];
  for (const num of numbers.slice(1)) {
    if (num.length > largest.length || (num.length === largest.length && num > largest)) {
      largest = num;
    }
  }

  return largest.slice(0, 4);
}

/** Extract the city part per Requirement 48.5 */
function extractCityPart(cityInput: string | null, country: string): { city: string; note: string | null } {
  // 4. Check city-states first (also when city is null or empty)
  if (country === "HK") return { city: "HON", note: "Hong Kong is a city-state, so the city part comes from the country name." };
  if (country === "SG") return { city: "SIN", note: "Singapore is a city-state, so the city part comes from the country name." };
  if (country === "MO") return { city: "MAC", note: "Macau is a city-state, so the city part comes from the country name." };

  if (!cityInput) return { city: "", note: null };

  // Normalize: NFKD, remove accents, upper case, remove digits, split on non-letters
  const normalized = cityInput.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  const withoutDigits = normalized.replace(/[^A-Z ]/g, "");
  const parts = withoutDigits.split(/\s+/).filter((p) => p);

  // Drop stopwords
  const stopwords = new Set(["A", "AN", "AND", "OF", "THE"]);
  const withoutStopwords = parts.filter((p) => !stopwords.has(p));

  if (withoutStopwords.length === 0) return { city: "", note: null };

  const joined = withoutStopwords.join("");
  const result = joined.slice(0, 3);

  return { city: result, note: null };
}

/** Extract country and province codes per Requirement 48.6 */
function extractCountryPart(country: string, province: string | null): { code: string; error?: string } {
  if (country === "CA") {
    if (!province) {
      return { code: "", error: "A Canadian MID starts with the province code, and the province was not found in the address." };
    }
    // Try to match province to code
    const provCode = CANADIAN_PROVINCES[province.toUpperCase()];
    if (provCode) return { code: provCode };

    // Try matching by name
    const normalizedProv = normalize(province);
    for (const [name, code] of CANADIAN_PROVINCE_NAMES) {
      if (normalize(name) === normalizedProv) return { code };
    }

    return { code: "", error: "A Canadian MID starts with the province code, and the province was not found in the address." };
  }

  return { code: country };
}

/**
 * Build MID from name, street, city, country and optional province.
 * Requirement 48.2 to 48.6
 */
export function midFromParts(input: { name: string; street: string; city: string | null; country: string; province: string | null }): MidResult {
  const notes: string[] = [];

  // Extract parts
  const namePart = extractNamePart(input.name);
  const numberPart = extractNumberPart(input.street);
  const { city: cityPart, note: cityNote } = extractCityPart(input.city, input.country);
  if (cityNote) notes.push(cityNote);

  const { code: countryPart, error: countryError } = extractCountryPart(input.country, input.province);
  if (countryError) return { ok: false, reason: countryError };

  // Check for empty name or city parts
  if (!namePart || !cityPart) {
    return { ok: false, reason: "The invoice issuer's name or city gives no letters for the MID." };
  }

  // Check generic prefix
  const words = extractNamePart(input.name).match(/[A-Z0-9]{2,}/g) || [];
  let genericPrefix: string | null = null;
  let withoutGeneric: string | null = null;

  // Check for generic leading words (in uppercase form of input.name)
  const nameUpperTokens = input.name.toUpperCase().replace(/\s*-\s*/g, "").replace(/[,''&]/g, "").split(/\s+/).filter((t) => t);

  const GENERIC_WORDS = ["PT", "CV", "JSC", "OAO", "OOO", "ZAO", "PJSC", "COMPANHIA", "COMPANIA", "COMPAGNIE", "SOCIETE", "SOCIEDAD", "SOCIETA"];
  const FABRICA_PHRASE = ["FABRICA", "DE", "ARTIGOS", "DE", "VESTUARIO"];

  // Check FABRICA phrase first
  let matchedGeneric = 0;
  if (nameUpperTokens.length >= 5) {
    let allMatch = true;
    for (let i = 0; i < 5; i++) {
      if (normalize(nameUpperTokens[i]) !== normalize(FABRICA_PHRASE[i])) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      genericPrefix = "FABRICA DE ARTIGOS DE VESTUARIO";
      matchedGeneric = 5;
    }
  }

  // Check other generic words at the start
  if (!genericPrefix && nameUpperTokens.length > 0) {
    const firstWord = normalize(nameUpperTokens[0]);
    for (const gword of GENERIC_WORDS) {
      if (normalize(gword) === firstWord) {
        genericPrefix = nameUpperTokens[0];
        matchedGeneric = 1;
        break;
      }
    }
  }

  // If we found a generic prefix, try to build MID without it
  if (genericPrefix && (genericPrefix.startsWith("PT") || genericPrefix.includes("JSC") || genericPrefix.includes("OAO") || genericPrefix.includes("OOO") || genericPrefix.includes("ZAO") || genericPrefix.startsWith("FABRICA"))) {
    // These are the ones where we keep a "without generic" version
    const remainingTokens = nameUpperTokens.slice(matchedGeneric).join(" ");
    if (remainingTokens) {
      const withoutGenericName = extractNamePart(remainingTokens);
      if (withoutGenericName) {
        withoutGeneric = countryPart + withoutGenericName + numberPart + cityPart;
        // Ensure it's at most 15 chars
        if (withoutGeneric.length <= 15) {
          // Keep it as is
        } else {
          withoutGeneric = null;
        }
      }
    }
  }

  const value = countryPart + namePart + numberPart + cityPart;

  if (value.length > 15) {
    return { ok: false, reason: "The MID is too long (over 15 characters)." };
  }

  return {
    ok: true,
    value,
    parts: { country: countryPart, name: namePart, number: numberPart, city: cityPart },
    genericPrefix,
    withoutGeneric,
    notes,
  };
}

/** Remove words containing digits from a part */
function stripDigits(part: string): string {
  if (!part) return "";
  const words = part.split(/\s+/).filter((w) => !/\d/.test(w));
  return words.join(" ");
}

/**
 * Split an issuer address into street, city, country code and province.
 * Requirement 48.7
 */
export function splitIssuerAddress(address: string): { street: string; city: string | null; countryCode: string | null; province: string | null } {
  if (!address) return { street: "", city: null, countryCode: null, province: null };

  // 1. Split on commas, trim, drop empty
  let parts = address.split(",").map((p) => p.trim()).filter((p) => p);
  if (parts.length === 0) return { street: "", city: null, countryCode: null, province: null };

  let countryCode: string | null = null;
  let province: string | null = null;

  // 2. Country: check last part with digits removed
  if (parts.length > 0) {
    const lastStripped = stripDigits(parts[parts.length - 1]);
    const lastStrippedNorm = normalize(lastStripped);

    // Check alias first
    if (COUNTRY_ALIASES[lastStrippedNorm]) {
      countryCode = COUNTRY_ALIASES[lastStrippedNorm];
      parts.pop();
    } else {
      // Check country names
      for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) {
        if (normalize(alias) === lastStrippedNorm) {
          countryCode = code;
          parts.pop();
          break;
        }
      }
    }
  }

  // 3. State or province: check last part with digits removed
  if (parts.length > 0) {
    const lastStripped = stripDigits(parts[parts.length - 1]);
    const lastStrippedUpper = lastStripped.toUpperCase();
    const lastStrippedNorm = normalize(lastStripped);

    // Check if it's a US state (postal code)
    if (lastStrippedUpper.length === 2 && lastStrippedUpper in US_STATES) {
      province = lastStrippedUpper;
      countryCode = countryCode ?? "US";
      parts.pop();
    } else {
      // Check if it's a US state name
      const stateCode = STATE_NAMES_TO_CODES.get(lastStrippedNorm);
      if (stateCode) {
        province = lastStripped;
        countryCode = countryCode ?? "US";
        parts.pop();
      } else {
        // Check if it's a Canadian province (postal code)
        if (lastStrippedUpper in CANADIAN_PROVINCES) {
          province = lastStrippedUpper;
          countryCode = countryCode ?? "CA";
          parts.pop();
        } else {
          // Check if it's a Canadian province name
          for (const [name, code] of CANADIAN_PROVINCE_NAMES.entries()) {
            if (normalize(name) === lastStrippedNorm) {
              province = name;
              countryCode = countryCode ?? "CA";
              parts.pop();
              break;
            }
          }
        }
      }
    }
  }

  // 4. HK, SG, MO: city is the country name, street is everything before
  if (countryCode === "HK") {
    return {
      street: parts.join(", "),
      city: "Hong Kong",
      countryCode,
      province: null,
    };
  }
  if (countryCode === "SG") {
    return {
      street: parts.join(", "),
      city: "Singapore",
      countryCode,
      province: null,
    };
  }
  if (countryCode === "MO") {
    return {
      street: parts.join(", "),
      city: "Macau",
      countryCode,
      province: null,
    };
  }

  // 5. Otherwise: city is last part with digits removed, street is the rest
  if (parts.length === 0) {
    return { street: "", city: null, countryCode, province };
  }

  const lastPart = parts[parts.length - 1];
  const lastPartStripped = stripDigits(lastPart).trim();

  let city: string | null = null;
  let street = "";

  if (parts.length === 1) {
    // Only one part left: it's the city
    city = lastPartStripped || null;
    street = "";
  } else {
    // Multiple parts: last is city, rest is street
    city = lastPartStripped || null;
    street = parts.slice(0, -1).join(", ");
  }

  return { street, city, countryCode, province };
}

/**
 * Suggest MID from name, address and origin country.
 * Requirement 48.8
 */
export function suggestMid(input: { name: string; address: string; origin: string }): MidResult {
  const { street, city, countryCode, province } = splitIssuerAddress(input.address);

  const result = midFromParts({
    name: input.name,
    street,
    city,
    country: input.origin,
    province,
  });

  if (!result.ok) return result;

  // Add note if address country differs from origin
  if (countryCode && countryCode !== input.origin) {
    result.notes.push(`The goods come from ${input.origin} but the invoice issuer's address is in ${countryCode}; the MID starts with the country of origin.`);
  }

  return result;
}
