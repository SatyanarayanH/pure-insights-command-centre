const usd0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});
const usd2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const DASH = '—';

export const fmtUsd = (value: number | null | undefined): string =>
  value == null ? DASH : usd0.format(value);
export const fmtUsd2 = (value: number | null | undefined): string =>
  value == null ? DASH : usd2.format(value);
export const fmtUsdCompact = (value: number | null | undefined): string =>
  value == null ? DASH : `$${compact.format(value)}`;
export const fmtNum = (value: number | null | undefined, digits = 0): string =>
  value == null
    ? DASH
    : value.toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
export const fmtCompact = (value: number | null | undefined): string =>
  value == null ? DASH : compact.format(value);
export const fmtPct = (value: number | null | undefined, digits = 1): string =>
  value == null ? DASH : `${(value * 100).toFixed(digits)}%`;
export const fmtSec = (value: number | null | undefined): string =>
  value == null ? DASH : `${value.toFixed(1)} s`;

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return DASH;
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return DASH;
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function fmtAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return DASH;
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86_400 * 60) return `${Math.floor(seconds / 86_400)}d ago`;
  return fmtDate(iso);
}

export const titleCase = (value: string): string =>
  value
    .toLowerCase()
    .split(/[_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
