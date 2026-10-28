import {
  formatDurationParts,
  resolveCompactDurationParts,
  resolveSingleUnitDurationParts,
} from "./format-duration-internal.js";

export type FormatDurationSecondsOptions = {
  decimals?: number;
  unit?: "s" | "seconds";
};

export type FormatDurationCompactOptions = {
  /** Show year units instead of folding them into days. Default: false */
  showYears?: boolean;
  /** Add space between units: "2m 5s" instead of "2m5s". Default: false */
  spaced?: boolean;
};

export function formatDurationSeconds(
  ms: number,
  options: FormatDurationSecondsOptions = {},
): string {
  if (!Number.isFinite(ms)) {
    return "unknown";
  }
  // Preserve the legacy toFixed precision coercion: fractional and non-finite
  // decimals truncate to an integer count (NaN -> 0) to keep the plugin-sdk
  // exported contract, and keep the exponent/divisor integer so rendering stays clean.
  const requested = options.decimals ?? 1;
  const decimals = Number.isFinite(requested) ? Math.max(0, Math.trunc(requested)) : 0;
  const unit = options.unit ?? "s";
  // Round once at the requested precision from the integer millisecond count so float
  // division noise cannot flip the final digit (e.g. 1005ms -> "1.01s", not "1.00s").
  const scaled = Math.round((Math.max(0, ms) * 10 ** decimals) / 1000);
  const whole = Math.floor(scaled / 10 ** decimals);
  const fraction = scaled % 10 ** decimals;
  const trimmed =
    fraction === 0
      ? `${whole}`
      : `${whole}.${String(fraction).padStart(decimals, "0").replace(/0+$/, "")}`;
  return unit === "seconds" ? `${trimmed} seconds` : `${trimmed}s`;
}

/** Precise decimal-seconds output: "500ms" or "1.23s". Input is milliseconds. */
export function formatDurationPrecise(
  ms: number,
  options: FormatDurationSecondsOptions = {},
): string {
  if (!Number.isFinite(ms)) {
    return "unknown";
  }
  const roundedMs = Math.max(0, Math.round(ms));
  if (roundedMs < 1000) {
    return `${roundedMs}ms`;
  }
  return formatDurationSeconds(ms, {
    decimals: options.decimals ?? 2,
    unit: options.unit ?? "s",
  });
}

/**
 * Compact compound duration: "500ms", "45s", "2m5s", "1h30m".
 * With `spaced`: "45s", "2m 5s", "1h 30m".
 * Omits trailing zero components: "1m" not "1m 0s", "2h" not "2h 0m".
 * Returns undefined for null/undefined/non-finite/non-positive input.
 */
export function formatDurationCompact(
  ms?: number | null,
  options?: FormatDurationCompactOptions,
): string | undefined {
  const parts = resolveCompactDurationParts(ms, options?.showYears);
  const formatted = parts && formatDurationParts(parts);
  return options?.spaced ? formatted : formatted?.replaceAll(" ", "");
}

/**
 * Rounded single-unit duration for display: "500ms", "5s", "3m", "2h", "5d".
 * Returns fallback string for null/undefined/non-finite input.
 */
export function formatDurationHuman(ms?: number | null, fallback = "n/a"): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
    return fallback;
  }
  return formatDurationParts(resolveSingleUnitDurationParts(ms));
}
