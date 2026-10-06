/**
 * Speed and distance as pure functions of active run time (PRD SEC-02). The client derives its
 * distance from these instead of summing frames, so the server can recompute `distance(activeMs)`
 * exactly. Only +, -, ×, ÷ and Math.sqrt (correctly rounded by spec) are used.
 */
import { TUNING } from "./config";

const { start: V0, accel: A, max: VMAX } = TUNING.speed;
/** Run time at which speed reaches the cap. */
const T_CAP = (VMAX - V0) / A;
/** Distance covered by T_CAP. */
const D_CAP = V0 * T_CAP + (A * T_CAP * T_CAP) / 2;

/** Speed in px/s after `t` seconds of active play. */
export function speedAt(t: number): number {
  if (t <= 0) return V0;
  return Math.min(VMAX, V0 + A * t);
}

/** Distance in px after `t` seconds of active play. */
export function distancePxAt(t: number): number {
  if (t <= 0) return 0;
  if (t <= T_CAP) return V0 * t + (A * t * t) / 2;
  return D_CAP + VMAX * (t - T_CAP);
}

/** Inverse of distancePxAt: active seconds needed to cover `d` px. */
export function timeAtDistancePx(d: number): number {
  if (d <= 0) return 0;
  if (d <= D_CAP) return (Math.sqrt(V0 * V0 + 2 * A * d) - V0) / A;
  return T_CAP + (d - D_CAP) / VMAX;
}

/** Speed in px/s at the moment the run reaches `d` px. */
export function speedAtDistancePx(d: number): number {
  if (d <= 0) return V0;
  if (d >= D_CAP) return VMAX;
  return Math.min(VMAX, Math.sqrt(V0 * V0 + 2 * A * d));
}

export const pxToMetres = (px: number): number => px / TUNING.pxPerMetre;
export const metresToPx = (m: number): number => m * TUNING.pxPerMetre;

/** Distance in metres after `activeMs` of play: the value the server checks within ±2%. */
export function distanceMAt(activeMs: number): number {
  return pxToMetres(distancePxAt(activeMs / 1000));
}
