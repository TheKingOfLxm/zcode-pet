/**
 * 系统通知：DSH 事件帧 → toast 文案的映射，只随浏览器半侧走。
 * 帧由宿主半侧监听 DSH 宿主事件生成（见 host/notify-events.ts），浏览器轮询 /notify 的增量队列消费本映射。
 * 桌面模式是宠物本体，不重复实现通知（宠物不等于通知，「两端一致」只约束宠物行为）。
 * 纯函数无副作用：帧形状不匹配或不认识的类型一律返回 null，不弹也不报错。
 * @module dsh-pet/src/shared/notify
 */
/** 通知图标文件名（不含扩展名）；浏览器半侧拼完整 URL：/dsh-pet-7340/pic/<name>.png。 */
export declare const NOTIFY_ICONS: {
    readonly done: "notify-done";
    readonly error: "notify-error";
    readonly truncated: "notify-truncated";
    readonly approval: "notify-approval";
    readonly question: "notify-question";
    readonly test: "notify-test";
};
/** 文案截断长度上限（字符）。 */
export declare const MAX_BODY = 80;
/** 文案截断（与弹窗一致：超长只留前 80 字符）。 */
export declare function truncate(text: string): string;
/** 通知帧：宿主半侧转发过来的一条 DSH 事件。 */
export interface NotifyFrame {
    type: string;
    /** 发出这条通知的会话 id；点击通知时据此跳到那条会话。
     *  没有会话位置的事件（host/agent-error）不带这个字段，消费端把缺失当成「只叫窗口」。 */
    sessionId?: string;
    [key: string]: unknown;
}
/** 帧 → toast 文案；不认识的类型或 turn/end 的非弹分支（aborted 等）返回 null。 */
export declare function frameToToast(frame: NotifyFrame): {
    title: string;
    body: string;
    icon: string;
} | null;
