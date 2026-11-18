import { describe, it, expect } from "vitest";
import { resolveReaderSetup } from "./readerEnv";
import { intakeConfig } from "../core/intakeConfig";

describe("readerEnv: resolveReaderSetup cost cap", () => {
  it("netlify-blobs store gives costCapNanoUsd 6_666_666_666", () => {
    const setup = resolveReaderSetup({
      DOCUMENT_INTAKE_STORE: "netlify-blobs",
      DOCUMENT_INTAKE_TOTAL_CAP: "100",
      DOCUMENT_INTAKE_DAILY_CAP: "10",
      DOCUMENT_INTAKE_VISITOR_DAILY_CAP: "3",
    });

    expect(setup.costCapNanoUsd).toBe(
      Math.floor((intakeConfig.caps.publicSite.costKrw * 1_000_000_000) / intakeConfig.krwPerUsd),
    );
    expect(setup.costCapNanoUsd).toBe(6_666_666_666);
  });

  it("file store gives costCapNanoUsd 13_333_333_333", () => {
    const setup = resolveReaderSetup({
      DOCUMENT_INTAKE_STORE: "file",
      DOCUMENT_INTAKE_TOTAL_CAP: "100",
      DOCUMENT_INTAKE_DAILY_CAP: "10",
      DOCUMENT_INTAKE_VISITOR_DAILY_CAP: "3",
    });

    expect(setup.costCapNanoUsd).toBe(
      Math.floor((intakeConfig.caps.local.costKrw * 1_000_000_000) / intakeConfig.krwPerUsd),
    );
    expect(setup.costCapNanoUsd).toBe(13_333_333_333);
  });

  it('DOCUMENT_INTAKE_COST_CAP_KRW: "5000" gives 3_333_333_333', () => {
    const setup = resolveReaderSetup({
      DOCUMENT_INTAKE_STORE: "file",
      DOCUMENT_INTAKE_TOTAL_CAP: "100",
      DOCUMENT_INTAKE_DAILY_CAP: "10",
      DOCUMENT_INTAKE_VISITOR_DAILY_CAP: "3",
      DOCUMENT_INTAKE_COST_CAP_KRW: "5000",
    });

    expect(setup.costCapNanoUsd).toBe(Math.floor((5000 * 1_000_000_000) / intakeConfig.krwPerUsd));
    expect(setup.costCapNanoUsd).toBe(3_333_333_333);
  });

  it('"0" and "abc" give mode "off" with reason "invalid setting DOCUMENT_INTAKE_COST_CAP_KRW"', () => {
    const setup1 = resolveReaderSetup({
      DOCUMENT_INTAKE_STORE: "file",
      DOCUMENT_INTAKE_TOTAL_CAP: "100",
      DOCUMENT_INTAKE_DAILY_CAP: "10",
      DOCUMENT_INTAKE_VISITOR_DAILY_CAP: "3",
      DOCUMENT_INTAKE_COST_CAP_KRW: "0",
    });

    expect(setup1.mode).toBe("off");
    expect(setup1.reason).toBe("invalid setting DOCUMENT_INTAKE_COST_CAP_KRW");

    const setup2 = resolveReaderSetup({
      DOCUMENT_INTAKE_STORE: "file",
      DOCUMENT_INTAKE_TOTAL_CAP: "100",
      DOCUMENT_INTAKE_DAILY_CAP: "10",
      DOCUMENT_INTAKE_VISITOR_DAILY_CAP: "3",
      DOCUMENT_INTAKE_COST_CAP_KRW: "abc",
    });

    expect(setup2.mode).toBe("off");
    expect(setup2.reason).toBe("invalid setting DOCUMENT_INTAKE_COST_CAP_KRW");
  });

  it("caps still has exactly three keys (total, daily, perVisitorDaily) for netlify-blobs", () => {
    const setup = resolveReaderSetup({
      DOCUMENT_INTAKE_STORE: "netlify-blobs",
      DOCUMENT_INTAKE_TOTAL_CAP: "100",
      DOCUMENT_INTAKE_DAILY_CAP: "10",
      DOCUMENT_INTAKE_VISITOR_DAILY_CAP: "3",
    });

    expect(Object.keys(setup.caps)).toEqual(["total", "daily", "perVisitorDaily"]);
    expect(setup.caps).toEqual({ total: 100, daily: 10, perVisitorDaily: 3 });
  });

  it("with DOCUMENT_INTAKE_TOTAL_CAP: 'x' and DOCUMENT_INTAKE_COST_CAP_KRW: 'y' the reason is 'invalid setting DOCUMENT_INTAKE_TOTAL_CAP'", () => {
    const setup = resolveReaderSetup({
      DOCUMENT_INTAKE_STORE: "file",
      DOCUMENT_INTAKE_TOTAL_CAP: "x",
      DOCUMENT_INTAKE_DAILY_CAP: "10",
      DOCUMENT_INTAKE_VISITOR_DAILY_CAP: "3",
      DOCUMENT_INTAKE_COST_CAP_KRW: "y",
    });

    expect(setup.mode).toBe("off");
    expect(setup.reason).toBe("invalid setting DOCUMENT_INTAKE_TOTAL_CAP");
  });
});
