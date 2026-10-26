/**
 * 播放回执（playback receipt）的纯逻辑层：播放记录表 + 状态机 + 等待者。
 *
 * 负责记录由渲染端上报驱动的状态：只有真正在播的那一端知道播完 / 失败 / 被打断。
 * 不猜：读视频时长再起定时器是错的——加载失败时根本没开始播，定时器却会照常走到「播完」。
 * 不负责 HTTP 与叶子写入；播放记录是每次点播各自的资源，不能塞进 1s 的全局广播。
 * 依赖无（单测能接管时钟），编号只保证一次运行内唯一。
 * 始终成立：终态不可再变、上报幂等；等待者被唤醒时也必须带回当时的记录。
 * 契约见 API.md 与 openapi.yaml。
 *
 * @module dsh-pet/src/host/playback
 */
/** 播放状态。accepted 由 host 写（受理），其余由渲染端上报。 */
export type PlaybackStatus = 'accepted' | 'playing' | 'ended' | 'failed' | 'cancelled';
/** 终态：到达后不可再变。 */
export declare const TERMINAL_STATUSES: readonly PlaybackStatus[];
/** 渲染端允许上报的状态（accepted 是 host 的受理态，渲染端不许写）。 */
export declare const REPORTABLE_STATUSES: readonly PlaybackStatus[];
/** 终态记录保留时长（ms）：让调用方来得及查到最后状态，之后清理。 */
export declare const PLAYBACK_KEEP_MS: number;
/** `?timeout=` 上限（ms）：挂起等待的封顶时长，防止调用方把连接挂死。
 *  取值偏保守：DSH WebServer 是否对长期持有的响应设了空闲超时尚未核实，先压在 10s。 */
export declare const MAX_PLAYBACK_WAIT_MS: number;
/** 该状态是不是终态。 */
export declare const isTerminalStatus: (s: string) => boolean;
/** 该字符串是不是合法状态名（含 host 侧的 accepted）——`?wait=` 的合法性校验用它。 */
export declare const isPlaybackStatus: (s: string) => boolean;
/** 该状态是否允许渲染端上报。 */
export declare const isReportableStatus: (s: string) => boolean;
/**
 * 路径解析：`playback/<id>`（查询）与 `playback/<id>/report`（上报）。
 *
 * 正则两端锚定，只认这两种形状：其余（`playback/`、`playback/a/b`、`playbackx/a`）一律返回
 * undefined，交给下游分支按各自口径报错，绝不在这里「尽力猜一个 id」。
 */
export declare function parsePlaybackPath(rest: string): {
    playbackId: string;
    isReport: boolean;
} | undefined;
/** `?wait=&timeout=` 的解析结论。 */
export type WaitParse = 
/** 两者都没传 → 立刻返回（兜底 / 调试 / 只想知道当下状态）。 */
{
    kind: 'none';
}
/** 挂起等待。 */
 | {
    kind: 'ok';
    wait: PlaybackStatus[];
    timeoutMs: number;
}
/** 参数非法 → 路由回 400（附明确原因，不静默兜底）。 */
 | {
    kind: 'error';
    error: string;
};
/**
 * 解析 `?wait=<状态[,状态]>` 与 `?timeout=<ms>`（成对必填，规则见 openapi.yaml）。
 *
 * wait 支持逗号列表：终态有三个，只等 ended 会在失败时白等一整个 timeout，所以让调用方自己
 * 说清在等哪些。timeout 只接受 0..MAX_PLAYBACK_WAIT_MS 的非负整数，`0` 合法（下一拍立刻返回）。
 */
export declare function parseWaitQuery(waitRaw: string | null, timeoutRaw: string | null): WaitParse;
/** 一次点播的记录（`GET /playback/{id}` 的响应体即它的浅拷贝 + `matched`）。 */
export interface PlaybackRecord {
    playbackId: string;
    /** 目标宠物实例 id。 */
    petId: string;
    /** 这一次点播的标识：name 形态是动画名（名字即文件名），url 形态就是那个地址；纯记录，不参与判定。 */
    name: string;
    status: PlaybackStatus;
    createdAt: number;
    updatedAt: number;
    /** 进入 ended 的时刻（只有 ended 带；failed / cancelled 看 updatedAt）。 */
    endedAt?: number;
    /** 失败 / 被打断的原因（只有 failed / cancelled 带）。 */
    reason?: string;
}
/** report 的结论（路由据此决定 HTTP 状态码）。 */
export type ReportOutcome = 
/** 状态已更新（可能唤醒了等待者）。 */
'ok'
/** 幂等：终态之后的上报、或与当前状态相同的上报 → 200 但不改。 */
 | 'ignored'
