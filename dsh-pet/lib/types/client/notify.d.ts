/**
 * 系统通知引擎（浏览器半侧）：消费宿主生成的通知帧，按「聚焦不弹」发系统级 toast。
 * 这是独立于宠物的能力，只随 DSH 网页端走——桌面模式不做宠物无关的功能。
 * 不负责产生帧：宿主监听 DSH 事件并写进 `/state`，容器统一轮询发现 counter 变化后调 `notifyFromFrame`；
 * 中断 / 活动门等过滤也已在宿主侧完成。
 * 依赖 shared/notify.ts 的帧到文案映射，以及成品配置的 `main.notificationsEnabled` 总开关。
 * @module dsh-pet/src/client/notify
 */
/** 图标 URL 表；文件名以 shared 为单一来源，设置页的测试通知也用它。 */
export declare const NOTIFY_ICONS: {
    readonly done: string;
    readonly error: string;
    readonly truncated: string;
    readonly approval: string;
    readonly question: string;
    readonly test: string;
};
/** 会话跳转器：由 app.ts 注入，取不到服务时退化为不跳会话。 */
export interface SessionNavigator {
    openSession(sessionId: string): void;
}
/**
 * 点通知：先页内切到那条会话，再聚焦页面，最后请桌面壳把主窗口叫回前台。
 * 先切会话再叫窗口，用户看到窗口的那一刻就是目标会话；`dsh://open` 只在 Electron 宿主里发，
 * 浏览器里导航该协议会弹拦截框。`sessionId` 缺失时只跳过切换，其余照旧。
 */
export declare function wireNotificationClick(n: Notification, sessionId?: string): void;
/** 申请通知权限的结果；失败时带原因与可选文案，供设置页红字展示。 */
export type PermissionResult = {
    ok: true;
} | {
    ok: false;
    reason: 'unsupported' | 'denied' | 'rejected' | 'error';
    message?: string;
};
/**
 * 申请浏览器通知权限，必须在用户手势（点击）下调用，否则可能被静默压制。
 * 失败原因：`unsupported` 无 Notification、`denied` 已被阻止、`rejected` 询问时选了阻止、`error` 申请异常。
 */
export declare function requestNotificationPermission(): Promise<PermissionResult>;
/** 重读总开关（设置页保存开关后调用）；之后新触发的通知按新值执行，无需刷新页面。 */
export declare function reloadNotifications(): Promise<void>;
/** 一帧通知 → toast；由容器统一轮询 `/state` 发现 `sections.notify` 变化后调用。 */
export declare function notifyFromFrame(frame: unknown): void;
/**
 * 初始化通知引擎：记住会话跳转器、读总开关、兜底申请权限并跟踪页面聚焦；不做轮询。
 * @param navigator - 会话跳转器；不传时点击只叫窗口、不跳会话。
 * @returns 释放函数，摘掉聚焦监听。
 */
export declare function initNotify(navigator?: SessionNavigator): () => void;
