/**
 * 两端共用的右键菜单：菜单树推导、级联渲染与样式（浏览器半侧与桌面 Helper 同一份实现）。
 * 不负责业务动作本身：点击只回调 MenuLeaf，由各端壳执行，一级工具项也由壳注入。
 * 菜单数据的唯一来源是成品 animations 配置，用户覆盖层因此自动生效。
 * 每级面板平级挂在根容器下、绝不嵌套（嵌套会被父面板的滚动区裁切）；指针留在树内时子面板保持展开。
 * @module dsh-pet/src/shared/menu
 */
import type { Animations, Category, PetDisplay } from './types';
/** 叶子：可点击的菜单项。 */
export interface MenuLeaf {
    label: string;
    /** 播放的动画名（点播动作）；action 优先于 anim */
    anim?: string;
    /** 自定义动作：打开网站 / 查看余额 / 立即碎碎念 / 打开对话弹窗 / 回到初始位置 /
     *  重载配置（桌面端专属，重启桌面 Helper 并按最新配置重建窗口）/ 改显示位置（目标值见 display，
     *  两端都注入）/ 第三方菜单项（只把 owner 与 label 上报给注册方，具体做什么由它决定）。
     *  手动触发均不受 whisperEnabled 影响——那个字段只关自动轮询。 */
    action?: 'open-site' | 'show-balance' | 'whisper' | 'chat' | 'home' | 'reload' | 'set-display' | 'third-party';
    /** set-display 的目标显示位置（与设置页的下拉框同一套取值） */
    display?: PetDisplay;
    /** third-party：注册它的 owner（身份键，只用于回传，不显示）；同一个 owner 的项收在同一分组下，
     *  只有一项时跳过这层直接平铺。 */
    owner?: string;
    /** 项目右侧的灰色小字（如快捷键）：纯视觉提示，不参与文本匹配也不影响动作分发，缺省不占位。 */
    hint?: string;
}
/** 分支：带子菜单的项。 */
export interface MenuBranch {
    label: string;
    children: MenuNode[];
}
export type MenuNode = MenuLeaf | MenuBranch;
/** 「显示位置」子菜单：两端注入同一份，文案与设置页的显示位置下拉框一致。
 *  两端各写一份必然漂移，而这一项语义对称：桌面端用它把宠物送走，浏览器端用它送到桌面。
 *  「都不」是单向门（恢复入口是设置页），其余三个值都能从某一端改回来。 */
export declare const displayMenuBranch: () => MenuBranch;
/** 第三方菜单项（宿主经 /state 的 sections.menu 下发的快照，一条 = 一个可点项）。 */
export interface MenuMoreItem {
    /** 注册方身份；同时也是一级分组名（显示用） */
    owner: string;
    /** 项名（显示用，也是回传给注册方的标识） */
    label: string;
}
/** 第三方菜单项统一收在这个一级菜单下（宿主自己的菜单项不进这里）。 */
export declare const MORE_MENU_LABEL = "\u66F4\u591A";
/** 从 /state 的 sections.menu.data 里读出本端要显示的第三方菜单项。
 *  target 等于本端身份或 both 才收；target 缺失或不认识时按 both 处理——老宿主没有这个字段，
 *  宁可在两端都显示，也不要让一个正在用的第三方菜单凭空消失。
 *  快照来自网络，字段一律按「可能不存在」处理：坏条目静默丢弃，不能让一条数据搞崩菜单。 */
export declare function readMenuItems(data: unknown, surface: 'web' | 'desktop'): MenuMoreItem[];
/** 「更多」一级菜单：把第三方菜单项拼成菜单树的一枝；没有第三方项时返回 null，菜单里不会出现空的「更多」。
 *  层级只按项数决定：某 owner 只有 1 项就直接平铺（少一次点击），2 项及以上才加 owner 这一层。
 *  同名不同 owner 的项允许共存，不做去重、编号或来源标注——文案由注册方负责。 */
export declare function buildMoreBranch(items: readonly MenuMoreItem[]): MenuBranch | null;
/** 由成品 animations 配置推导菜单树：一级「动作」→ 二级分类 → 三级动画名；空池与空分类自动省略。 */
export declare function buildMenuTree(animations: Animations): MenuNode[];
/** 该动画是否属于 noMirror 分类（文字类）：朝右镜像时点播前强制朝左，避免文字镜像。 */
export declare function isNoMirrorAnimation(categories: Category[], anim: string): boolean;
/** 菜单样式 —— 两端注入同一份。每级面板是独立的绝对定位盒子，位置由 JS 内联写入，互不嵌套。 */
export declare const MENU_CSS: string;
/** 右键菜单挂载句柄。 */
export interface ContextMenuMount {
    /** 已挂载的根元素（document.body 下） */
    el: HTMLElement;
    /** 关闭并清理（幂等） */
    close: () => void;
}
/** 挂载一个系统风格右键菜单（级联子菜单）到 document.body，位置为视口坐标。
 *  结构：根容器零尺寸，每级面板平级挂载、按触发项屏幕位置贴边定位（右/下边缘自动翻转夹取）。
 *  级联：指针在菜单树内绝不自动收起，整体离开（root mouseleave，软 200ms）才关闭整棵菜单。
 *  clamp：允许占用的矩形（视口局部坐标）；桌面传「窗口 ∩ 工作区」——宠物贴边时窗口外扩的部分
 *  会被 OS 裁掉，约束进去即可完整显示，窗口与宠物零移动。 */
export declare function mountContextMenu(opts: {
    tree: MenuNode[];
    x: number;
    y: number;
    onAction: (leaf: MenuLeaf) => void;
    /** 菜单被关闭（点项/点外/Esc）后的通知：挂载方据此复位自身状态（如桌面可交互标记） */
    onClose?: () => void;
    /** 菜单允许占用的矩形（视口局部坐标）；缺省 = 整个视口 */
    clamp?: {
        x: number;
        y: number;
        w: number;
        h: number;
    };
}): ContextMenuMount;
