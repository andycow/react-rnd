import { writeFileSync } from "node:fs";
/** Opt-in measurement suite. Driver/fixtures and thresholds mirror the existing
 * phase5, spatial slalom and wheel tests; no vehicle settings are changed. */
import { afterEach, describe, expect, it } from "vitest";
import { RapierAdapter } from "../src/physics/RapierAdapter";
import {
  Vehicle,
  neutralInput,
  type VehicleInput,
  type VehicleState,
} from "../src/vehicle/Vehicle";
import { defaultPreset } from "../src/vehicle/preset";
import {
  contactPointVelocity,
  dot,
  identity,
  length,
  rotateVector,
  sub,
  transformPoint,
} from "../src/core/math";
import type { AssistPresetId } from "../src/vehicle/assists/presets";
import { CONES, GROUND, TRACK } from "../src/render/trackGeometry";

const selection =
  (
    globalThis as typeof globalThis & {
      process?: { env: Record<string, string | undefined> };
    }
  ).process?.env.REPORT_CASES ?? "";
const selected = (name: string) =>
  selection === "all" ||
  selection === "1" ||
  selection.split(",").includes(name);
function report(
  name: string,
  hz: number,
  metrics: Record<string, unknown>,
  checks: [string, boolean][],
) {
  const passed = checks.every(([, ok]) => ok);
  console.info(
    "HANDLING_METRIC:" +
      JSON.stringify({
        name,
        hz,
        metrics,
        criteria: checks.map(([description]) => description).join("; "),
        passed,
      }),
  );
  expect(
    checks.filter(([, ok]) => !ok).map(([description]) => description),
    name + " failed criteria",
  ).toEqual([]);
}
const adapters: RapierAdapter[] = [];
afterEach(() => adapters.splice(0).forEach((a) => a.dispose()));
const clamp = (x: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, x));
async function setup(hz: number) {
  const physics = await RapierAdapter.create();
  adapters.push(physics);
  physics.createStaticBox({
    halfExtents: { x: 10000, y: 0.5, z: 50000 },
    pose: { position: { x: 0, y: -0.5, z: 0 }, rotation: identity() },
    surface: { surfaceGrip: 1, surfaceType: "asphalt" },
  });
  const vehicle = new Vehicle(physics);
  const tick = (input: VehicleInput = neutralInput) => {
    vehicle.step(1 / hz, input);
    physics.step(1 / hz);
    return vehicle.getState();
  };
  for (let i = 0; i < 3 * hz; i++) tick({ ...neutralInput, handbrake: 1 });
  return { vehicle, tick };
}
function slip(s: VehicleState) {
  const forward = rotateVector({ x: 0, y: 0, z: -1 }, s.pose.rotation),
    right = rotateVector({ x: 1, y: 0, z: 0 }, s.pose.rotation);
  const rearPoint = transformPoint(
    {
      x: 0,
      y: -defaultPreset.geometry.targetStaticCoMHeight,
      z: defaultPreset.geometry.rearAxleDistance,
    },
    s.pose,
  );
  const rearV = contactPointVelocity(
    s.linearVelocity,
    s.angularVelocity,
    rearPoint,
    s.pose.position,
  );
  return {
    beta: Math.atan2(
      dot(s.linearVelocity, right),
      Math.max(Math.abs(dot(s.linearVelocity, forward)), 1),
    ),
    rear: Math.atan2(
      dot(rearV, right),
      Math.max(Math.abs(dot(rearV, forward)), 1),
    ),
    yaw: -s.angularVelocity.y,
  };
}
async function cruise(hz: number, profile: AssistPresetId, gear = 3, kmh = 60) {
  const fixture = await setup(hz);
  const { vehicle, tick } = fixture;
  // Identical physical preparation: reach 60 km/h under the same normal profile and selected gear.
  // The selected profile is applied only afterwards; Forza resumes automatic shifting, Sim stays manual.
  vehicle.setAutomatic(false);
  let integral = 0;
  for (let i = 0; i < 20 * hz; i++) {
    const s = vehicle.getState(),
      forward = rotateVector({ x: 0, y: 0, z: -1 }, s.pose.rotation),
      error = kmh / 3.6 - dot(s.linearVelocity, forward);
    integral = clamp(integral + (0.12 * error) / hz, -0.2, 0.8);
    tick({
      ...neutralInput,
      throttle: clamp(0.18 + 0.35 * error + integral, 0, 1),
      brake: clamp(-0.15 * error - 0.05, 0, 0.5),
      shiftUp: s.gear < gear && i % hz === 0,
    });
  }
  vehicle.setAssistPreset(profile);
  return fixture;
}


