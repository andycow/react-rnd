import { describe, expect, it } from 'vitest';
import { DEG, GRAVITY } from '../src/vehicle/math';
import { createTireState, type TireParams } from '../src/vehicle/Tire';
import { stepWheel, type WheelState } from '../src/vehicle/Wheel';
import { stepDrivenAxle } from '../src/vehicle/Drivetrain';
import { createTcsState, updateTcs } from '../src/vehicle/assists/tcs';
import { createAbsState, updateAbs } from '../src/vehicle/assists/abs';

/**
 * 整車縱向估算：直線、準靜態前後重量轉移、預設 preset 的引擎/齒比/空力/煞車。
 * 不含懸吊動態、離合器細節與 Rapier，只用來檢查「預設參數和驗收目標是否一致」。
 */
const tire: TireParams = {
  peakSlipRatio: 0.1, cLong: 1.5, muLong: 1.1, peakSlipAngleRad: 8 * DEG, cLat: 1.3, muLat: 1.05,
  loadSensitivity: 0.1, nominalLoad: 3300, relaxLenLat: 0.35, relaxLenLong: 0.1,
};
const wheel = { radius: 0.33, inertia: 1.0 };
const M = 1350, L = 2.65, A = 1.27, B = 1.38, H = 0.5;
const GEARS = [3.4, 2.2, 1.6, 1.25, 1.0, 0.82], FINAL = 3.7, EFF = 0.9;
const CURVE: [number, number][] = [[1000, 200], [2000, 300], [3000, 350], [4000, 350], [5000, 340], [6000, 310], [7000, 260]];
const torqueAt = (rpm: number) => {
  if (rpm <= CURVE[0]![0]) return CURVE[0]![1];
  for (let i = 1; i < CURVE.length; i++) {
    const [r1, t1] = CURVE[i]!, [r0, t0] = CURVE[i - 1]!;
    if (rpm <= r1) return t0 + ((t1 - t0) * (rpm - r0)) / (r1 - r0);
  }
  return CURVE[CURVE.length - 1]![1];
};
const DT = 1 / 120, SUB = 4;
const tcsP = { enabled: true, peakSlipRatio: 0.1, engageRatio: 1.15, targetRatio: 1, kp: 0.25, ki: 5, recoverRate: 3, disableWithHandbrake: true };
const absP = { enabled: true, peakSlipRatio: 0.1, engageRatio: 1.15, targetRatio: 1, releaseRatio: 0.5, kp: 1.5, ki: 20, minPressure: 0.05, minSpeed: 1.39, hudPulseHz: 15 };

