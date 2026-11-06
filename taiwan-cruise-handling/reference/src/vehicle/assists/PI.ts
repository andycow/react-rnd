import { clamp } from '../math';

/** 帶 anti-windup 的 PI 控制器，積分項限制在 [0, iMax] */
export interface PIState {
  integ: number;
}

export function updatePI(
  st: PIState,
  error: number,
  kp: number,
  ki: number,
  iMax: number,
  dt: number,
): number {
  st.integ = clamp(st.integ + error * dt, 0, iMax);
  return kp * error + ki * st.integ;
}

/** 一階低通，tau 為時間常數 */
export function lowPass(prev: number, target: number, tau: number, dt: number): number {
  if (tau <= 0) return target;
  return prev + (target - prev) * (1 - Math.exp(-dt / tau));
}
