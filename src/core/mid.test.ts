import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { midFromParts, splitIssuerAddress, suggestMid } from "./mid";

// Feature: document-intake, Requirement 48.1 to 48.8 and 48.10 (task 60.1): the MID rule of the 7501 instructions, Appendix 2 (steering P14).

type Ex = { name: string; street: string; city: string; country: string; province?: string; address: string; mid: string; official: string };
// The 13 official examples (7501 instructions p.27 and 19 CFR Part 102 appendix, paragraph 7).
const EXAMPLES: Ex[] = [
  { name: "LA VIE DE FRANCE", street: "243 Rue de la Payees", city: "Bremond", country: "FR", address: "243 Rue de la Payees, 62591 Bremond, France", mid: "FRLAVIE243BRE", official: "FRLAVIE243BRE" },
  { name: "20th CENTURY TECHNOLOGIES", street: "5 Ricardo Munoz, Suite 5880", city: "Caracas", country: "VE", address: "5 Ricardo Munoz, Suite 5880, Caracas, Venezuela", mid: "VE20TCEN5880CAR", official: "VE20TCEN5880CAR" },
  { name: "THE E.K. RODGERS COMPANIES", street: "One Hawthorne Lane", city: "London", country: "GB", address: "One Hawthorne Lane, London, England SW1Y5HO", mid: "GBEKRODLON", official: "GBEKRODLON" },
  { name: "THE GREENHOUSE", street: "45 Royal Crescent", city: "Birmingham", country: "US", address: "45 Royal Crescent, Birmingham, Alabama 35204", mid: "USGRE45BIR", official: "USGRE45BIR" },
  { name: "CARDUCCIO AND JONES", street: "88 Canberra Avenue", city: "Sidney", country: "AU", address: "88 Canberra Avenue, Sidney, Australia", mid: "AUCARJON88SID", official: "AUCARJON88SID" },
  { name: "N. MINAMI & CO., LTD.", street: "2-6, 8-Chome Isogami-Dori, Fukiai-Ku", city: "Kobe", country: "JP", address: "2-6, 8-Chome Isogami-Dori, Fukiai-Ku, Kobe, Japan", mid: "JPMINCO26KOB", official: "JPMINCO26KOB" },
  { name: "BOCCHACCIO S.P.A.", street: "Visa Mendotti, 61", city: "8320 Verona", country: "IT", address: "Visa Mendotti, 61, 8320 Verona, Italy", mid: "ITBOCSPA61VER", official: "ITBOCSPA61VER" },
  { name: "MURLA-PRAXITELES INC.", street: "", city: "Athens", country: "GR", address: "Athens, Greece", mid: "GRMURINCATH", official: "GRMURINCATH" },
  { name: "SIGMA COY E.X.T.", street: "1640 Delgado", city: "4000 Smyrna", country: "IT", address: "1640 Delgado, 4000 Smyrna, Italy", mid: "ITSIGCOY1640SMY", official: "ITSIGCOY1640SMY" },
  { name: "COMPANHIA TEXTIL KARSTEN", street: "Calle Grande, 25-27", city: "67890 Lisbon", country: "PT", address: "Calle Grande, 25-27, 67890 Lisbon, Portugal", mid: "PTCOMTEX2527LIS", official: "PTKAR2527LIS" },
  { name: "HURON LANDMARK", street: "1840 Huron Road", city: "Windsor", country: "CA", province: "ON", address: "1840 Huron Road, Windsor, ON, Canada N9C2L5", mid: "XOHURLAN1840WIN", official: "XOHURLAN1840WIN" },
  { name: "Fabrica de Artigos de Vestuario TOP JOB", street: "Grand River Building, FI 2-4", city: "Macau", country: "MO", address: "Grand River Building, FI 2-4, Macau", mid: "MOFABDE24MAC", official: "MOTOPJOB24MAC" },
  { name: "A.B.C. COMPANY", street: "55-5 Hung To Road, P.O. Box 1234", city: "Kowloon", country: "HK", address: "55-5 Hung To Road, P.O. Box 1234, Kowloon, Hong Kong", mid: "HKABCCOM1234HON", official: "HKABCCOM1234HON" },
];
const fromParts = (e: Ex) => midFromParts({ name: e.name, street: e.street, city: e.city, country: e.country, province: e.province ?? null });
const value = (r: ReturnType<typeof midFromParts>) => (r.ok ? r.value : `not ok: ${r.reason}`);

