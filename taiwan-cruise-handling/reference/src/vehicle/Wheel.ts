import { evaluateTire, type TireOutput, type TireParams, type TireState } from './Tire';

/**
 * 車輪轉動動力學（每個物理步長內做子步進）。
 *
 * I·dω/dt = T_drive − r·Fx(ω) − T_resist
 *
 * 低速時 ∂Fx/∂ω 非常大（V_EPS = 0.5 m/s 時約 1e5 N·s），顯式積分在 480 Hz 下也會發散。
 * 因此用「線性化隱式」：Fx(ω_new) ≈ Fx0 + K·(ω_new − ω0)，K = ∂Fx/∂ω（數值微分，≥ 0）
 *   ⇒ ω_new = ω0 + h·(T_drive − r·Fx0) / (I + h·r·K)
 * 煞車與滾阻屬於「不能讓 ω 變號」的阻力扭力：如果這一步會越過 0，就直接鎖在 0。
 */
export interface WheelParams {
  radius: number;
  inertia: number; // 車輪自身慣量
}

export interface WheelState {
  omega: number;
  tire: TireState;
}

export interface WheelStepInput {
  vx: number; // 子步進期間車身接觸點速度固定不變
  vy: number;
  fz: number;
  surfaceGrip: number;
  driveTorque: number; // 有號，往前為正
  brakeTorque: number; // ≥ 0
  resistTorque: number; // ≥ 0，滾阻等
  inertiaEff: number; // 含引擎、傳動系的等效慣量
  dt: number; // 物理步長
  substeps: number; // 例 4
}

export interface WheelStepOutput {
  fx: number; // 子步進平均，作為衝量施加給車身
  fy: number;
  last: TireOutput;
  locked: boolean;
}

export function stepWheel(
  tp: TireParams,
  wp: WheelParams,
  st: WheelState,
  inp: WheelStepInput,
): WheelStepOutput {
  const h = inp.dt / inp.substeps;
  const r = wp.radius;
  let fxSum = 0;
  let fySum = 0;
  let locked = false;
  let last: TireOutput | undefined;

  for (let i = 0; i < inp.substeps; i++) {
    const base = {
      vx: inp.vx,
      vy: inp.vy,
      omega: st.omega,
      radius: r,
      fz: inp.fz,
      surfaceGrip: inp.surfaceGrip,
      dt: h,
    };
    const f0 = evaluateTire(tp, st.tire, base, false);
    const eps = 1e-3 * Math.max(1, Math.abs(st.omega));
    const f1 = evaluateTire(tp, st.tire, { ...base, omega: st.omega + eps }, false);
    // 峰值後斜率為負，取 0 退化成顯式（該區斜率小，仍然穩定）
    const k = Math.max(0, (f1.fx - f0.fx) / eps);

    const denom = inp.inertiaEff + h * r * k;
    const free = st.omega + (h * (inp.driveTorque - r * f0.fx)) / denom;
    const resist = (h * (inp.brakeTorque + inp.resistTorque)) / denom;

    if (Math.abs(free) <= resist) {
      st.omega = 0;
      locked = inp.brakeTorque > 0;
    } else {
      st.omega = free - Math.sign(free) * resist;
      locked = false;
    }

    last = evaluateTire(tp, st.tire, { ...base, omega: st.omega }, true);
    fxSum += last.fx;
    fySum += last.fy;
  }

  return { fx: fxSum / inp.substeps, fy: fySum / inp.substeps, last: last!, locked };
}
