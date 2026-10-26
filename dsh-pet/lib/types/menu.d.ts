/**
 * 第三方右键菜单注册表（进程内存态，DSH 重启即清空，不落盘）。
 *
 * 注册方用自己的 owner 注册菜单项，再用同一个 owner 查「我这一项被点了没有、在哪只宠物上点的」；
 * 不负责菜单渲染与点击命中（两端按 target 过滤后自己拼「更多」）。必须始终成立：注册是 owner 级的
 * 整体覆盖，菜单项生命周期与插件一致；点击是闩锁不是队列（连点两次只看到一次）；查询即清空（读取
 * 即消费，没确认也没重投）；一个 owner 只该有一个消费者，两个进程同时查会互抢。
 * 限额见下方常量；契约见 API.md 与 openapi.yaml。
 * @module dsh-pet/src/host/menu
 */
/** 长轮询等待上限（与 /state 同一量级：调用方一次最多挂这么久）。 */
export declare const MENU_WAIT_MAX_MS = 10000;
/** 一条菜单项快照（写进 /state 的 sections.menu，两端据此拼「更多」）。 */
export interface MenuItemSnapshot {
    owner: string;
    label: string;
    /** 这一项该出现在哪个端：两端各自按自己的端过滤（shared/menu 的 readMenuItems） */
    target: MenuTarget;
}
/** 菜单项显示在哪个端。 */
export type MenuTarget = 'web' | 'desktop' | 'both';
/** 注册结果：业务失败按插件口径回 `{ ok:false, reason, message }`（HTTP 200），不是 400。 */
export type MenuRegisterResult = {
    ok: true;
} | {
    ok: false;
    reason: string;
    message: string;
};
/** 第三方菜单项的进程内注册表：注册、清空、点击上报、长轮询查询。 */
export declare class MenuRegistry {
    /** owner → { target, items }；items = label → 触发它的 petId（null = 未触发） */
    private readonly owners;
    /** owner → 挂在该 owner 上的长轮询唤醒回调 */
    private readonly waiters;
    constructor();
    /**
     * 注册（整体覆盖）：`{ owner, labels: string[], target?: 'web' | 'desktop' | 'both' }`。
     *
     * 覆盖粒度是整个 owner：注册方每次用一份完整列表描述「我现在有什么」，不必关心上次注册了什么，
     * 也不会留下已下线的僵尸项。`target` 选填、缺省 `both`（老调用方零改动），与 labels 一起被覆盖。
     */
    register(raw: unknown): MenuRegisterResult;
    /**
     * 清掉一个 owner 的全部菜单项（连它上面未取走的触发标记一起丢）。
     *
     * 幂等：owner 本来就不存在 → `removed: 0`，仍算成功，调用方重试注销时不该看到错误。
     * 挂在该 owner 上的长轮询会被叫醒，醒来后查不到 owner → 路由回 `unknown-owner`。
     */
    clear(rawOwner: unknown): {
        ok: true;
        removed: number;
    } | {
        ok: false;
        reason: string;
        message: string;
    };
    /** 全量快照（写进 state；顺序 = 注册顺序 + 列表顺序，两端渲染顺序与它一致）。 */
    snapshot(): MenuItemSnapshot[];
    /**
     * 渲染端上报一次点击：把该项标成「被 petId 点了」，并叫醒该 owner 上挂着的长轮询。
     *
     * `delivered = false`（项不存在：菜单刚好被覆盖、还没注册）不算错误——渲染端拿的是上一拍
     * /state 快照，这一拍菜单已经变了，属于正常竞态，路由仍回 200。
     */
    click(raw: unknown): {
        ok: true;
        delivered: boolean;
    };
    /**
     * 查询触发：返回 `{ label: petId | null }` 全量映射，返回即清空这些标记。
     *
     * `waitMs > 0` 且当下没有任何触发 → 挂起等待（被点、超时、被覆盖都会唤醒），超时后照常返回
     * 全 null 的映射。owner 不存在 → null（路由回 404，调用方据此知道要重新注册）。
     */
    poll(owner: string, waitMs: number): Promise<Record<string, string | null> | null>;
}
