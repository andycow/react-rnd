import { add, dot, length, projectOnPlane, scale, sub, type Vec3 } from './math';

/**
 * 低速駐車力（錨點彈簧-阻尼）。
 *
 * 純阻尼無法抵抗持續外力（坡道重力分量），車會以等速慢慢滑。
 * 所以在靜止且踩著煞車時，記錄一個接觸點錨點，用彈簧把接觸點拉回去；
 * 需要的力超過 μ·Fz 時，力限制在 μ·Fz，錨點跟著滑動（等於靜摩擦被突破）。
 */
export interface HoldParams {
  engageSpeed: number; // 例 0.3 m/s
  releaseSpeed: number; // 例 0.5 m/s
  frequencyHz: number; // 例 3
  dampingRatio: number; // 例 1.0
}

export interface HoldState {
  active: boolean;
  anchor: Vec3;
}

/**
 * 低速橫向阻尼：|vx| 很小時，輪胎鬆弛模型等效成一根阻尼很小的側向彈簧（約 6 Hz），
 * 停車後會左右微晃。這個阻尼力在低速補上，速度變高後淡出。
 * 回傳沿 wheelRight 方向的力（N），請與輪胎 F_y 相加。
 */
export interface LateralDampingParams {
  fadeStart: number; // m/s，例 1
  fadeEnd: number; // m/s，例 3
  frequencyHz: number; // 例 6
  dampingRatio: number; // 例 0.7
}

export function lowSpeedLateralDamping(
  p: LateralDampingParams,
  vx: number,
  vy: number,
  fz: number,
  mu: number,
): number {
  if (fz <= 0) return 0;
  const speed = Math.abs(vx);
  if (speed >= p.fadeEnd) return 0;
  const t = speed <= p.fadeStart ? 0 : (speed - p.fadeStart) / (p.fadeEnd - p.fadeStart);
  const weight = 1 - t * t * (3 - 2 * t);
  const mCorner = fz / 9.81;
  const c = 2 * p.dampingRatio * mCorner * 2 * Math.PI * p.frequencyHz;
  const f = -c * vy * weight;
  const maxF = mu * fz;
  return Math.max(-maxF, Math.min(maxF, f));
}

export const createHoldState = (): HoldState => ({ active: false, anchor: { x: 0, y: 0, z: 0 } });

export interface HoldInput {
  contactPoint: Vec3;
  contactVelocity: Vec3;
  normal: Vec3;
  fz: number;
  mu: number; // 有效摩擦係數（已含路面與負載）
  throttle: number;
  brake: number; // 已含手煞車（取 max）
}

/** 回傳要施加在接觸點的世界座標力 */
export function computeHoldForce(p: HoldParams, st: HoldState, inp: HoldInput): Vec3 {
  const zero = { x: 0, y: 0, z: 0 };
  const vPlanar = projectOnPlane(inp.contactVelocity, inp.normal);
  const speed = length(vPlanar);
  const wantsHold = inp.throttle < 0.05 && inp.brake > 0.05 && inp.fz > 0;

  if (!wantsHold || (st.active && speed > p.releaseSpeed)) {
    st.active = false;
    return zero;
  }
  if (!st.active) {
    if (speed > p.engageSpeed) return zero;
    st.active = true;
    st.anchor = { ...inp.contactPoint };
  }

  const mCorner = inp.fz / 9.81;
  const w = 2 * Math.PI * p.frequencyHz;
  const k = mCorner * w * w;
  const c = 2 * p.dampingRatio * mCorner * w;

  const offset = projectOnPlane(sub(inp.contactPoint, st.anchor), inp.normal);
  const force = add(scale(offset, -k), scale(vPlanar, -c));
  const maxForce = inp.mu * inp.fz;
  const mag = Math.sqrt(dot(force, force));

  if (mag > maxForce) {
    // 靜摩擦被突破：力限制在 μ·Fz，錨點跟著接觸點滑動，避免放開/抓住來回切換
    const ratio = maxForce / mag;
    st.anchor = sub(inp.contactPoint, scale(offset, ratio));
    return scale(force, ratio);
  }
  return force;
}