const D = (x: number) => (x * 180 / Math.PI).toFixed(1);
const OUT = (globalThis as any).process.env.PROBE_OUT as string;
type Drive = (t: number) => Partial<VehicleInput>;
async function run(kmh: number, gear: number, dur: number, drive: Drive, hz = 120) {
  const { tick } = await cruise(hz, "forza_normal", gear, kmh);
  const tr: { t: number; beta: number; rear: number; yaw: number; v: number; heading: number; x: number; z: number }[] = [];
  let heading = 0;
  for (let i = 0; i < Math.round(dur * hz); i++) {
    const t = i / hz;
    const s = tick({ ...neutralInput, ...drive(t) });
    const b = slip(s);
    heading += b.yaw / hz;
    tr.push({ t, beta: b.beta, rear: b.rear, yaw: b.yaw, v: Math.hypot(s.linearVelocity.x, s.linearVelocity.z) * 3.6, heading, x: s.pose.position.x, z: s.pose.position.z });
  }
  return tr;
}
const settle = (tr: any[], from: number, lim = 6 * Math.PI / 180) => {
  let last = -1;
  for (const p of tr) if (p.t >= from && (Math.abs(p.rear) > lim || Math.abs(p.beta) > lim)) last = p.t;
  return last < 0 ? 0 : last - from;
};
const maxAbs = (tr: any[], k: string, from = 0, to = 1e9) => Math.max(...tr.filter(p => p.t >= from && p.t < to).map(p => Math.abs(p[k])));
describe("probe", () => {
  it("independent probes", async () => {
    const rows: string[] = [];
    const write = () => writeFileSync(OUT, rows.join("\n"));
    // A: release with steer 0, throttle .2 (original probe)
    for (const [kmh, gear] of [[60, 3], [80, 4], [100, 4]] as const)
      for (const hold of [0.2, 0.5, 1.0])
        for (const steer of [0.35, 0.6]) {
          const rel = 0.6 + hold;
          const tr = await run(kmh, gear, rel + 3, t => ({ throttle: t < rel ? 0.35 : 0.2, steer: t < rel ? steer : 0, handbrake: t >= 0.6 && t < rel ? 1 : 0 }));
          rows.push(`A ${kmh}km/h hold=${hold} steer=${steer}: peakBeta ${D(maxAbs(tr, "beta"))} settle ${settle(tr, rel).toFixed(2)}s heading ${D(tr.at(-1)!.heading)} vEnd ${tr.at(-1)!.v.toFixed(0)}`);
          write();
        }
    // B: hairpin handbrake rotation
    for (const [bk, bg] of [[40, 2], [60, 3], [80, 4]] as const) for (const hold of [0, 0.4, 0.8, 1.2]) {
      const tr = await run(bk, bg, 3, t => ({ throttle: 0.3, steer: t < 2 ? 1 : 0.3, handbrake: t < hold ? 1 : 0 }));
      const h1 = tr.find(p => p.t >= 1.5)!.heading;
      rows.push(`B hairpin ${bk}km/h hold=${hold}: heading@1.5s ${D(h1)} heading@3s ${D(tr.at(-1)!.heading)} peakBeta ${D(maxAbs(tr, "beta"))} vEnd ${tr.at(-1)!.v.toFixed(0)}`);
      write();
    }
    // F: handbrake then keep steering into the turn (intent kept), throttle variants
    for (const [fk, fg] of [[60, 3], [80, 4], [100, 4]] as const) for (const thr of [0.3, 0.8]) {
      const tr = await run(fk, fg, 4, t => ({ throttle: thr, steer: t < 3 ? 1 : 0, handbrake: t >= 0.3 && t < 1.0 ? 1 : 0 }));
      rows.push(`F keep-steer ${fk}km/h thr=${thr}: peakBeta ${D(maxAbs(tr, "beta"))} heading@3s ${D(tr.find(p => p.t >= 3)!.heading)} settleAfterCenter ${settle(tr, 3).toFixed(2)}s vEnd ${tr.at(-1)!.v.toFixed(0)}`);
      write();
    }
    // C: lane change 100 km/h
    for (const a of [0.3, 0.5, 0.8]) {
      const tr = await run(100, 4, 4, t => ({ throttle: 0.3, steer: t < 0.35 ? a : t < 0.7 ? -a : 0 }));
      rows.push(`C lanechange 100 a=${a}: peakBeta ${D(maxAbs(tr, "beta"))} peakRear ${D(maxAbs(tr, "rear"))} settle ${settle(tr, 0.7, 2 * Math.PI / 180).toFixed(2)}s(2deg) residualYaw ${maxAbs(tr, "yaw", 2.5).toFixed(3)} heading ${D(tr.at(-1)!.heading)}`);
      write();
    }
    // D: trail braking
    for (const st of [0.3, 0.6]) {
      const tr = await run(80, 4, 4, t => ({ throttle: t < 1 ? 0.3 : 0, brake: t >= 1 ? 1 : 0, steer: st }));
      rows.push(`D trailbrake 80 steer=${st}: peakBeta ${D(maxAbs(tr, "beta", 1))} peakRear ${D(maxAbs(tr, "rear", 1))} heading ${D(tr.at(-1)!.heading)} vEnd ${tr.at(-1)!.v.toFixed(0)}`);
      write();
    }
    // E: lift-off mid corner
    for (const st of [0.4, 0.7]) {
      const tr = await run(80, 4, 3.5, t => ({ throttle: t < 1.5 ? 0.6 : 0, steer: st }));
      rows.push(`E liftoff 80 steer=${st}: peakBeta after lift ${D(maxAbs(tr, "beta", 1.5))} peakRear ${D(maxAbs(tr, "rear", 1.5))} beta before ${D(maxAbs(tr, "beta", 1, 1.5))}`);
      write();
    }
  }, 3600000);
});