function sim(mode: 'accel' | 'brake', seconds: number) {
  const w: WheelState[] = [0, 1, 2, 3].map(() => ({ omega: 0, tire: createTireState() }));
  let v = mode === 'brake' ? 100 / 3.6 : 0;
  w.forEach((s) => (s.omega = v / wheel.radius));
  let x = 0, a = 0, gear = 0, shiftTimer = 0, sinceShift = 1, t = 0;
  let t100: number | null = null, stopDist: number | null = null, vmax = 0;
  const tcs = createTcsState();
  const abs = [0, 1, 2, 3].map(() => createAbsState());

  for (let i = 0; i < seconds / DT; i++, t += DT) {
    const down = 0.5 * 1.225 * 0.3 * v * v;
    const fzF = (M * GRAVITY * B - M * a * H) / L / 2 + (down * 0.45) / 2;
    const fzR = (M * GRAVITY * A + M * a * H) / L / 2 + (down * 0.55) / 2;
    const rr = (fz: number) => 0.012 * fz * wheel.radius;
    let fxTotal = 0;

    if (mode === 'accel') {
      const ratio = GEARS[gear]! * FINAL;
      const wheelRpm = (((w[2]!.omega + w[3]!.omega) / 2) * ratio * 60) / (2 * Math.PI);
      // 起步半離合：引擎維持在 3000 rpm 附近輸出；排檔判斷一律用車輪換算轉速
      const engineRpm = Math.max(wheelRpm, 3000);
      sinceShift += DT;
      if (wheelRpm > 6500 && gear < GEARS.length - 1 && sinceShift > 0.5) {
        gear++; shiftTimer = 0.15; sinceShift = 0;
      }
      shiftTimer = Math.max(0, shiftTimer - DT);
      const maxSlip = Math.max(w[2]!.tire.slipRatio, w[3]!.tire.slipRatio);
      const scale = updateTcs(tcsP, tcs, maxSlip, 0, DT);
      const cut = shiftTimer > 0 || engineRpm > 7000 ? 0 : 1;
      const axleT = torqueAt(engineRpm) * cut * scale * GEARS[gear]! * FINAL * EFF;
      const iEff = wheelRpm >= 1500 ? wheel.inertia + (0.2 * (GEARS[gear]! * FINAL) ** 2) / 2 : wheel.inertia;
      const common = { vy: 0, surfaceGrip: 1, brakeTorque: 0, inertiaEff: iEff };
      const [l, r] = stepDrivenAxle(tire, wheel, [w[2]!, w[3]!],
        [{ ...common, vx: v, fz: fzR, resistTorque: rr(fzR) }, { ...common, vx: v, fz: fzR, resistTorque: rr(fzR) }],
        { type: 'lsd', preload: 50, lockCoef: 0.25 }, axleT, DT, SUB);
      fxTotal += l.fx + r.fx;
      for (const k of [0, 1]) {
        fxTotal += stepWheel(tire, wheel, w[k]!, { vx: v, vy: 0, fz: fzF, surfaceGrip: 1, driveTorque: 0, brakeTorque: 0, resistTorque: rr(fzF), inertiaEff: wheel.inertia, dt: DT, substeps: SUB }).fx;
      }
    } else {
      for (let k = 0; k < 4; k++) {
        const maxT = k < 2 ? 2200 : 900;
        const fz = k < 2 ? fzF : fzR;
        const p = updateAbs(absP, abs[k]!, w[k]!.tire.slipRatio, v, 1, DT).pressureScale;
        fxTotal += stepWheel(tire, wheel, w[k]!, { vx: v, vy: 0, fz, surfaceGrip: 1, driveTorque: 0, brakeTorque: maxT * p, resistTorque: rr(fz), inertiaEff: wheel.inertia, dt: DT, substeps: SUB }).fx;
      }
    }

    const drag = 0.5 * 1.225 * 0.72 * v * Math.abs(v);
    a = (fxTotal - drag) / M;
    v += a * DT;
    x += v * DT;
    vmax = Math.max(vmax, v);
    if (mode === 'accel' && t100 === null && v >= 100 / 3.6) t100 = t;
    if (mode === 'brake' && stopDist === null && v <= 0.1) { stopDist = x; break; }
  }
  return { t100, stopDist, vmaxKmh: vmax * 3.6 };
}

describe('整車縱向估算（預設 preset 與驗收目標是否一致）', () => {
  it('0→100、極速、100→0', () => {
    const acc = sim('accel', 60);
    const brk = sim('brake', 10);
    console.log(`0→100 ${acc.t100?.toFixed(2)} s；60 秒內最高 ${acc.vmaxKmh.toFixed(0)} km/h；100→0 ${brk.stopDist?.toFixed(1)} m`);
    expect(acc.t100!).toBeGreaterThanOrEqual(6.0);
    expect(acc.t100!).toBeLessThanOrEqual(7.5);
    expect(acc.vmaxKmh).toBeGreaterThanOrEqual(230);
    expect(acc.vmaxKmh).toBeLessThanOrEqual(260);
    expect(brk.stopDist!).toBeGreaterThanOrEqual(36);
    expect(brk.stopDist!).toBeLessThanOrEqual(42);
  });
});
