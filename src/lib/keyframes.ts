/** Index of the last element <= t (or -1). */
export function lastAtOrBefore(times: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function nearest(times: ArrayLike<number>, t: number): number | null {
  if (times.length === 0) return null;
  const i = lastAtOrBefore(times, t);
  if (i < 0) return times[0];
  if (i >= times.length - 1) return times[times.length - 1];
  return t - times[i] <= times[i + 1] - t ? times[i] : times[i + 1];
}

/** Keyframe at or before t (tolerance 1 ms) — where a stream copy really starts. */
export function keyframeAtOrBefore(times: ArrayLike<number>, t: number): number | null {
  if (times.length === 0) return null;
  const i = lastAtOrBefore(times, t + 0.001);
  return i < 0 ? times[0] : times[i];
}

export function nextAfter(times: ArrayLike<number>, t: number): number | null {
  const i = lastAtOrBefore(times, t + 0.0005);
  return i + 1 < times.length ? times[i + 1] : null;
}

export function prevBefore(times: ArrayLike<number>, t: number): number | null {
  const i = lastAtOrBefore(times, t - 0.0005);
  return i >= 0 ? times[i] : null;
}

export function isOnKeyframe(times: ArrayLike<number>, t: number): boolean {
  const n = nearest(times, t);
  return n !== null && Math.abs(n - t) < 0.0015;
}

export function mergeSorted(a: ArrayLike<number>, b: number[]): number[] {
  const all = Array.from(a).concat(b).sort((x, y) => x - y);
  const out: number[] = [];
  for (const v of all) if (out.length === 0 || Math.abs(out[out.length - 1] - v) > 1e-6) out.push(v);
  return out;
}
