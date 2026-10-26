/**
 * 轮询状态（host 半侧）：`GET /state` 的唯一数据源，全局段 + 每宠物叶子 + 长轮询等待者都在这里。
 *
 * 不负责渲染侧比对：拉取、拍平、按 counter 决定是否渲染在 src/shared/state.ts。
 * 不 import src/shared（DSH 单文件加载约束），状态形状因此与共享层各写一份。
 * 依赖无；进程内内存态，宿主重启即空。
 * 始终成立：每次写入都必须推进 counter，且只能经 writeSection / writePet 写。
 * 契约见 API.md 的「state 详解」与 openapi.yaml。
 *
 * @module dsh-pet/src/host/state
 */
/** 一个叶子：计数器 + 载荷（data 为 null 表示还没有数据）。 */
export interface StateLeaf {
    counter: number;
    data: unknown;
}
/** 全局段（所有端共享一份）。
 *  `config` 是纯信号叶子：data 恒为 {}，消费端只看 counter 变了就去重拉 GET /config——配置本体太大，
 *  不能塞进每秒一次的 /state。当前只有 POST /pet-display 写它：桌面端右键改显示位置时，浏览器
 *  页面不是发起方，只能靠这个信号知道配置被别处改过；保存 / 同步配置的调用方自己拿到了成品聚合，
 *  所以不写。 */
export type SectionName = 'balance' | 'workStatus' | 'notify' | 'config' | 'menu';
/** 每宠物段（say = 要说的话；anim = 要播的动画名；position = 要挪到的位置；throw = 要给的初速度；
 *  lock = 占用锁状态）。
 *  say / anim / position / throw 是 host → 前端的指令：前端读到即执行，不往它们写任何东西。
 *  `lock` 是状态不是指令：前端读它决定要不要冻结自己，并按叶子里的 expiresAt 自己解除静止——
 *  宿主侧没有定时器（见 ./lock）。 */
export type PetLeafName = 'say' | 'anim' | 'position' | 'throw' | 'lock';
/** S 的完整形态（GET /state 的响应体）。
 *  `counter` 是整份 S 的版本号 = 最后一次写入的编号，顶层而非叶子：调用方拿它当 `?since=` 回传。 */
export interface PollState {
    counter: number;
    sections: Record<SectionName, StateLeaf>;
    pets: Record<string, Record<PetLeafName, StateLeaf>>;
}
/** `?timeout=` 上限（ms）：挂起等待的封顶时长，防止调用方把连接挂死。
 *  与 ./playback 的 MAX_PLAYBACK_WAIT_MS 同值同因：DSH WebServer 是否对长期持有的响应设了空闲超时
 *  尚未核实，先压在 10s；核实后两处一起调。 */
export declare const MAX_STATE_WAIT_MS: number;
/** `?since=&timeout=` 的解析结论。 */
export type StateWaitParse = 
/** 两者都没传 → 立刻返回当前状态。 */
{
    kind: 'none';
}
/** 挂起等待。 */
 | {
    kind: 'ok';
    since: number;
    timeoutMs: number;
}
/** 参数非法 → 路由回 400（附明确原因，不静默兜底）。 */
 | {
    kind: 'error';
    error: string;
};
/**
 * 解析 `?since=<版本号>` 与 `?timeout=<ms>`（成对必填，规则见 openapi.yaml）。
 *
 * since 是非负整数，`0` 合法（首次接入的调用方用它表示「我手里什么都没有」）；
 * timeout 只接受 0..MAX_STATE_WAIT_MS 的非负整数，`0` 合法（下一拍立刻返回）。
 */
export declare function parseStateWaitQuery(sinceRaw: string | null, timeoutRaw: string | null): StateWaitParse;
/** 轮询统一状态存储（一个插件实例一个；进程内内存态，重启即空）。 */
export declare class PollStateStore {
    /** 严格递增的计数器种子（保证同一毫秒内连写两次也拿到不同的 counter）。 */
    private last;
    private readonly sections;
    private readonly pets;
    /** 挂起的等待者。全局集合：任意叶子被写过都唤醒他们——一次写入唤醒所有人是有意的，
     *  换的是实现的简单（桌面一窗一宠，会按窗口数放大）。 */
    private readonly waiters;
    constructor();
    /** 下一个 counter。 */
    private next;
    /**
     * 写一个全局叶子（余额 / 工作状态 / 通知 / 配置变更信号）。
     * 整体替换叶子对象而不是原地改字段：`read()` 拿到的引用因此不会半新半旧。
     */
    writeSection(name: SectionName, data: unknown): void;
    /** 写一只宠物的叶子（宠物条目不存在则自动建立，所有槽位一起建好，形状恒定）。 */
    writePet(petId: string, leaf: PetLeafName, data: unknown): void;
    /**
     * 当前 S（GET /state 的响应体）。
     * sections 是浅拷贝、pets 是新建对象——叶子对象本身共享，但写入永远整体替换，
     * 所以消费端不会读到写了一半的叶子。
     */
    read(): PollState;
    /**
     * 挂起一个等待者：直到 `last` 变得不等于 `since`、或超时、或调用方取消。
     *
     * 三种收尾对调用方是同一件事（去 `read()` 拿最新状态），所以回调不带参数。
     *
     * @returns 取消函数（清掉超时定时器并摘掉等待者）。
     */
    wait(args: {
        since: number;
        timeoutMs: number;
        onWake: () => void;
    }): () => void;
    /**
     * 结束所有挂起的等待（插件卸载 / 宿主退出路径）。
     * 唤醒时不给区分标志：调用方据此立刻收尾，而不是留一个悬挂的响应。
     */
    cancelAll(): void;
    /** 当前等待者数（测试 / 观测用：验证不泄漏）。 */
    waiterCount(): number;
    /**
     * 唤醒所有已经过期的等待者（唯一调用点是两个 write 方法，且必须在叶子写定之后）。
     * `since === this.last` 的跳过：那种等待者已经是最新的，叫醒它等于空转。
     * 必须写在 `this.sections[name] = …` 之后：放在 next() 里会让回调先于赋值执行，调用方读到旧状态。
     */
    private wakeWaiters;
    /** 摘掉一个等待者（清定时器 + 从集合移除）。 */
    private dropWaiter;
}
