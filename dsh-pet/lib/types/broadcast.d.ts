/**
 * 气泡两个端点（投喂与清空）的纯决策层：两者写同一个叶子 `pets.<id>.say`，共用同一条落点规则。
 *
 * 负责把外部输入核对成一个明确的写叶子结论；不生成内容——生成是 whisper 的事。
 * 不负责 HTTP：应答与占用门禁都在路由层，本层只回 reason，不抛异常。
 * 依赖成品配置与表情包池（memeDirs 由调用方给，便于测试注入临时目录）。
 * 不限频也不截断：投喂是显式的调用方行为，内容与频率由调用方自己负责。
 * 始终成立：pet 必填且必须真实存在，绝不默认退到列表第一只；两种配图形态最多给一个。
 * 契约见 API.md 与 openapi.yaml。
 *
 * @module dsh-pet/src/host/broadcast
 */
/** pet 参数解析失败的两种分类（三个「pet 必填」端点共用这一对词汇，与 ./anim、./motion-cue 同口径）。 */
export type PetFailure = 'pet-required' | 'unknown-pet';
/** 投喂失败的分类（路由原样透出给调用方）。 */
export type BroadcastFailure = 'bad-request' | PetFailure | 'unknown-image';
/** 决策结论：通过则给出最终要写进 S 的内容，否则给出显式原因。
 *  image 与 url 最多一个（配图两种形态，由字段名区分）；duration / anim 是已解析的生效值。 */
export type BroadcastDecision = {
    ok: true;
    petId: string;
    text: string;
    image?: string;
    url?: string;
    duration: number;
    anim: boolean;
} | {
    ok: false;
    reason: BroadcastFailure;
    message: string;
};
/** 清空气泡的决策结论（只有宠物解析这一步会失败）。 */
export type BubbleClearDecision = {
    ok: true;
    petId: string;
} | {
    ok: false;
    reason: PetFailure;
    message: string;
};
/** 投喂文本规范化：非字符串 / 纯空白 → 空串。
 *  路由与决策层共用这一条规则，免得为了一个必然失败的请求去读配置。 */
export declare function normalizeBroadcastText(text: unknown): string;
/** 气泡时长规范化：缺省 / null → 默认 10s；合法则原样；非法（非数字 / 非有限 / 负数）返回 null。
 *  路由先用它短路，别为一个必然失败的请求去碰磁盘；0 合法，字面意思「不显示」。 */
export declare function normalizeBroadcastDuration(duration: unknown): number | null;
/** 动画联动开关规范化：只有严格 false 才关闭，其余一律按「要联动」。
 *  宽松是有意的：老调用方不会传这个字段，宽松口径保证它们的行为一个字都不变。 */
export declare function normalizeBroadcastAnim(anim: unknown): boolean;
/**
 * 把外部给的 { text, image, url, duration, anim } 与当前配置核对成一个结论。
 *
 * 配图两种形态二选一：image = 池内名称（命中后取池里的规范名），url = 第三方自带地址（不查池）。
 * @param args - 投喂参数：`cfg` 为成品配置；`requested` 是 `?pet=` 原值（空串 → `pet-required`）；
 *   `duration` 与 `anim` 已由路由规范化；`memeDirs` 把素材根映射成表情包目录链（顺序即优先级）。
 */
export declare function decideBroadcast(args: {
    cfg: Record<string, Record<string, unknown>>;
    /** `?pet=` 的原值（必填：空串 → pet-required） */
    requested: string;
    text: unknown;
    image: unknown;
    url: unknown;
    duration: number;
    anim: boolean;
    memeDirs: (entry: string) => string[];
}): BroadcastDecision;
/**
 * 清空气泡的决策：只需要确定「清哪只宠物的」。
 *
 * 占用门禁不在这里：「谁有资格清」由路由层在它之后过一遍锁，没带 lock 时那一步恒放行。
 * 与投喂的区别是没有「气泡不存在」这种失败：当前没气泡也返回 ok（幂等）。
 */
export declare function decideBubbleClear(args: {
    cfg: Record<string, Record<string, unknown>>;
    /** `?pet=` 的原值（必填：空串 → pet-required） */
    requested: string;
}): BubbleClearDecision;
