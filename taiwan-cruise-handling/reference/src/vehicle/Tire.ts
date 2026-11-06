import { clamp } from './math';

/**
 * 輪胎模型：簡化 Pacejka（E = 0）+ 正規化合成滑動 + 負載敏感度 + 鬆弛長度。
 *
 * 符號約定（輪胎座標，位於接觸平面）：
 *   vx > 0：沿車輪滾動方向前進
 *   vy > 0：接觸點往車輪右側滑
 *   alpha = atan2(vy, |vx|)，往右滑為正
 *   fx > 0：往前推；fy 與 vy 反向（往右滑 → fy < 0，往左推回）
 */
export interface TireParams {
  peakSlipRatio: number; // 縱向峰值滑動率，例 0.10
  cLong: number; // 縱向形狀係數 C，須在 (1, 2)
  muLong: number;
  peakSlipAngleRad: number; // 側向峰值滑動角，例 8°
  cLat: number; // 側向形狀係數 C，須在 (1, 2)
  muLat: number;
  loadSensitivity: number; // 例 0.10
  nominalLoad: number; // N，例 3300
  relaxLenLat: number; // m，例 0.35
  relaxLenLong: number; // m，例 0.10
}

export const TIRE_CONSTS = {
  V_EPS: 0.5, // 滑動率/滑動角分母下限（m/s）
  V_RELAX_MIN: 1.0, // 鬆弛長度的最低等效速度（m/s）
  LOAD_FACTOR_MIN: 0.3,
  LOAD_FACTOR_MAX: 1.5,
} as const;

export interface TireState {
  slipRatio: number; // 經鬆弛後的 κ
  slipAngle: number; // 經鬆弛後的 α（rad）
}

export const createTireState = (): TireState => ({ slipRatio: 0, slipAngle: 0 });

export interface TireInput {
  vx: number;
  vy: number;
  omega: number; // 車輪角速度 rad/s，往前滾為正
  radius: number;
  fz: number; // 法向負載 N（≥ 0）
  surfaceGrip: number; // 路面倍率，乾 1.0 / 濕 0.7
  dt: number;
}

export interface TireOutput {
  fx: number;
  fy: number;
  slipRatio: number;
  slipAngle: number;
  /** 正規化合成滑動量 s：< 1 抓地區、= 1 峰值、> 1 滑動中 */
  gripUsage: number;
  muLongEff: number;
  muLatEff: number;
}

/**
 * 正規化 Magic Formula：s = 1 時為峰值 1.0，s → ∞ 時趨近 sin(Cπ/2)。
 * 等價於 sin(C·atan(B·x))，其中 B = tan(π/2C) / x_peak、s = x / x_peak。
 */
export function magicFormulaNormalized(s: number, c: number): number {
  const b = Math.tan(Math.PI / (2 * c));
  return Math.sin(c * Math.atan(b * s));
}

export function steadyStateSlip(vx: number, vy: number, omega: number, radius: number) {
  const wr = omega * radius;
  const denom = Math.max(Math.abs(vx), Math.abs(wr), TIRE_CONSTS.V_EPS);
  return {
    slipRatio: (wr - vx) / denom,
    slipAngle: Math.atan2(vy, Math.max(Math.abs(vx), TIRE_CONSTS.V_EPS)),
  };
}

/** 一階鬆弛的解析解係數，dt 再大也不會超過 1，所以不會發散 */
export function relaxFactor(vx: number, relaxLen: number, dt: number): number {
  return 1 - Math.exp((-(Math.abs(vx) + TIRE_CONSTS.V_RELAX_MIN) / relaxLen) * dt);
}

export function loadFactor(p: TireParams, fz: number): number {
  return clamp(
    1 - p.loadSensitivity * (fz / p.nominalLoad - 1),
    TIRE_CONSTS.LOAD_FACTOR_MIN,
    TIRE_CONSTS.LOAD_FACTOR_MAX,
  );
}

/** 只依 κ、α 計算合成力（無狀態），方便單元測試與畫曲線 */
export function combinedForce(
  p: TireParams,
  slipRatio: number,
  slipAngle: number,
  fz: number,
  surfaceGrip: number,
): Omit<TireOutput, 'slipRatio' | 'slipAngle'> {
  if (fz <= 0) return { fx: 0, fy: 0, gripUsage: 0, muLongEff: 0, muLatEff: 0 };

  const lf = loadFactor(p, fz);
  const muLongEff = p.muLong * surfaceGrip * lf;
  const muLatEff = p.muLat * surfaceGrip * lf;

  const sx = slipRatio / p.peakSlipRatio;
  const sy = Math.tan(slipAngle) / Math.tan(p.peakSlipAngleRad);
  const s = Math.hypot(sx, sy);
  if (s < 1e-9) return { fx: 0, fy: 0, gripUsage: 0, muLongEff, muLatEff };

  const fx = muLongEff * fz * magicFormulaNormalized(s, p.cLong) * (sx / s);
  const fy = -muLatEff * fz * magicFormulaNormalized(s, p.cLat) * (sy / s);
  return { fx, fy, gripUsage: s, muLongEff, muLatEff };
}

/**
 * 計算輪胎力。commit = true 時才把鬆弛後的滑動量寫回 state
 * （Wheel 會用 commit = false 做數值微分）。
 */
export function evaluateTire(
  p: TireParams,
  state: TireState,
  inp: TireInput,
  commit: boolean,
): TireOutput {
  const ss = steadyStateSlip(inp.vx, inp.vy, inp.omega, inp.radius);
  const kLong = relaxFactor(inp.vx, p.relaxLenLong, inp.dt);
  const kLat = relaxFactor(inp.vx, p.relaxLenLat, inp.dt);
  const slipRatio = state.slipRatio + (ss.slipRatio - state.slipRatio) * kLong;
  const slipAngle = state.slipAngle + (ss.slipAngle - state.slipAngle) * kLat;

  if (commit) {
    state.slipRatio = slipRatio;
    state.slipAngle = slipAngle;
  }
  return { ...combinedForce(p, slipRatio, slipAngle, inp.fz, inp.surfaceGrip), slipRatio, slipAngle };
}
