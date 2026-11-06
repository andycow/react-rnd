import { describe, expect, it } from 'vitest';
import { DEG, GRAVITY } from '../src/vehicle/math';
import { combinedForce, createTireState, magicFormulaNormalized, type TireParams } from '../src/vehicle/Tire';
import { stepWheel, type WheelState } from '../src/vehicle/Wheel';
import { stepDrivenAxle, type DiffParams } from '../src/vehicle/Drivetrain';
import { computeHoldForce, createHoldState, lowSpeedLateralDamping, type HoldParams } from '../src/vehicle/Hold';
import { evaluateTire } from '../src/vehicle/Tire';
import { createAbsState, updateAbs, type AbsParams } from '../src/vehicle/assists/abs';
import { createTcsState, updateTcs, type TcsParams } from '../src/vehicle/assists/tcs';
import { createStmState, updateStm, type StmParams } from '../src/vehicle/assists/stm';
import { updateSteeringAssist, type SteeringAssistParams } from '../src/vehicle/assists/steeringAssist';

const tire: TireParams = {
  peakSlipRatio: 0.1,
  cLong: 1.5,
  muLong: 1.1,
  peakSlipAngleRad: 8 * DEG,
  cLat: 1.3,
  muLat: 1.05,
  loadSensitivity: 0.1,
  nominalLoad: 3300,
  relaxLenLat: 0.35,
  relaxLenLong: 0.1,
};
const wheel = { radius: 0.33, inertia: 1.0 };
const absP: AbsParams = {
  enabled: true,
  peakSlipRatio: 0.1,
  engageRatio: 1.15,
  targetRatio: 1.0,
  releaseRatio: 0.5,
  kp: 1.5,
  ki: 20,
  minPressure: 0.05,
  minSpeed: 1.39,
  hudPulseHz: 15,
};
const tcsP: TcsParams = {
  enabled: true,
  peakSlipRatio: 0.1,
  engageRatio: 1.15,
  targetRatio: 1.0,
  kp: 0.25,
  ki: 5,
  recoverRate: 3,
  disableWithHandbrake: true,
};
const holdP: HoldParams = { engageSpeed: 0.3, releaseSpeed: 0.5, frequencyHz: 3, dampingRatio: 1 };

const DT = 1 / 120;
const MASS = 337.5;
const FZ = MASS * GRAVITY;

interface SimOpts {
  v0: number;
  seconds: number;
  drive?: number;
  brake?: number;
  abs?: boolean;
  tcs?: boolean;
  slopeForce?: number;
  hold?: boolean;
}

/** 單輪縱向模擬：車身只有 x 方向自由度 */
function quarterCar(o: SimOpts) {
  const st: WheelState = { omega: o.v0 / wheel.radius, tire: createTireState() };
  const absS = createAbsState();
  const tcsS = createTcsState();
  const holdS = createHoldState();
  let v = o.v0;
  let x = 0;
  let maxSlip = 0;
  let omegaSignFlips = 0;
  let nan = false;
  let stopDist: number | null = null;
  let tcsSlipAfter1s = 0;

  for (let i = 0; i < o.seconds / DT; i++) {
    let brake = o.brake ?? 0;
    let drive = o.drive ?? 0;
    if (o.abs) brake *= updateAbs(absP, absS, st.tire.slipRatio, v, brake > 0 ? 1 : 0, DT).pressureScale;
    if (o.tcs) drive *= updateTcs(tcsP, tcsS, st.tire.slipRatio, 0, DT);

    const prevOmega = st.omega;
    const out = stepWheel(tire, wheel, st, {
      vx: v,
      vy: 0,
      fz: FZ,
      surfaceGrip: 1,
      driveTorque: drive,
      brakeTorque: brake,
      resistTorque: 0.012 * FZ * wheel.radius,
      inertiaEff: wheel.inertia,
      dt: DT,
      substeps: 4,
    });
    if (prevOmega * st.omega < 0) omegaSignFlips++;

    let fHold = 0;
    if (o.hold) {
      fHold = computeHoldForce(holdP, holdS, {
        contactPoint: { x, y: 0, z: 0 },
        contactVelocity: { x: v, y: 0, z: 0 },
        normal: { x: 0, y: 1, z: 0 },
        fz: FZ,
        mu: tire.muLong,
        throttle: 0,
        brake: (o.brake ?? 0) > 0 ? 1 : 0,
      }).x;
    }

    v += ((out.fx + fHold + (o.slopeForce ?? 0)) / MASS) * DT;
    x += v * DT;
    maxSlip = Math.max(maxSlip, out.last.slipRatio);
    if (i * DT > 1 && o.tcs) tcsSlipAfter1s = Math.max(tcsSlipAfter1s, out.last.slipRatio);
    if (!Number.isFinite(v) || !Number.isFinite(st.omega)) nan = true;
    if (stopDist === null && o.v0 > 0 && v <= 0.05) stopDist = x;
  }
  return { v, x, omega: st.omega, maxSlip, omegaSignFlips, nan, stopDist, tcsSlipAfter1s };
}

