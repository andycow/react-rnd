import { clamp } from '../math';
import { updatePI, type PIState } from './PI';

/**
 * ABS：以「目標滑動率」做 PI 調變，不做生硬的 bang-bang 脈衝。
 * 回傳 0..1 的煞車壓力倍率，每輪各自一個 state。
 */
export interface AbsParams {
  enabled: boolean;
  peakSlipRatio: number;
  engageRatio: number; // κ < −peak × 1.15 才啟動
  targetRatio: number; // 目標 κ = −peak × 1.0
  releaseRatio: number; // κ > −peak × 0.5 且積分歸零才解除
  kp: number; // 例 1.5
  ki: number; // 例 20
  minPressure: number; // 例 0.05
  minSpeed: number; // m/s，例 5 km/h = 1.39
  hudPulseHz: number; // 只給 HUD/震動用，例 15
}

export interface AbsWheelState extends PIState {
  active: boolean;
  pressure: number;
  phase: number;
}

export const createAbsState = (): AbsWheelState => ({ active: false, pressure: 1, phase: 0, integ: 0 });

export interface AbsOutput {
  pressureScale: number;
  active: boolean;
  /** 15 Hz ±5% 的回饋訊號，不影響物理 */
  hudPulse: number;
}

/** brakeCmd：該輪的總煞車需求（玩家煞車 + STM 附加煞車），正規化到 0..1 */
export function updateAbs(
  p: AbsParams,
  st: AbsWheelState,
  slipRatio: number,
  forwardSpeed: number,
  brakeCmd: number,
  dt: number,
): AbsOutput {
  if (!p.enabled || Math.abs(forwardSpeed) < p.minSpeed || brakeCmd < 0.01) {
    st.active = false;
    st.integ = 0;
    st.pressure = 1;
    return { pressureScale: 1, active: false, hudPulse: 0 };
  }

  // 倒車時 κ 的意義相反，統一換成「煞車方向的滑動」
  const k = forwardSpeed >= 0 ? slipRatio : -slipRatio;
  if (!st.active && k < -p.peakSlipRatio * p.engageRatio) st.active = true;

  if (st.active) {
    const target = -p.peakSlipRatio * p.targetRatio;
    const e = (target - k) / p.peakSlipRatio; // > 0：滑太多
    const u = updatePI(st, e, p.kp, p.ki, 1 / p.ki, dt);
    st.pressure = clamp(1 - u, p.minPressure, 1);
    if (st.integ === 0 && k > -p.peakSlipRatio * p.releaseRatio) st.active = false;
  } else {
    st.pressure = 1;
  }

  st.phase = (st.phase + p.hudPulseHz * dt) % 1;
  const hudPulse = st.active ? 0.05 * Math.sin(st.phase * 2 * Math.PI) : 0;
  return { pressureScale: st.pressure, active: st.active, hudPulse };
}
