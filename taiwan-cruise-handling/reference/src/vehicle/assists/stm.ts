import { clamp, GRAVITY, sign } from '../math';
import { lowPass, updatePI, type PIState } from './PI';

/**
 * STM（穩定控制），以 yaw rate 為控制量。
 *
 * 符號：steerAngle > 0 = 向右；yawRateRight > 0 = 車頭往右轉。
 * （Y-up 右手座標下 ω_y > 0 是往左轉，所以 yawRateRight = −ω_y）
 *
 * 輪序：0 = FL, 1 = FR, 2 = RL, 3 = RR
 */
export interface StmParams {
  enabled: boolean;
  minSpeed: number; // m/s，例 15 km/h = 4.17
  wheelbase: number;
  kUs: number; // 不足轉向梯度，例 0.0025
  muEstimate: number; // 例 1.05
  limitRatio: number; // 例 1.0；0.85 時極限過彎的正常 yaw 波動（約 10%）就會觸發
  deadband: number; // rad/s，例 0.08
  kp: number; // N·m / (rad/s)，例 2500
  ki: number; // 例 4000
  maxFrontBrake: number; // 例 800
  maxRearBrake: number; // 例 400
  throttleCutGain: number; // 例 2.0
  minThrottleScale: number; // 例 0.2
  filterTau: number; // s，例 0.05
}

export interface StmState {
  over: PIState;
  under: PIState;
  brake: [number, number, number, number];
  throttleScale: number;
  mode: 'none' | 'oversteer' | 'understeer';
}

export const createStmState = (): StmState => ({
  over: { integ: 0 },
  under: { integ: 0 },
  brake: [0, 0, 0, 0],
  throttleScale: 1,
  mode: 'none',
});

export interface StmInput {
  forwardSpeed: number;
  /**
   * 駕駛意圖的輪角：Steering.ts 的機構輸出，也就是 steeringAssist「之前」的值。
   * 不可用含自動反打的實際輪角，否則甩尾回正時，反打角會讓 r_target 指向另一側，
   * STM 誤判成轉向不足，煞錯邊的後輪，把車甩到另一側。
   */
  driverSteerAngle: number;
  yawRateRight: number;
  dt: number;
}

export interface StmOutput {
  brakeTorque: [number, number, number, number];
  throttleScale: number;
  yawRateTarget: number;
  mode: StmState['mode'];
}

export function yawRateTarget(p: StmParams, v: number, steerAngle: number): number {
  const r = (v * steerAngle) / (p.wheelbase + p.kUs * v * v);
  const limit = (p.limitRatio * p.muEstimate * GRAVITY) / Math.max(v, 1);
  return clamp(r, -limit, limit);
}

export function updateStm(p: StmParams, st: StmState, inp: StmInput): StmOutput {
  const v = inp.forwardSpeed;
  const target = [0, 0, 0, 0] as [number, number, number, number];
  let throttleTarget = 1;
  let rT = 0;
  st.mode = 'none';

  if (p.enabled && v >= p.minSpeed) {
    rT = yawRateTarget(p, v, inp.driverSteerAngle);
    const r = inp.yawRateRight;
    const opposite = sign(r) !== 0 && sign(rT) !== 0 && sign(r) !== sign(rT);
    const overErr = opposite ? Math.abs(r) + Math.abs(rT) : Math.abs(r) - Math.abs(rT);
    const underErr = opposite ? 0 : Math.abs(rT) - Math.abs(r);

    if (Math.abs(r) > p.deadband && overErr > p.deadband) {
      // 過度轉向：煞「前外側輪」產生反向 yaw。往右轉（r > 0）時外側是左前
      st.mode = 'oversteer';
      st.under.integ = 0;
      const e = overErr - p.deadband;
      const tq = clamp(updatePI(st.over, e, p.kp, p.ki, p.maxFrontBrake / p.ki, inp.dt), 0, p.maxFrontBrake);
      target[r > 0 ? 0 : 1] = tq;
      throttleTarget = 1 - p.throttleCutGain * e;
    } else if (underErr > p.deadband) {
      // 轉向不足：輕煞「後內側輪」幫助車頭轉進去。想往右轉（rT > 0）時內側是右後
      st.mode = 'understeer';
      st.over.integ = 0;
      const e = underErr - p.deadband;
      const tq = clamp(updatePI(st.under, e, p.kp, p.ki, p.maxRearBrake / p.ki, inp.dt), 0, p.maxRearBrake);
      target[rT > 0 ? 3 : 2] = tq;
      throttleTarget = 1 - 0.5 * p.throttleCutGain * e;
    } else {
      st.over.integ = 0;
      st.under.integ = 0;
    }
  } else {
    st.over.integ = 0;
    st.under.integ = 0;
  }

  for (let i = 0; i < 4; i++) st.brake[i] = lowPass(st.brake[i]!, target[i]!, p.filterTau, inp.dt);
  st.throttleScale = lowPass(
    st.throttleScale,
    clamp(throttleTarget, p.minThrottleScale, 1),
    p.filterTau,
    inp.dt,
  );

  return {
    brakeTorque: [...st.brake] as [number, number, number, number],
    throttleScale: st.throttleScale,
    yawRateTarget: rT,
    mode: st.mode,
  };
}