describe("Requirement 48.10: the 13 official examples", () => {
  it("11 of the 13 give the official MID by the rule alone", () => {
    const same = EXAMPLES.filter((e) => value(fromParts(e)) === e.official).map((e) => e.official);
    expect(same.length).toBe(11);
    for (const e of EXAMPLES) expect(value(fromParts(e)), e.name).toBe(e.mid);
  });

  it("the two that need a person name their generic leading words", () => {
    const companhia = fromParts(EXAMPLES[9]);
    if (!companhia.ok) throw new Error(companhia.reason);
    expect([companhia.genericPrefix, companhia.withoutGeneric]).toEqual(["COMPANHIA", null]);
    const fabrica = fromParts(EXAMPLES[11]);
    if (!fabrica.ok) throw new Error(fabrica.reason);
    expect([fabrica.genericPrefix, fabrica.withoutGeneric]).toEqual(["FABRICA DE ARTIGOS DE VESTUARIO", "MOTOPJOB24MAC"]);
    for (const e of EXAMPLES.filter((x) => x !== EXAMPLES[9] && x !== EXAMPLES[11])) {
      const r = fromParts(e);
      if (!r.ok) throw new Error(r.reason);
      expect([r.genericPrefix, r.withoutGeneric], e.name).toEqual([null, null]);
    }
  });

  it("the parts of an example", () => {
    const r = fromParts(EXAMPLES[5]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.parts).toEqual({ country: "JP", name: "MINCO", number: "26", city: "KOB" });
    const hk = fromParts(EXAMPLES[12]);
    if (!hk.ok) throw new Error(hk.reason);
    expect(hk.parts).toEqual({ country: "HK", name: "ABCCOM", number: "1234", city: "HON" });
    expect(hk.notes).toContain("Hong Kong is a city-state, so the city part comes from the country name.");
  });

  it("the same examples from one address line, as the reader gives it", () => {
    for (const e of EXAMPLES) expect(value(suggestMid({ name: e.name, address: e.address, origin: e.country })), e.address).toBe(e.mid);
  });
});

describe("Requirement 48.2, 48.4, 48.5: the short examples of Appendix 2", () => {
  const nameOf = (name: string) => {
    const r = midFromParts({ name, street: "", city: "Tokyo", country: "JP", province: null });
    return r.ok ? r.parts.name : r.reason;
  };
  it("names", () => {
    expect(nameOf("Amalgamated Plastics Corp.")).toBe("AMAPLA");
    expect(nameOf("Bergstrom")).toBe("BER");
    expect(nameOf("A.B.C. Company")).toBe("ABCCOM");
    expect(nameOf("A B C Company")).toBe("ABCCOM");
    expect(nameOf("O.A.S.I.S. Corp.")).toBe("OASCOR");
    expect(nameOf("Dr. S.A. Smith")).toBe("DRSA");
    expect(nameOf("Shavings B L Inc.")).toBe("SHABL");
    expect(nameOf("The Embassy of Spain")).toBe("EMBSPA");
    expect(nameOf("Rawles-Aden Corp.")).toBe("RAWCOR");
    expect(nameOf("Rawles - Aden Corp.")).toBe("RAWCOR");
    expect(nameOf("20th Century Fox")).toBe("20TCEN");
    expect(nameOf("Concept 2000")).toBe("CON200");
    expect(nameOf("Thomas S. Delvaux Company")).toBe("THODEL");
  });
  const numberOf = (street: string) => {
    const r = midFromParts({ name: "Bergstrom", street, city: "Tokyo", country: "JP", province: null });
    return r.ok ? r.parts.number : r.reason;
  };
  it("street numbers", () => {
    expect(numberOf("11455 Main Street Suite 9999")).toBe("1145");
    expect(numberOf("232 Main Street Suite 1234")).toBe("1234");
    expect(numberOf("One Thousand Century Plaza")).toBe("");
    expect(numberOf("One Thousand Century Plaza Suite 345")).toBe("345");
    expect(numberOf("12,34,56 Alaska Road")).toBe("1234");
    expect(numberOf("12-34-56 Alaska Road")).toBe("1234");
    expect(numberOf("Apt. 509 2727 Cleveland St.")).toBe("2727");
  });
  const cityOf = (city: string, country: string) => {
    const r = midFromParts({ name: "Bergstrom", street: "", city, country, province: null });
    return r.ok ? r.parts.city : r.reason;
  };
  it("cities", () => {
    expect(cityOf("Tokyo", "JP")).toBe("TOK");
    expect(cityOf("St. Michel", "FR")).toBe("STM");
    expect(cityOf("18-Mile High", "US")).toBe("MIL");
    expect(cityOf("The Hague", "NL")).toBe("HAG");
    expect(cityOf("Hong Kong", "HK")).toBe("HON");
    expect(cityOf("Kowloon", "HK")).toBe("HON");
    expect(cityOf("Singapore", "SG")).toBe("SIN");
    expect(cityOf("Macau", "MO")).toBe("MAC");
    expect(cityOf("Leixões", "PT")).toBe("LEI");
  });
});