describe('Magic Formula', () => {
  it('s = 1 時為峰值 1.0', () => {
    expect(magicFormulaNormalized(1, 1.5)).toBeCloseTo(1, 6);
    expect(magicFormulaNormalized(1, 1.3)).toBeCloseTo(1, 6);
  });
  it('s → ∞ 時趨近 sin(Cπ/2)', () => {
    expect(magicFormulaNormalized(1e6, 1.3)).toBeCloseTo(Math.sin((1.3 * Math.PI) / 2), 3);
  });
  it('合成力永遠不超過 μ_eff·Fz', () => {
    for (let k = -1; k <= 1; k += 0.05)
      for (let a = -60; a <= 60; a += 2) {
        const f = combinedForce(tire, k, a * DEG, FZ, 1);
        const mu = Math.max(f.muLongEff, f.muLatEff);
        expect(Math.hypot(f.fx, f.fy)).toBeLessThanOrEqual(mu * FZ + 1e-6);
      }
  });
  it('側向力方向與滑動方向相反', () => {
    expect(combinedForce(tire, 0, 5 * DEG, FZ, 1).fy).toBeLessThan(0);
    expect(combinedForce(tire, 0, -5 * DEG, FZ, 1).fy).toBeGreaterThan(0);
  });
});

describe('車輪積分（四分之一車）', () => {
  it('全力煞車鎖死：ω 停在 0、不跨零震盪、能停下', () => {
    const r = quarterCar({ v0: 27.8, seconds: 6, brake: 2200, hold: true });
    expect(r.nan).toBe(false);
    expect(r.omegaSignFlips).toBe(0);
    expect(Math.abs(r.v)).toBeLessThan(0.05);
  });
  it('ABS 煞車距離比鎖死短', () => {
    const locked = quarterCar({ v0: 27.8, seconds: 6, brake: 2200 });
    const abs = quarterCar({ v0: 27.8, seconds: 6, brake: 2200, abs: true });
    console.log(`100→0 鎖死 ${locked.stopDist?.toFixed(1)} m，ABS ${abs.stopDist?.toFixed(1)} m`);
    expect(abs.stopDist!).toBeLessThan(locked.stopDist!);
    expect(abs.stopDist!).toBeGreaterThan(30);
    expect(abs.stopDist!).toBeLessThan(42);
  });
  it('低速起步大扭力不會 NaN 或發散', () => {
    const r = quarterCar({ v0: 0, seconds: 3, drive: 1500 });
    expect(r.nan).toBe(false);
    expect(r.v).toBeGreaterThan(5);
  });
  it('TCS 把起步滑動率壓在峰值附近，而且加速較好', () => {
    const raw = quarterCar({ v0: 0, seconds: 3, drive: 1500 });
    const tcs = quarterCar({ v0: 0, seconds: 3, drive: 1500, tcs: true });
    console.log(`3 秒末速 無TCS ${raw.v.toFixed(2)} m/s，TCS ${tcs.v.toFixed(2)} m/s；1 秒後最大 κ ${tcs.tcsSlipAfter1s.toFixed(3)}`);
    expect(tcs.tcsSlipAfter1s).toBeLessThan(0.2);
    expect(tcs.v).toBeGreaterThan(raw.v);
  });
  it('平地靜止 5 秒位移 < 1 cm', () => {
    const r = quarterCar({ v0: 0, seconds: 5 });
    expect(Math.abs(r.x)).toBeLessThan(0.01);
  });
  it('15% 坡道踩煞車 5 秒位移 < 2 cm（駐車錨點）', () => {
    const slope = -MASS * GRAVITY * Math.sin(Math.atan(0.15));
    const noHold = quarterCar({ v0: 0, seconds: 5, brake: 2200, slopeForce: slope });
    const hold = quarterCar({ v0: 0, seconds: 5, brake: 2200, slopeForce: slope, hold: true });
    console.log(`坡道位移 無錨點 ${(noHold.x * 100).toFixed(2)} cm，有錨點 ${(hold.x * 100).toFixed(2)} cm`);
    expect(Math.abs(hold.x)).toBeLessThan(0.02);
  });
  it('停車後的側向晃動：加上低速橫向阻尼後 2 秒內收斂', () => {
    for (const damp of [false, true]) {
      const st = createTireState();
      let vy = 0.2;
      let maxLate = 0;
      for (let i = 0; i < 360; i++) {
        const o = evaluateTire(tire, st, { vx: 0, vy, omega: 0, radius: 0.33, fz: FZ, surfaceGrip: 1, dt: DT }, true);
        const fd = damp
          ? lowSpeedLateralDamping({ fadeStart: 1, fadeEnd: 3, frequencyHz: 6, dampingRatio: 0.7 }, 0, vy, FZ, 1.05)
          : 0;
        vy += ((o.fy + fd) / MASS) * DT;
        if (i > 240) maxLate = Math.max(maxLate, Math.abs(vy));
      }
      console.log(`停車側向晃動 第 2–3 秒最大 |vy|：${damp ? '有阻尼' : '無阻尼'} ${maxLate.toExponential(2)} m/s`);
      if (damp) expect(maxLate).toBeLessThan(0.001);
    }
  });
  it('120 Hz 隨機輸入 10,000 步不會 NaN', () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const st: WheelState = { omega: 0, tire: createTireState() };
    let v = 0;
    for (let i = 0; i < 10000; i++) {
      const out = stepWheel(tire, wheel, st, {
        vx: v,
        vy: (rnd() - 0.5) * 10,
        fz: FZ * rnd() * 2,
        surfaceGrip: 0.5 + rnd() * 0.5,
        driveTorque: (rnd() - 0.3) * 3000,
        brakeTorque: rnd() < 0.3 ? rnd() * 3000 : 0,
        resistTorque: 10,
        inertiaEff: 1,
        dt: DT,
        substeps: 4,
      });
      v += (out.fx / MASS) * DT;
      expect(Number.isFinite(out.fx) && Number.isFinite(out.fy) && Number.isFinite(st.omega)).toBe(true);
    }
  });
});

