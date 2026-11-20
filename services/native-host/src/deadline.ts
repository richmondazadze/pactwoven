import { getDeadline } from '@vercel/functions';
export function invocationDeadline(maximumMilliseconds: number): number {
  const started = Date.now();
  const platform = getDeadline()?.getTime();
  return typeof platform === 'number' && Number.isFinite(platform)
    ? Math.min(platform, started + maximumMilliseconds) : started + maximumMilliseconds;
}