describe("Requirement 48.6: when no MID can be built", () => {
  it("Canada without a province, and a name or city without letters", () => {
    expect(midFromParts({ name: "HURON LANDMARK", street: "1840 Huron Road", city: "Windsor", country: "CA", province: null })).toEqual({
      ok: false,
      reason: "A Canadian MID starts with the province code, and the province was not found in the address.",
    });
    expect(midFromParts({ name: "HURON LANDMARK", street: "", city: "Windsor", country: "CA", province: "Ontario" })).toMatchObject({ ok: true, value: "XOHURLANWIN" });
    const bad = { ok: false, reason: "The invoice issuer's name or city gives no letters for the MID." };
    expect(midFromParts({ name: "& .", street: "1", city: "Tokyo", country: "JP", province: null })).toEqual(bad);
    expect(midFromParts({ name: "The A", street: "1", city: "Tokyo", country: "JP", province: null })).toEqual(bad);
    expect(midFromParts({ name: "Bergstrom", street: "1", city: "12345", country: "JP", province: null })).toEqual(bad);
  });
});

describe("Requirement 48.7: splitIssuerAddress", () => {
  it("street, city, country and province", () => {
    expect(splitIssuerAddress("13 Moonlit Quay Road, Haiphong, Vietnam")).toEqual({ street: "13 Moonlit Quay Road", city: "Haiphong", countryCode: "VN", province: null });
    expect(splitIssuerAddress("Rua das Corujas 12, Vila Nevoa, 0000-000 Portugal")).toEqual({ street: "Rua das Corujas 12", city: "Vila Nevoa", countryCode: "PT", province: null });
    expect(splitIssuerAddress("88 Duskvine Lane, Thornhollow 00000, Vietnam")).toEqual({ street: "88 Duskvine Lane", city: "Thornhollow", countryCode: "VN", province: null });
    expect(splitIssuerAddress("88 Lantern Alley, District 4, Ho Chi Minh City, Vietnam")).toEqual({ street: "88 Lantern Alley, District 4", city: "Ho Chi Minh City", countryCode: "VN", province: null });
    expect(splitIssuerAddress("One Hawthorne Lane, London, England SW1Y5HO")).toEqual({ street: "One Hawthorne Lane", city: "London", countryCode: "GB", province: null });
    expect(splitIssuerAddress("1840 Huron Road, Windsor, ON, Canada N9C2L5")).toEqual({ street: "1840 Huron Road", city: "Windsor", countryCode: "CA", province: "ON" });
    expect(splitIssuerAddress("45 Royal Crescent, Birmingham, Alabama 35204")).toEqual({ street: "45 Royal Crescent", city: "Birmingham", countryCode: "US", province: "Alabama" });
    expect(splitIssuerAddress("55-5 Hung To Road, P.O. Box 1234, Kowloon, Hong Kong")).toEqual({ street: "55-5 Hung To Road, P.O. Box 1234, Kowloon", city: "Hong Kong", countryCode: "HK", province: null });
    expect(splitIssuerAddress("Athens, Greece")).toEqual({ street: "", city: "Athens", countryCode: "GR", province: null });
    expect(splitIssuerAddress("Vietnam")).toEqual({ street: "", city: null, countryCode: "VN", province: null });
    expect(splitIssuerAddress("12 Unknown Road, Somewhere")).toEqual({ street: "12 Unknown Road", city: "Somewhere", countryCode: null, province: null });
  });
});

