/**
 * 独立模式下的自动碎碎念调度（host 半侧，纯逻辑）。
 *
 * 负责把「独立模式的全局授权」与「宠物自身的开关」合成一个调度结论。
 * 不负责计时与生成：周期定时器与模型调用都在宿主半侧的其他模块。
 * 依赖由调用方注入的策略对象，不读配置、不碰 HTTP，可完全离线单测。
 * 始终成立：没有策略对象（DSH 宿主模式）时，必须逐字退回宠物配置原有的行为。
 *
 * @module dsh-pet/src/host/whisper-policy
 */

export interface StandaloneWhisperPolicy {
  /** 独立模式服务是否已就绪。 */
  isReady(): boolean;
  /** 调用方是否已明确授权自动碎碎念。 */
  canWhisper(): boolean;
  /** 自动碎碎念的间隔（秒）。 */
  whisperIntervalSec(): number;
}

/**
 * 自动碎碎念的调度结论：是否启用 + 实际周期。
 *
 * 独立模式另需全局明确授权；DSH 宿主模式下只看宠物配置自身的开关与周期。
 */
export function automaticWhisperSchedule(
  policy: StandaloneWhisperPolicy | undefined,
  petEnabled: boolean,
  configuredPeriodSec: number,
): { enabled: boolean; periodSec: number } {
  if (!policy) return { enabled: petEnabled, periodSec: configuredPeriodSec };
  const period = policy.whisperIntervalSec();
  // 周期下限 60s：策略给出过密的值会把模型调用打成刷屏；非有限值退回 300s。
  return {
    enabled: petEnabled && policy.isReady() && policy.canWhisper(),
    periodSec: Number.isFinite(period) ? Math.max(60, period) : 300,
  };
}
