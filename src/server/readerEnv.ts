import type { Caps } from "../core/budget";

export type ReaderMode = "off" | "fake" | "claude";

export type ReaderSetup = {
  mode: ReaderMode;
  reason: string | null;
  caps: Caps;
  store: "file" | null;
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
      store: null,
      storeDir: "logs",
      visitorSalt: null,
      apiKey: null,
    };
  }

  // 2. Parse caps
  const totalCapStr = trimEnv(env.DOCUMENT_INTAKE_TOTAL_CAP) ?? "300";
  const dailyCapStr = trimEnv(env.DOCUMENT_INTAKE_DAILY_CAP) ?? "0";
  const visitorCapStr = trimEnv(env.DOCUMENT_INTAKE_VISITOR_DAILY_CAP) ?? "3";

  const totalCap = parseCapValue(totalCapStr);
  const dailyCap = parseCapValue(dailyCapStr);
  const visitorCap = parseCapValue(visitorCapStr);

  const caps: Caps = { total: 300, daily: 0, perVisitorDaily: 3 };
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

  if (capError) {
    return {
      mode: "off",
      reason: capError,
      caps,
      store: null,
      storeDir: "logs",
      visitorSalt: null,
      apiKey: null,
    };
  }

  // 3. Check for fake mode
  const intakeMode = trimEnv(env.DOCUMENT_INTAKE_MODE);
  if (intakeMode === "fake") {
    return {
      mode: "fake",
      reason: null,
      caps,
      store: null,
      storeDir: "logs",
      visitorSalt: trimEnv(env.DOCUMENT_INTAKE_VISITOR_SALT),
      apiKey: null,
    };
  }

  // 4. Parse store
  const storeEnv = trimEnv(env.DOCUMENT_INTAKE_STORE);
  const store: "file" | null = storeEnv === "file" ? "file" : null;
  const storeDir = trimEnv(env.DOCUMENT_INTAKE_STORE_DIR) ?? "logs";

  // 5. Check for Claude mode
  const apiKey = trimEnv(env.ANTHROPIC_API_KEY);

  if (!apiKey) {
    return {
      mode: "off",
      reason: "no API key",
      caps,
      store,
      storeDir,
      visitorSalt: trimEnv(env.DOCUMENT_INTAKE_VISITOR_SALT),
      apiKey: null,
    };
  }

  if (!store) {
    return {
      mode: "off",
      reason: "no durable usage store configured",
      caps,
      store,
      storeDir,
      visitorSalt: trimEnv(env.DOCUMENT_INTAKE_VISITOR_SALT),
      apiKey: null,
    };
  }

  return {
    mode: "claude",
    reason: null,
    caps,
    store,
    storeDir,
    visitorSalt: trimEnv(env.DOCUMENT_INTAKE_VISITOR_SALT),
    apiKey,
  };
}
