export function formatAverageBitrate(bytes: number, durationSeconds: number): string | null {
  if (
    !Number.isFinite(bytes) ||
    bytes <= 0 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    return null;
  }

  const bitsPerSecond = (bytes * 8) / durationSeconds;
  if (bitsPerSecond < 1_000) return `${Math.round(bitsPerSecond)} bps`;
  return bitsPerSecond >= 1_000_000
    ? `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`
    : `${Math.round(bitsPerSecond / 1_000)} kbps`;
}
