export type OkResult<T> = { ok: true; value: T };

export type NeedsReview = { ok: false; reason: string };

export type RuleResult<T> = OkResult<T> | NeedsReview;

export type RoundingMode = "halfUp" | "halfDown" | "halfEven" | "truncate";

export type AllocatedWeight = { kg: number; lineIndex: number; estimated: boolean };

export type NumberedLineItem = { lineNumber: string; [key: string]: any };