/** 编号不存在 / 已过期 → 404。 */
 | 'unknown'
/** 非法状态名（含渲染端不许写的 accepted）→ 400。 */
 | 'invalid';
/** 等待注册参数。 */
export interface WaitArgs {
    playbackId: string;
    /** 等这些状态之一（非空；由路由先校验合法性）。 */
    wait: readonly string[];
    /** 超时毫秒数；0 = 下一拍立刻唤醒（等价「立刻返回」）。 */
    timeoutMs: number;
    /** 唤醒回调：matched=true 表示等到了，false 表示超时 / 取消 / 记录被清理。 */
    onWake: (record: PlaybackRecord, matched: boolean) => void;
}
/**
 * 播放记录表（一个插件实例一个；进程内内存态，宿主重启即空）。
 *
 * 单线程事件循环，所有方法同步完成，不存在竞态；唤醒回调在方法返回之后才可能被调用，
 * 所以调用方可以放心在回调里再调本表的方法。
 */
export declare class PlaybackStore {
    private readonly records;
    private readonly waiters;
    /**
     * 每只宠物当前未终态的那一场。
     * `pets.<id>.anim` 是单叶子（同一宠物同时只有一场点播），所以新点播受理时直接把上一场标成
     * cancelled/superseded——这是确定性事实，不必等渲染端上报。
     */
    private readonly activeByPet;
    /** 编号自增段（与时间戳一起构成运行内唯一编号）。 */
    private seq;
    constructor();
    /**
     * 受理一次点播：建记录（accepted），并把该宠物上一场（若仍在非终态）标为 cancelled/superseded。
     * @returns 新建的记录（调用方取 playbackId 下发给调用方）。
     */
    create(petId: string, name: string): PlaybackRecord;
    /** 查记录；不存在 / 已过期返回 undefined（路由回 404）。 */
    get(playbackId: string): PlaybackRecord | undefined;
    /**
     * 渲染端上报一次状态。
     *
     * 终态之后的上报一律 ignored（迟到的 ended 不许覆盖 cancelled），与当前状态相同的上报同样
     * ignored；两种情况路由都回 200——对上报方来说「已经这样了」就是成功。
     */
    report(playbackId: string, status: unknown, reason?: unknown): ReportOutcome;
    /**
     * 挂起一个等待者。
     * @returns 取消函数；编号不存在时返回 undefined（路由据此立刻回 404，不挂）。
     */
    wait(args: WaitArgs): (() => void) | undefined;
    /** 结束所有挂起的等待（插件卸载 / 宿主退出路径）；唤醒时 matched=false，调用方据此立刻收尾。 */
    cancelAll(): void;
    /**
     * 清理过期终态记录（惰性调用：create / get / report 各调一次，记录数很少，成本可忽略）。
     *
     * 必须先把还在等它的人叫醒：等待上限（10s）通常远小于保留时长（60s），但调用方完全可以在
     * 一条终态记录的保留窗口末尾注册一个等「别的状态」的等待者——不唤醒就成了永远等不到的悬挂等待者。
     *
     * @param now - 注入时间（单测用；缺省取当前时刻）。
     */
    sweep(now?: number): void;
    /** 当前记录数（测试 / 观测用）。 */
    count(): number;
    /** 当前等待者数（测试 / 观测用：验证不泄漏）。 */
    waiterCount(): number;
    /**
     * 落到一个终态：写状态、更新时间、摘掉「当前活跃」、唤醒在等这个状态的人。
     * 这是唯一的状态写入点，所以等待者唤醒只在这里发生（不需要 diff、不需要比对）。
     */
    private finish;
    /** 摘掉一个等待者（清定时器 + 从集合移除 + 空集合回收）。 */
    private dropWaiter;
}
