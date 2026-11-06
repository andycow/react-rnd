import type { TireParams } from './Tire';
import {
  substepWheel,
  type WheelParams,
  type WheelState,
  type WheelSubstepInput,
  type WheelStepOutput,
} from './Wheel';

/**
 * 差速器。
 *
 * 不可寫成「固定扭力 × sign(ω_l − ω_r)」：兩輪轉速接近時正負號每一步翻轉，會高頻抖動。
 * 也不可用顯式強阻尼耦合 locked：阻尼一大就發散。
 *
 * 做法：先算出「讓兩輪在這個子步進內剛好同速」所需的轉移扭力 T_eq，
 * 實際轉移量 = min(容量, T_eq)。這樣差速器永遠不會讓轉速差反向（不會過衝），也就不會抖。
 *   T_eq = |Δω| · I_eq / h，I_eq = I_l·I_r / (I_l + I_r)
 *   容量：open = 0、lsd = preload + lockCoef·|T_in|、locked = ∞
 * 轉移方向：從轉得快的一側移到慢的一側。
 */
export type DiffType = 'open' | 'lsd' | 'locked';

export interface DiffParams {
  type: DiffType;
  preload: number; // N·m，例 50
  lockCoef: number; // 例 0.25
}

/** 回傳 [左輪驅動扭力, 右輪驅動扭力] */
export function splitDiffTorque(
  p: DiffParams,
  torqueIn: number,
  omegaL: number,
  omegaR: number,
  inertiaL: number,
  inertiaR: number,
  h: number,
): [number, number] {
  const half = torqueIn / 2;
  if (p.type === 'open') return [half, half];

  const dOmega = omegaL - omegaR;
  const iEq = (inertiaL * inertiaR) / (inertiaL + inertiaR);
  const tEq = (Math.abs(dOmega) * iEq) / h;
  const capacity = p.type === 'locked' ? Infinity : p.preload + p.lockCoef * Math.abs(torqueIn);
  const transfer = Math.min(capacity, tEq) * Math.sign(dOmega);
  return [half - transfer, half + transfer];
}

export interface AxleWheelInput extends Omit<WheelSubstepInput, 'driveTorque' | 'h'> {}

/**
 * 驅動軸：每個子步進先分配差速器扭力，再推進兩輪。
 * AWD 時前後軸各呼叫一次（中央差速器先把引擎扭力依比例分給前後軸）。
 */
export function stepDrivenAxle(
  tp: TireParams,
  wp: WheelParams,
  states: [WheelState, WheelState],
  inputs: [AxleWheelInput, AxleWheelInput],
  diff: DiffParams,
  axleTorque: number,
  dt: number,
  substeps: number,
): [WheelStepOutput, WheelStepOutput] {
  const h = dt / substeps;
  const sums = [
    { fx: 0, fy: 0 },
    { fx: 0, fy: 0 },
  ];
  const outs: [WheelStepOutput | undefined, WheelStepOutput | undefined] = [undefined, undefined];

  for (let i = 0; i < substeps; i++) {
    const [tL, tR] = splitDiffTorque(
      diff,
      axleTorque,
      states[0].omega,
      states[1].omega,
      inputs[0].inertiaEff,
      inputs[1].inertiaEff,
      h,
    );
    const torques = [tL, tR];
    for (let w = 0; w < 2; w++) {
      const o = substepWheel(tp, wp, states[w]!, { ...inputs[w]!, driveTorque: torques[w]!, h });
      sums[w]!.fx += o.tire.fx;
      sums[w]!.fy += o.tire.fy;
      outs[w] = { fx: 0, fy: 0, last: o.tire, locked: o.locked };
    }
  }

  return [0, 1].map((w) => ({
    ...outs[w]!,
    fx: sums[w]!.fx / substeps,
    fy: sums[w]!.fy / substeps,
  })) as [WheelStepOutput, WheelStepOutput];
}
