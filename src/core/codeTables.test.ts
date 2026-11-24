import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { SCHEDULE_D, SCHEDULE_K, lookupUsPort, lookupForeignPort } from "./codeTables";

// Feature: document-intake, Requirement 47.1 to 47.3 (task 59.1): port codes from the CBP code tables.

const usCodes = (r: ReturnType<typeof lookupUsPort>): string[] =>
  r.kind === "one" ? [r.row.code] : r.kind === "several" ? r.rows.map((x) => x.code) : [];
const kCodes = (r: ReturnType<typeof lookupForeignPort>): string[] =>
  r.kind === "none" ? [] : [...new Set(r.rows.map((x) => x.code))];

const STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico",
  NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
  SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico", VI: "Virgin Islands", GU: "Guam", AS: "American Samoa", MP: "Northern Mariana Islands",
};
const POSTAL: Record<string, string> = Object.fromEntries(Object.entries(STATES).map(([k, v]) => [v, k]));
const FACILITY = /\b(airport|air|airfield|user fee|hub|fedex|ups|dhl|eccf|courier|region|border patrol|cartage|tracking|alternate)\b/i;

describe("Requirement 47.1: the two tables", () => {
  it("Schedule D has the 522 rows of the 2026-02-03 edition and Schedule K the 3,543 rows of the 2024-08-27 list with the changes to 04/2026", () => {
    expect(SCHEDULE_D.edition).toBe("2026-02-03");
    expect(SCHEDULE_D.rows.length).toBe(522);
    expect(SCHEDULE_D.sourceUrl).toMatch(/^https:\/\/www\.cbp\.gov\/sites\/default\/files\/2026-02\//);
    expect(SCHEDULE_D.rows.find((r) => r.code === "2704")).toEqual({ code: "2704", name: "Los Angeles, California" });
    expect(SCHEDULE_K.edition).toBe("2024-08-27");
    expect(SCHEDULE_K.changesEdition).toBe("2026-08-20");
    expect(SCHEDULE_K.rows.length).toBe(3543);
    expect(SCHEDULE_K.rows.find((r) => r.name === "Haiphong; Hai Phong")).toEqual({ code: "55201", country: "Vietnam", name: "Haiphong; Hai Phong", change: "" });
    // The 04/2026 change gives Hamburg its new code.
    expect(SCHEDULE_K.rows.filter((r) => r.country === "Germany" && r.name === "Hamburg").map((r) => r.code)).toEqual(["42876"]);
  });
});

describe("Requirement 47.2: lookupUsPort", () => {
  it("one Schedule D port row gives one code", () => {
    expect(usCodes(lookupUsPort("Savannah, GA, USA"))).toEqual(["1703"]);
    expect(lookupUsPort("Savannah, GA, USA").kind).toBe("one");
    expect(usCodes(lookupUsPort("Port of Savannah, Georgia, United States"))).toEqual(["1703"]);
    expect(usCodes(lookupUsPort("Seattle, WA 98101, U.S.A."))).toEqual(["3001"]);
    expect(usCodes(lookupUsPort("Houston, TX, USA"))).toEqual(["5301"]);
    expect(usCodes(lookupUsPort("MIAMI, FL"))).toEqual(["5201"]);
    expect(usCodes(lookupUsPort("Portland, OR, USA"))).toEqual(["2904"]);
    expect(usCodes(lookupUsPort("Portland, Maine"))).toEqual(["0101"]);
  });

  it("airport, courier and region rows are not ports", () => {
    // Houston also has the airport rows 5309, 5314 and 5315 and the region row 7600; Los Angeles has 2720, 2755, 2775, 2776 and 2791.
    for (const code of ["5309", "5314", "5315", "7600", "2720", "2755", "2775", "2776", "2791"]) {
      expect(usCodes(lookupUsPort("Houston, TX, USA"))).not.toContain(code);
      expect(usCodes(lookupUsPort("Los Angeles, CA, USA"))).not.toContain(code);
    }
  });

  it("Los Angeles and Long Beach come together, and so do New York and Newark", () => {
    const la = lookupUsPort("Los Angeles, CA, USA");
    expect(la.kind).toBe("several");
    expect(usCodes(la)).toEqual(["2704", "2709"]);
    expect(usCodes(lookupUsPort("Long Beach, CA, USA"))).toEqual(["2704", "2709"]);
    expect(usCodes(lookupUsPort("Port of Long Beach, California"))).toEqual(["2704", "2709"]);
    expect(usCodes(lookupUsPort("New York, NY, USA"))).toEqual(["1001", "4601"]);
    expect(usCodes(lookupUsPort("Newark, NJ, USA"))).toEqual(["1001", "4601"]);
    expect(usCodes(lookupUsPort("Port Elizabeth, New Jersey"))).toEqual(["1001", "4601"]);
  });

  it("a city name in two states without a state gives both codes", () => {
    const r = lookupUsPort("Portland, USA");
    expect(r.kind).toBe("several");
    expect(usCodes(r)).toEqual(["0101", "2904"]);
  });

  it("no port row gives none", () => {
    expect(lookupUsPort("Atlantis, ZZ, USA").kind).toBe("none");
    expect(lookupUsPort("Rotterdam, Netherlands").kind).toBe("none");
    expect(lookupUsPort("").kind).toBe("none");
  });
});

describe("Requirement 47.3: lookupForeignPort", () => {
  it("a name in the named country gives its one code", () => {
    expect(kCodes(lookupForeignPort("Haiphong, Vietnam"))).toEqual(["55201"]);
    expect(lookupForeignPort("Haiphong, Vietnam").kind).toBe("one");
    expect(kCodes(lookupForeignPort("Hai Phong, Viet Nam"))).toEqual(["55201"]);
    expect(kCodes(lookupForeignPort("Leixoes, Portugal"))).toEqual(["47123"]);
    expect(kCodes(lookupForeignPort("Leixões, Portugal"))).toEqual(["47123"]);
    expect(kCodes(lookupForeignPort("Ho Chi Minh City, Vietnam"))).toEqual(["55224"]);
    expect(kCodes(lookupForeignPort("SAIGON, VIET NAM"))).toEqual(["55224"]);
    expect(kCodes(lookupForeignPort("Shanghai, China"))).toEqual(["57035"]);
    expect(kCodes(lookupForeignPort("Kaohsiung, Taiwan"))).toEqual(["58309"]);
    expect(kCodes(lookupForeignPort("Busan, Korea, Republic of"))).toEqual(["58023"]);
    expect(kCodes(lookupForeignPort("Saba, Bonaire, Sint Eustatius & Saba"))).toEqual(["27754"]);
  });

  it("the 2025 and 2026 changes are in the table", () => {
    expect(kCodes(lookupForeignPort("Hamburg, Germany"))).toEqual(["42876"]);
    expect(kCodes(lookupForeignPort("Tobruk, Libya"))).toEqual(["72517"]);
    expect(kCodes(lookupForeignPort("Tanger Med, Morocco"))).toEqual(["71427"]);
    expect(kCodes(lookupForeignPort("Nghi Son, Vietnam"))).toEqual(["55203"]);
    // The alias "Tanger" was deleted in 02/2026; "Tangier" stays.
    expect(lookupForeignPort("Tanger, Morocco").kind).toBe("none");
    expect(kCodes(lookupForeignPort("Tangier, Morocco"))).toEqual(["71425"]);
  });

  it("the same name in two countries: the country narrows it, without a country both codes come", () => {
    expect(kCodes(lookupForeignPort("Portland, Australia"))).toEqual(["60261"]);
    expect(kCodes(lookupForeignPort("Portland, UK"))).toEqual(["41398"]);
    const both = lookupForeignPort("Portland");
    expect(both.kind).toBe("several");
    expect(kCodes(both).sort()).toEqual(["41398", "60261"]);
  });

  it("one name with two codes in one country gives several", () => {
    const r = lookupForeignPort("Treasure Cay, Bahamas");
    expect(r.kind).toBe("several");
    expect(kCodes(r).sort()).toEqual(["23644", "26344"]);
  });

  it("a name that is not in the table gives none with the country's All Other rows", () => {
    const r = lookupForeignPort("Cai Mep, Vietnam");
    expect(r.kind).toBe("none");
    if (r.kind !== "none") return;
    expect(r.allOther.map((x) => x.code)).toEqual(["55200"]);
    const m = lookupForeignPort("Nowhere Bay, Morocco");
    if (m.kind !== "none") throw new Error("expected none");
    expect(m.allOther.map((x) => x.code).sort()).toEqual(["71400", "71499"]);
    const x = lookupForeignPort("Nowhere Bay");
    if (x.kind !== "none") throw new Error("expected none");
    expect(x.allOther).toEqual([]);
  });

  it("a port name with a comma falls back to its first part", () => {
    expect(kCodes(lookupForeignPort("Haiphong, Hai Phong City, Vietnam"))).toEqual(["55201"]);
  });
});

describe("Property 64: a code table lookup never drops a candidate (Requirements 47.2, 47.3)", () => {
  const kPairs: { code: string; country: string; name: string }[] = [];
  for (const r of SCHEDULE_K.rows) {
    const names = r.name.startsWith("All Other") ? r.name.split(";") : r.name.split(/[;,]/);
    for (const n of names.map((x) => x.trim()).filter((x) => /[A-Za-z0-9]/.test(x))) kPairs.push({ code: r.code, country: r.country, name: n });
  }
  const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  it("every Schedule K row is found by each of its names with its country, and one code means every such row has it", () => {
    const byKey = new Map<string, Set<string>>();
    for (const q of kPairs) {
      const key = `${q.country}|${norm(q.name)}`;
      if (!byKey.has(key)) byKey.set(key, new Set());
      byKey.get(key)!.add(q.code);
    }
    for (const p of kPairs) {
      const r = lookupForeignPort(`${p.name}, ${p.country}`);
      const got = kCodes(r);
      expect(got, `${p.name}, ${p.country}`).toContain(p.code);
      if (r.kind === "one") expect(byKey.get(`${p.country}|${norm(p.name)}`), `${p.name}, ${p.country}`).toEqual(new Set([p.code]));
    }
  }, 60000);

  it("case and spaces around the commas do not change a Schedule K result", () => {
    fc.assert(
      fc.property(fc.constantFrom(...kPairs), fc.boolean(), fc.constantFrom(", ", " , ", ",", ",  "), (p, upper, sep) => {
        const text = `${upper ? p.name.toUpperCase() : p.name.toLowerCase()}${sep}${p.country}`;
        expect(kCodes(lookupForeignPort(text)).sort()).toEqual(kCodes(lookupForeignPort(`${p.name}, ${p.country}`)).sort());
      }),
      { numRuns: 300 },
    );
  });

  it("every Schedule D port row is found by its city, state postal code and USA", () => {
    const ports = SCHEDULE_D.rows.filter((r) => {
      const parts = r.name.split(",");
      return parts.length === 2 && !FACILITY.test(parts[0]) && POSTAL[parts[1].trim()] !== undefined;
    });
    expect(ports.length).toBeGreaterThan(300);
    fc.assert(
      fc.property(fc.constantFrom(...ports), (r) => {
        const [city, state] = r.name.split(",").map((x) => x.trim());
        expect(usCodes(lookupUsPort(`${city}, ${POSTAL[state]}, USA`)), r.name).toContain(r.code);
        expect(usCodes(lookupUsPort(`${city}, ${state}`)), r.name).toContain(r.code);
      }),
      { numRuns: 400 },
    );
  });
});
