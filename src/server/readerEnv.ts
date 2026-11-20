import type { Caps } from "../core/budget";
import { intakeConfig } from "../core/intakeConfig";

export type ReaderMode = "off" | "fake" | "claude";

export type ReaderSetup = {
  mode: ReaderMode;
  reason: string | null;
  caps: Caps;
  costCapNanoUsd: number;
  store: "file" | "netlify-blobs" | null;
  storeDir: string;
  visitorSalt: string | null;
  apiKey: string | null;
};

function trimEnv(val: string | undefined): string | null {
  const trimmed = val?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function parseCapValue(val: string | null): number | null {
  if (!val) return null;
  if (!/^\d{1,6}$/.test(val)) return null;
  return parseInt(val, 10);
}

export function resolveReaderSetup(env: Record<string, string | undefined>): ReaderSetup {
  // 1. Check kill switch
  const killSwitch = trimEnv(env.DOCUMENT_INTAKE_KILL_SWITCH);
  if (killSwitch !== null) {
    return {
      mode: "off",
      reason: "kill switch is on",
      caps: { total: 0, daily: 0, perVisitorDaily: 0 },
      costCapNanoUsd: 0,
      store: null,
      storeDir: "logs",
      visitorSalt: null,
      apiKey: null,
    };
  }

  // 2. Read store BEFORE parsing caps
  const storeEnv = trimEnv(env.DOCUMENT_INTAKE_STORE);
  let store: "file" | "netlify-blobs" | null;
  if (storeEnv === "file") {
    store = "file";
  } else if (storeEnv === "netlify-blobs") {
    store = "netlify-blobs";
  } else {
    store = null;
  }

  // 3. Parse caps with defaults based on store
  const defaultCaps = store === "netlify-blobs" ? intakeConfig.caps.publicSite : intakeConfig.caps.local;

  const totalCapStr = trimEnv(env.DOCUMENT_INTAKE_TOTAL_CAP) ?? String(defaultCaps.total);
  const dailyCapStr = trimEnv(env.DOCUMENT_INTAKE_DAILY_CAP) ?? String(defaultCaps.daily);
  const visitorCapStr = trimEnv(env.DOCUMENT_INTAKE_VISITOR_DAILY_CAP) ?? String(defaultCaps.perVisitorDaily);

  const totalCap = parseCapValue(totalCapStr);
  const dailyCap = parseCapValue(dailyCapStr);
  const visitorCap = parseCapValue(visitorCapStr);

  const caps: Caps = { total: defaultCaps.total, daily: defaultCaps.daily, perVisitorDaily: defaultCaps.perVisitorDaily };
  let capError: string | null = null;

  if (totalCap === null) {
    capError = "invalid setting DOCUMENT_INTAKE_TOTAL_CAP";
  } else if (dailyCap === null) {
    capError = "invalid setting DOCUMENT_INTAKE_DAILY_CAP";
  } else if (visitorCap === null) {
    capError = "invalid setting DOCUMENT_INTAKE_VISITOR_DAILY_CAP";
  } else {
    caps.total = totalCap;
    caps.daily = dailyCap;
    caps.perVisitorDaily = visitorCap;
  }

  // 4. Parse cost cap (won cap)
  let costCapNanoUsd: number = Math.floor((defaultCaps.costKrw * 1_000_000_000) / intakeConfig.krwPerUsd);

  const costCapKrwStr = trimEnv(env.DOCUMENT_INTAKE_COST_CAP_KRW);
  if (costCapKrwStr !== null) {
    if (capError === null) {
      if (!/^\d{1,7}$/.test(costCapKrwStr)) {
        capError = "invalid setting DOCUMENT_INTAKE_COST_CAP_KRW";
      } else {
        const costCapKrw = parseInt(costCapKrwStr, 10);
        if (costCapKrw <= 0) {
          capError = "invalid setting DOCUMENT_INTAKE_COST_CAP_KRW";
        } else {
          costCapNanoUsd = Math.floor((costCapKrw * 1_000_000_000) / intakeConfig.krwPerUsd);
        }
      }
    }
  }

  if (capError) {
    return {
      mode: "off",
      reason: capError,
      caps,
      costCapNanoUsd,
      store,
      storeDir: "logs",
      visitorSalt: null,
      apiKey: null,
    };
  }

  // 5. Check for fake mode
  const intakeMode = trimEnv(env.DOCUMENT_INTAKE_MODE);
  if (intakeMode === "fake") {
    return {
      mode: "fake",
      reason: null,
      caps,
      costCapNanoUsd,
      store: null,
      storeDir: "logs",
      visitorSalt: trimEnv(env.DOCUMENT_INTAKE_VISITOR_SALT),
      apiKey: null,
    };
  }

  // 6. Check for Claude mode
  // The key comes only from DOCUMENT_INTAKE_ANTHROPIC_KEY (Requirement 25). ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL
  // are never read: a hosting platform may set them by itself for its own AI gateway.
  const apiKey = trimEnv(env.DOCUMENT_INTAKE_ANTHROPIC_KEY);

  if (!apiKey) {
    return {
      mode: "off",
      reason: "no API key",
      caps,
      costCapNanoUsd,
      store,
      storeDir: trimEnv(env.DOCUMENT_INTAKE_STORE_DIR) ?? "logs",
      visitorSalt: trimEnv(env.DOCUMENT_INTAKE_VISITOR_SALT),
      apiKey: null,
    };
  }

  if (!store) {
    return {
      mode: "off",
      reason: "no durable usage store configured",
      caps,
      costCapNanoUsd,
      store,
      storeDir: trimEnv(env.DOCUMENT_INTAKE_STORE_DIR) ?? "logs",
      visitorSalt: trimEnv(env.DOCUMENT_INTAKE_VISITOR_SALT),
      apiKey: null,
    };
  }

  return {
    mode: "claude",
    reason: null,
    caps,
    costCapNanoUsd,
    store,
    storeDir: trimEnv(env.DOCUMENT_INTAKE_STORE_DIR) ?? "logs",
    visitorSalt: trimEnv(env.DOCUMENT_INTAKE_VISITOR_SALT),
    apiKey,
  };
}
