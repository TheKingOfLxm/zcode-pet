/**
 * 碎碎念生成（host 半侧）：用 DSH 的 LLM 统一抽象层（ctx.llm）生成一句话。
 *
 * 负责拼一次极简的「说句话」请求并收集流式正文；不自己拼服务商端点、不碰凭证。
 * 不负责编排与写气泡——周期调度与落盘都由宿主半侧的其他模块负责。
 * 依赖 ctx.llm、agentDefaultModel（与对话同源）与调用方随机抽出的配图。
 * 始终成立：候选模型失败要显式回落并留痕；生成失败返回结构化原因，不伪造文案。
 * 契约见 API.md 与 openapi.yaml。
 *
 * @module dsh-pet/src/host/whisper
 */
import { type ModelRef } from './model-selection';
/** 生成失败原因（与 shared/whisper.ts 的 WhisperState 失败分支同构）。 */
export type WhisperGenerateResult = {
    ok: true;
    text: string;
    image?: string;
} | {
    ok: false;
    reason: 'provider-missing' | 'generate-error';
    message?: string;
};
/**
 * 用指定（或当前对话的）provider/model 生成一句碎碎念。
 * @param ctx - 宿主上下文（注入 agentDefaultModel / llm）。
 * @param system - 人设提示词（whisperPrompt）。
 * @param meme - 配图（开启配图时传入；缺省 = 纯文本碎碎念）。生成成功时原样带回，
 *             客户端据此展示图片（host 不判断模型是否真的贴合）。
 * @param preferred - 条目单独指定的模型（whisperModel）；缺省 / 留空 = 只用当前对话的模型。
 * @returns 生成的文本（+ 配图），或结构化失败（provider 缺失 / 生成错误）。
 */
export declare function generateWhisper(ctx: {
    agentDefaultModel: {
        currentSelection(): {
            provider: string;
            model: string;
        };
    };
    llm?: unknown;
}, system: string, meme?: {
    name: string;
    desc: string;
}, preferred?: ModelRef): Promise<WhisperGenerateResult>;
