/**
 * 工作状态联动：档位常量与快照解析。
 * 宿主半侧有自包含的实现（DSH 单文件加载约束，宿主不 import 本目录），负责监听 DSH 会话事件
 * 聚合成快照并写进 /state 的 sections.workStatus；本模块只有档位常量与叶子解析。
 * 气泡文案不在代码里：浏览器半侧直接读配置的 events.workStatusTexts。纯函数无副作用，不依赖 React / DOM。
 * @module dsh-pet/src/shared/work-status
 */
/** 工作状态档位（对应 animations.events.workStatus 数组索引，顺序即档位，勿在中间插入新档）。 */
export declare const WORK_STATUS_STATES: readonly ["thinking", "working", "result", "waiting", "success", "error"];
export type WorkStatusState = (typeof WORK_STATUS_STATES)[number];
/** 档位 → workStatus 数组索引（与 events.workStatus 的顺序严格一致）。 */
export declare const WORK_STATUS_INDEX: Record<WorkStatusState, number>;
/** 工作状态快照（= /state 里 sections.workStatus 的 data，与宿主半侧的同构）。
 *  没有 ts：「变了没有」由叶子的 counter 承担；text 不在此——气泡文案由客户端读配置，宿主不生成。 */
export interface WorkStatusSnapshot {
    state: WorkStatusState | null;
    task: string | null;
}
/** 快照解析：档位不认识 → 归一成 null（空闲）；形状非法 → null，消费端跳过这一拍。 */
export declare function toWorkStatus(raw: unknown): WorkStatusSnapshot | null;
