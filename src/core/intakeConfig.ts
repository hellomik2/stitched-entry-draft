export const intakeConfig = {
  maxFiles: 3,
  maxFileBytes: 10 * 1024 * 1024,
  maxPdfPages: 4,
  maxImagePages: 6,
  maxImageLongSide: 1600,
  minTextChars: 20,
  jpegQuality: 0.85,
  maxRequestBytes: 4_500_000,
  maxInvoiceLines: 8,
  readerModel: "claude-haiku-5-5",
  readerMaxOutputTokens: 8000,
  readerTimeoutMs: 45_000,
  prices: {
    inputNanoUsdPerToken: 100,
    outputNanoUsdPerToken: 500,
    upToPromptTokens: 100_000,
    inputNanoUsdPerTokenOver: 500,
    outputNanoUsdPerTokenOver: 2500,
    source: "Anthropic model pricing, Claude Haiku 5.5 (USD per million tokens: 0.10 input, 0.50 output up to 100K prompt tokens; 0.50 and 2.50 above)",
    checked: "2026-11-18",
  },
  // Per-call limits. maxCallCostNanoUsd is 1.5 x the large-call cost assumed when the AI budget was approved
  // (32,000 input + 8,000 output tokens on Claude Haiku 5.5 = 0.0072 USD).
  perCall: {
    maxPageTextChars: 15_000,
    maxTotalTextChars: 60_000,
    maxImageBase64Chars: 1_500_000,
    imageTokensPerPage: 5_000,
    promptOverheadTokens: 10_000,
    perPageOverheadTokens: 160,
    maxCallCostNanoUsd: 10_800_000,
  },
  // Won caps are converted at a deliberately high rate, so the dollar cap is smaller than the real one.
  krwPerUsd: 1500,
  // Default AI call caps. local: the file store on a developer machine. publicSite: the Netlify Blobs store on the deployed site. The DOCUMENT_INTAKE_*_CAP environment variables override each number.
  caps: {
    local: { total: 300, daily: 0, perVisitorDaily: 3, costKrw: 20_000 },
    publicSite: { total: 500, daily: 30, perVisitorDaily: 3, costKrw: 10_000 },
  },
} as const;

export type IntakeLimits = typeof intakeConfig;
