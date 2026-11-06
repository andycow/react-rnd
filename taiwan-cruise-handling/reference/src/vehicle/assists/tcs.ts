import { clamp } from '../math';
import { updatePI, type PIState } from './PI';

/**
 * TCS：驅動輪 κ 超過門檻 → 降低引擎扭力倍率。
 * 降扭立即生效，恢復則以 recoverRate 慢慢回升，避免油門忽大忽小。
 */
export interface TcsParams {
  enabled: boolean;
  peakSlipRatio: number;
  engageRatio: number; // 例 1.15
  targetRatio: number; // 例 1.0
  kp: number; // 例 0.25（太大會在全砍/恢復之間循環，平均扭力反而變少）
  ki: number; // 例 5
  recoverRate: number; // 每秒恢復量，例 3
  disableWithHandbrake: boolean;
}

export interface TcsState extends PIState {
  scale: number;
  active: boolean;
}

export const createTcsState = (): TcsState => ({ scale: 1, active: false, integ: 0 });

/** maxDrivenSlip：驅動輪中最大的 κ（倒車時請先取反） */
export function updateTcs(
  p: TcsParams,
  st: TcsState,
  maxDrivenSlip: number,
  handbrake: number,
  dt: number,
): number {
  if (!p.enabled || (p.disableWithHandbrake && handbrake > 0.1)) {
    st.integ = 0;
    st.active = false;
    st.scale = Math.min(1, st.scale + p.recoverRate * dt);
    return st.scale;
  }

  const e = (maxDrivenSlip - p.peakSlipRatio * p.targetRatio) / p.peakSlipRatio;
  if (!st.active && maxDrivenSlip > p.peakSlipRatio * p.engageRatio) st.active = true;

  let cmd = 1;
  if (st.active) {
    const u = updatePI(st, e, p.kp, p.ki, 1 / p.ki, dt);
    cmd = clamp(1 - Math.max(0, u), 0, 1);
    if (st.integ === 0 && e < 0) st.active = false;
  }

  st.scale = cmd < st.scale ? cmd : Math.min(cmd, st.scale + p.recoverRate * dt);
  return st.scale;
}