describe("Requirement 48.8: suggestMid notes a country of origin that differs from the address", () => {
  it("origin PT, address in Vietnam", () => {
    const r = suggestMid({ name: "Lantern Hollow Trading Co.", address: "13 Moonlit Quay Road, Haiphong, Vietnam", origin: "PT" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.value).toBe("PTLANHOL13HAI");
    expect(r.notes).toContain("The goods come from PT but the invoice issuer's address is in VN; the MID starts with the country of origin.");
    const same = suggestMid({ name: "Lantern Hollow Trading Co.", address: "13 Moonlit Quay Road, Haiphong, Vietnam", origin: "VN" });
    if (!same.ok) throw new Error(same.reason);
    expect(same.notes.some((n) => n.startsWith("The goods come from"))).toBe(false);
  });
});

describe("Property 66: the MID has the Appendix 2 shape and ignores what the rule ignores (Requirements 48.2, 48.4, 48.5, 48.6)", () => {
  const word = fc.stringMatching(/^[A-Z0-9]{2,8}$/);
  const country = fc.constantFrom("US", "VN", "PT", "JP", "FR", "GB", "IT", "DE", "CN", "MX", "HK", "SG", "MO", "CA");
  const input = fc.record({
    name: fc.array(word, { minLength: 1, maxLength: 4 }),
    street: fc.array(fc.oneof(fc.stringMatching(/^[A-Z]{2,8}$/), fc.integer({ min: 1, max: 99999 }).map(String)), { maxLength: 5 }),
    city: fc.array(fc.stringMatching(/^[A-Z]{3,9}$/), { minLength: 1, maxLength: 2 }),
    country,
  });
  const build = (name: string, street: string, city: string, c: string) => midFromParts({ name, street, city, country: c, province: c === "CA" ? "ON" : null });
  const prefix = (c: string) => (c === "CA" ? "XO" : c);

  it("at most 15 characters, A to Z and 0 to 9, starting with the country or province code", () => {
    fc.assert(
      fc.property(input, (x) => {
        const r = build(x.name.join(" "), x.street.join(" "), x.city.join(" "), x.country);
        if (!r.ok) return;
        expect(r.value.length).toBeLessThanOrEqual(15);
        expect(r.value).toMatch(/^[A-Z0-9]+$/);
        expect(r.value.startsWith(prefix(x.country))).toBe(true);
        expect(r.value).toBe(r.parts.country + r.parts.name + r.parts.number + r.parts.city);
      }),
      { numRuns: 300 },
    );
  });

  it("case, punctuation the rule ignores, extra spaces and the words the, and, of do not change it", () => {
    const decorate = fc.record({
      lower: fc.boolean(),
      commas: fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
      periods: fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
      fillers: fc.array(fc.constantFrom("", "the", "and", "of", "&", "THE"), { minLength: 8, maxLength: 8 }),
      spaces: fc.constantFrom(" ", "  ", "   "),
      apostrophe: fc.boolean(),
    });
    fc.assert(
      fc.property(input, decorate, (x, d) => {
        const plain = build(x.name.join(" "), x.street.join(" "), x.city.join(" "), x.country);
        const nameWords = x.name.map((w, i) => {
          let s = w;
          if (d.apostrophe && i === 0) s = `${s}'S`.replace(/'S$/, "'");
          if (d.periods[i]) s = `${s}.`;
          if (d.commas[i]) s = `${s},`;
          return d.fillers[i] && i > 0 ? `${d.fillers[i]} ${s}` : s;
        });
        const streetWords = x.street.map((w, i) => (d.commas[i] ? `${w},` : d.periods[i] ? `${w}.` : w));
        const cityWords = x.city.map((w, i) => (d.periods[i] ? `${w}.` : w));
        const cs = (s: string) => (d.lower ? s.toLowerCase() : s);
        const fancy = build(cs(nameWords.join(d.spaces)), cs(streetWords.join(d.spaces)), cs(`  ${cityWords.join(d.spaces)} `), x.country);
        expect(fancy.ok).toBe(plain.ok);
        if (plain.ok && fancy.ok) expect(fancy.value).toBe(plain.value);
      }),
      { numRuns: 300 },
    );
  });
});

describe("Property 67: the MID number is the largest street number (Requirement 48.4)", () => {
  it("first four digits of the largest number, empty without one", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.stringMatching(/^[A-Za-z]{1,8}$/), fc.integer({ min: 1, max: 2_000_000_000 }).map(String)), { maxLength: 8 }),
        (parts) => {
          const r = midFromParts({ name: "Bergstrom", street: parts.join(" "), city: "Tokyo", country: "JP", province: null });
          if (!r.ok) throw new Error(r.reason);
          const nums = parts.filter((p) => /^\d+$/.test(p)).map(Number);
          expect(r.parts.number).toBe(nums.length ? String(Math.max(...nums)).slice(0, 4) : "");
        },
      ),
      { numRuns: 400 },
    );
  });
});
