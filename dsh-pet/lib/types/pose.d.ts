/**
 * 桌面端「实况」（位置 + 朝向）的内存快照。
 *
 * 负责收窄渲染端上报，并按宠物存一份最近的位置供外部读取：桌面端一窗一只，位置全局只有一份。
 * 上报是变化时推 + 节流，不是轮询；宿主只存内存，不写 /state。
 * 不负责网页端：网页宠物的位置天生每页一份，走页面内的只读服务 petApi7340。
 * 依赖无（纯内存态，宿主重启即空），字段名与坐标口径与网页端一致。
 * 始终成立：快照没有 TTL，updatedAt 是调用方判断这份实况有多新的唯一依据。
 * 契约见 API.md 与 openapi.yaml。
 *
 * @module dsh-pet/src/host/pose
 */
/** 朝向（与 POST /anim 的 facing、shared/state.ts 的 PetFacing 同词）。 */
export type PoseFacing = 'left' | 'right';
/** 一份实况快照（GET /pose 的响应体即它的浅拷贝 + ok / petId）。 */
export interface PoseSnapshot {
    /** 宠物中心的归一化横坐标（与 POST /position 同口径，贴边时可能略出界）。 */
    x: number;
    /** 宠物中心的归一化纵坐标，口径同 x。 */
    y: number;
    /** 朝向。 */
    facing: PoseFacing;
    /** 渲染端上报的时刻（epoch 毫秒），调用方据此判断这份实况有多新。 */
    updatedAt: number;
}
/** 可写入快照的三元组（收窄之后）。 */
export type PoseInput = {
    x: number;
    y: number;
    facing: PoseFacing;
};
/**
 * 收窄渲染端上报的 { x, y, facing }。
 *
 * 与 /position 的越界夹取不同，这里不做范围夹取：宠物被拖到屏幕边缘时中心点本来就可能略微出界，
 * 夹取会让读回来的值对不上眼睛；但非有限数字（NaN / Infinity）一律拒，那种值喂回去只会把渲染端
 * 的位置算坏。
 */
export declare function normalizePoseInput(raw: unknown): {
    ok: true;
    pose: PoseInput;
} | {
    ok: false;
    reason: 'bad-request';
    message: string;
};
/** 实况快照表（一个插件实例一个；进程内内存态，宿主重启即空）。 */
export declare class PoseStore {
    /** petId → 最近一次实况。 */
    private readonly byPet;
    /** 取当前时刻（可注入：单测不用真等时间）。 */
    private readonly now;
    constructor(opts?: {
        now?: () => number;
    });
    /** 覆盖一只宠物的实况，返回落定的快照。 */
    set(petId: string, pose: PoseInput): PoseSnapshot;
    /** 读最近一次实况；从没上报过返回 undefined（路由回 pose-unavailable）。 */
    get(petId: string): PoseSnapshot | undefined;
    /** 当前快照数（测试 / 观测用）。 */
    count(): number;
}