describe('差速器（左右抓地不同：左 0.3 / 右 1.0）', () => {
  function splitMu(diff: DiffParams, seconds = 3) {
    const states: [WheelState, WheelState] = [
      { omega: 0, tire: createTireState() },
      { omega: 0, tire: createTireState() },
    ];
    let v = 0;
    let flips = 0;
    let prevD = 0;
    let maxLateDelta = 0;
    for (let i = 0; i < seconds / DT; i++) {
      const common = { vy: 0, fz: FZ, brakeTorque: 0, resistTorque: 10, inertiaEff: 8 };
      const [l, r] = stepDrivenAxle(
        tire,
        wheel,
        states,
        [
          { ...common, vx: v, surfaceGrip: 0.3 },
          { ...common, vx: v, surfaceGrip: 1.0 },
        ],
        diff,
        1600,
        DT,
        4,
      );
      v += ((l.fx + r.fx) / (2 * MASS)) * DT;
      const d = states[0].omega - states[1].omega;
      if (i > 1 / DT && Math.abs(d) > 1e-6 && Math.abs(prevD) > 1e-6 && d * prevD < 0) flips++;
      if (i > 2 / DT) maxLateDelta = Math.max(maxLateDelta, Math.abs(d));
      prevD = d;
      expect(Number.isFinite(v) && Number.isFinite(d)).toBe(true);
    }
    return { v, flips, maxLateDelta };
  }
  it('LSD 把打滑輪的轉速差壓下來且不抖；locked 兩輪幾乎同速', () => {
    // 這裡沒有引擎模型（固定輸入扭力），所以只比較左右轉速差，不比較加速
    const open = splitMu({ type: 'open', preload: 0, lockCoef: 0 });
    const lsd = splitMu({ type: 'lsd', preload: 50, lockCoef: 0.25 });
    const locked = splitMu({ type: 'locked', preload: 0, lockCoef: 0 });
    console.log(
      `第 2–3 秒最大左右轉速差 open ${open.maxLateDelta.toFixed(1)} / lsd ${lsd.maxLateDelta.toFixed(1)} / ` +
        `locked ${locked.maxLateDelta.toExponential(2)} rad/s；LSD 轉速差翻轉次數 ${lsd.flips}`,
    );
    expect(lsd.maxLateDelta).toBeLessThan(open.maxLateDelta);
    expect(locked.maxLateDelta).toBeLessThan(0.5);
    expect(lsd.flips).toBe(0);
    expect(locked.flips).toBeLessThan(5);
  });
});

