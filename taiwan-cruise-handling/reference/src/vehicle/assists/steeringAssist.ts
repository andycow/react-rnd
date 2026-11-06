import { clamp, lerp, sign, smoothstep } from '../math';

/**
 * 轉向輔助：最佳滑動角窗口 + 自動反打。
 *
 * 符號：輪角 > 0 = 向右。軸速度用車身 local 分解：
 *   lateral > 0 = 往右移動，forward > 0 = 往前。
 *
 * 前輪滑動角 α ≈ β_f − δ，其中 β_f = atan2(lateral_f, forward)。
 * 讓 |α| ≤ α_target ⇒ δ ∈ [β_f − α_target, β_f + α_target]。
 * 玩家打滿方向盤時，輪角被限制在這個窗口內，所以「打到底剛好在抓地極限」，
 * 推頭時不會越打越推。窗口只限制幅度，不會讓輪子越過中心轉到玩家沒打的那一側。
 */
export interface SteeringAssistParams {
  enabled: boolean;
  strength: number; // 0..1，例 0.7
  peakSlipAngleRad: number;
  targetRatio: number; // 例 1.05
  fadeStart: number; // m/s，例 5
  fadeEnd: number; // m/s，例 10
  countersteerEnabled: boolean;
  countersteerGain: number; // 例 0.6
  countersteerThresholdRad: number; // 例 peakSlipAngle × 1.1 ≈ 9°；低於峰值時正常極限過彎就會介入，感覺像推頭
  countersteerMaxRad: number; // 例 15°
  maxWheelAngleRad: number; // 機構極限，例 33°
}

export interface AxleVelocity {
  lateral: number;
  forward: number;
}

export interface SteeringAssistInput {
  playerAngle: number; // Steering.ts 輸出的輪角（已含速度敏感上限）
  frontAxle: AxleVelocity;
  rearAxle: AxleVelocity;
}

export interface SteeringAssistOutput {
  angle: number;
  limited: boolean;
  countersteer: number;
  rearSlipAngle: number;
}

export function updateSteeringAssist(
  p: SteeringAssistParams,
  inp: SteeringAssistInput,
): SteeringAssistOutput {
  const fwd = inp.frontAxle.forward;
  const passthrough = {
    angle: inp.playerAngle,
    limited: false,
    countersteer: 0,
    rearSlipAngle: 0,
  };
  if (!p.enabled || fwd < 1) return passthrough;

  const fade = smoothstep(p.fadeStart, p.fadeEnd, fwd) * p.strength;

  const betaF = Math.atan2(inp.frontAxle.lateral, Math.max(fwd, 1));
  const alphaT = p.peakSlipAngleRad * p.targetRatio;
  // 窗口只「限制」玩家往某一側打的量，不會主動把輪子轉到另一側；反打交給下面的 countersteer，
  // 否則兩者疊加會反打過頭
  const player = inp.playerAngle;
  const windowed =
    player > 0
      ? Math.min(player, Math.max(betaF + alphaT, 0))
      : player < 0
        ? Math.max(player, Math.min(betaF - alphaT, 0))
        : 0;
  let angle = lerp(inp.playerAngle, windowed, fade);
  const limited = Math.abs(windowed - inp.playerAngle) > 1e-4 && fade > 0;

  // 後軸往左滑（β_r < 0，例如右彎甩尾）⇒ 反打方向是向左（負）
  const betaR = Math.atan2(inp.rearAxle.lateral, Math.max(inp.rearAxle.forward, 1));
  let cs = 0;
  if (p.countersteerEnabled && Math.abs(betaR) > p.countersteerThresholdRad) {
    cs = clamp(
      p.countersteerGain * (betaR - sign(betaR) * p.countersteerThresholdRad),
      -p.countersteerMaxRad,
      p.countersteerMaxRad,
    ) * fade;
    if (sign(angle) === sign(cs) || angle === 0) {
      // 玩家已經在反打：取較大的反打量，不跟玩家打架
      angle = sign(cs) * Math.max(Math.abs(angle), Math.abs(cs));
    } else {
      angle += cs;
    }
  }

  return {
    angle: clamp(angle, -p.maxWheelAngleRad, p.maxWheelAngleRad),
    limited,
    countersteer: cs,
    rearSlipAngle: betaR,
  };
}
