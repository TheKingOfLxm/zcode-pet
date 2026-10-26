/**
 * 对话输入弹窗：两端共用同一份 DOM 与交互。
 * 发送走宿主半侧的 /chat，记忆只由宿主读写，所以浏览器与桌面天然共享同一份记忆。
 * 回复不经响应回传展示：POST 的响应里也有正文，但本组件不用它——回复统一从 /state 的
 * pets.<id>.say 走气泡展示，onSent 只用来催促调用方取一拍。
 * 不负责生成、记忆策略与气泡渲染。
 * @module dsh-pet/src/shared/chat
 */
/** 发送回执：本类型只声明消费方用到的 ok，正文展示一律走 /state 的 pets.<id>.say。 */
export type ChatSendState = {
    ok: true;
} | {
    ok: false;
    reason: 'provider-missing' | 'generate-error' | 'config-error' | 'bad-request';
    message?: string;
};
/** 发送一句对话（携带记忆去宿主生成回复并写入记忆）。
 *  网络或解析失败显式抛错，调用方决定报错方式，绝不静默伪造回复。 */
export declare function sendChat(baseUrl: string, text: string): Promise<ChatSendState>;
/** 弹窗样式 —— 两端注入同一份。
 *  一条自适应输入框（无标题、无按钮）：初始 160px，随输入增宽、封顶 340px 后折行增高；
 *  回车发送，Esc 或点外关闭。宽度由 JS 按文本测量覆盖根元素宽度。 */
export declare const CHAT_CSS: string;
/** 对话弹窗挂载句柄。 */
export interface ChatDialogMount {
    /** 根元素（document.body 下） */
    el: HTMLElement;
    /** 关闭并清理（幂等） */
    close: () => void;
}
/** 挂载一个对话输入弹窗（两端共用；位置为视口坐标，超出 clamp 矩形自动夹回）。
 *  只有一条输入框，回车即发送：发送成功后弹窗关闭并调 onSent——回复写进了 pets.<id>.say，
 *  气泡随下一拍出现。Esc 或点弹窗外关闭；生成失败留在弹窗内显式提示，不伪造回复。
 *  clamp 是弹窗允许占用的矩形（视口局部坐标，默认整个视口）。桌面传「窗口 ∩ 工作区」——
 *  宠物贴屏幕底或右时窗口外扩余量伸出屏幕，约束进去即可完整显示，窗口与宠物零移动。 */
export declare function mountChatDialog(opts: {
    petId: string;
    /** 端点基址：浏览器默认相对路径，桌面传绝对 URL（file:// 页面需要绝对） */
    baseUrl?: string;
    /** 这个弹窗开在哪一端：POST /chat 的 ?surface= 是必填的，宿主据此提前拒掉不可能的组合。 */
    surface: 'web' | 'desktop';
    x: number;
    y: number;
    /** 发送成功后调用（弹窗此时已关闭）：回复本身不从这里回传，数据只有 /state 一个出口。 */
    onSent?: () => void;
    onClose?: () => void;
    /** 弹窗允许占用的矩形（视口局部坐标）；缺省 = 整个视口 */
    clamp?: {
        x: number;
        y: number;
        w: number;
        h: number;
    };
}): ChatDialogMount;