describe('轉向輔助', () => {
  const p: SteeringAssistParams = {
    enabled: true,
    strength: 1,
    peakSlipAngleRad: 8 * DEG,
    targetRatio: 1.05,
    fadeStart: 5,
    fadeEnd: 10,
    countersteerEnabled: true,
    countersteerGain: 0.6,
    countersteerThresholdRad: 9 * DEG,
    countersteerMaxRad: 15 * DEG,
    maxWheelAngleRad: 33 * DEG,
  };
  it('高速打滿右轉時，輪角被限制在最佳滑動角窗口', () => {
    const out = updateSteeringAssist(p, {
      playerAngle: 20 * DEG,
      frontAxle: { lateral: 0, forward: 25 },
      rearAxle: { lateral: 0, forward: 25 },
    });
    expect(out.limited).toBe(true);
    expect(out.angle).toBeCloseTo(8.4 * DEG, 4);
  });
  it('低速不限制', () => {
    const out = updateSteeringAssist(p, {
      playerAngle: 30 * DEG,
      frontAxle: { lateral: 0, forward: 3 },
      rearAxle: { lateral: 0, forward: 3 },
    });
    expect(out.angle).toBeCloseTo(30 * DEG, 6);
  });
  it('窗口只限制幅度，不會把輪子轉到玩家沒打的那一側', () => {
    const out = updateSteeringAssist({ ...p, countersteerEnabled: false }, {
      playerAngle: 10 * DEG,
      frontAxle: { lateral: -8, forward: 20 },
      rearAxle: { lateral: 0, forward: 20 },
    });
    expect(out.angle).toBeGreaterThanOrEqual(0);
  });
  it('右彎甩尾（後軸往左滑）時自動往左反打', () => {
    const out = updateSteeringAssist(p, {
      playerAngle: 0,
      frontAxle: { lateral: 0, forward: 20 },
      rearAxle: { lateral: -6, forward: 20 },
    });
    expect(out.countersteer).toBeLessThan(0);
    expect(out.angle).toBeLessThan(0);
  });
});

describe('STM', () => {
  const p: StmParams = {
    enabled: true,
    minSpeed: 4.17,
    wheelbase: 2.65,
    kUs: 0.0025,
    muEstimate: 1.05,
    limitRatio: 1.0,
    deadband: 0.08,
    kp: 2500,
    ki: 4000,
    maxFrontBrake: 800,
    maxRearBrake: 400,
    throttleCutGain: 2,
    minThrottleScale: 0.2,
    filterTau: 0.05,
  };
  it('右轉過度轉向 → 煞左前、降油門', () => {
    const st = createStmState();
    let out = updateStm(p, st, { forwardSpeed: 20, driverSteerAngle: 3 * DEG, yawRateRight: 0.9, dt: DT });
    for (let i = 0; i < 30; i++)
      out = updateStm(p, st, { forwardSpeed: 20, driverSteerAngle: 3 * DEG, yawRateRight: 0.9, dt: DT });
    expect(out.mode).toBe('oversteer');
    expect(out.brakeTorque[0]).toBeGreaterThan(100);
    expect(out.brakeTorque[1]).toBeCloseTo(0, 3);
    expect(out.throttleScale).toBeLessThan(0.9);
  });
  it('極限定圓（1.0 g）時 yaw 多出 10% 的正常波動不會觸發', () => {
    const v = 22.15;
    const r = (GRAVITY * 1.0 * 1.1) / v;
    for (const [ratio, expectMode] of [
      [1.0, 'none'],
      [0.85, 'oversteer'],
    ] as const) {
      const st = createStmState();
      const out = updateStm({ ...p, limitRatio: ratio }, st, { forwardSpeed: v, driverSteerAngle: 12 * DEG, yawRateRight: r, dt: DT });
      console.log(`STM limitRatio ${ratio}：${out.mode}`);
      expect(out.mode).toBe(expectMode);
    }
  });
  it('右轉轉向不足 → 輕煞右後', () => {
    const st = createStmState();
    let out = updateStm(p, st, { forwardSpeed: 15, driverSteerAngle: 8 * DEG, yawRateRight: 0.1, dt: DT });
    for (let i = 0; i < 30; i++)
      out = updateStm(p, st, { forwardSpeed: 15, driverSteerAngle: 8 * DEG, yawRateRight: 0.1, dt: DT });
    expect(out.mode).toBe('understeer');
    expect(out.brakeTorque[3]).toBeGreaterThan(50);
    expect(out.brakeTorque[3]).toBeLessThanOrEqual(400);
  });
});
