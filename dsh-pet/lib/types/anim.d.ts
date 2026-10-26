/**
 * 点播动画（`POST /dsh-pet-7340/anim`）的纯决策层：判定该不该播、播哪一个，结论交给写入方。
 *
 * 不负责播放，也不写 S；与右键菜单「动作」树复用同一个动作处理函数。动画名必须落在菜单能点到
 * 的集合里——播放端没有兜底（名字即文件名，404 表现为「点了没反应」），所以这条校验是硬要求，
 * 且必须能脱离 HTTP 单测。允许集合 = 菜单三级树叶里所有 anim 的并集，事实来源是 src/shared/menu.ts
 * 的 buildMenuTree()；宿主不 import src/shared（DSH 单文件加载约束），故自包含实现一份，两侧
 * 守卫测试同时钉住这份口径。只依赖成品配置（动画池都在 animations 里），不碰文件系统。
 * 契约见 API.md 与 openapi.yaml。
 * @module dsh-pet/src/host/anim
 */
/** 点播失败的分类；路由原样透出给调用方。 */
export type AnimFailure = 'bad-request' | 'pet-required' | 'unknown-pet' | 'unknown-animation';
/**
 * 朝向：`left` = 素材原样，`right` = 镜像（渲染端贴 `scaleX(-1)`）。
 * 与 shared/state.ts 的同名联合体是两份（宿主不 import src/shared），改动时两边要一起改。
 */
export type PetFacing = 'left' | 'right';
/**
 * 决策结论：通过则给出最终要写进 S 的内容（`name` 与 `url` 恰好一个），否则给出显式原因。
 * `facing` 缺席 = 调用方没指定，渲染端不动朝向（不是回落 left）。
 */
export type AnimDecision = {
    ok: true;
    petId: string;
    name?: string;
    url?: string;
    facing?: PetFacing;
} | {
    ok: false;
    reason: AnimFailure;
    message: string;
};
/**
 * 该条目的 animations 配置 → 可点播的动画名（去重，保持首次出现顺序）。
 * 池子与顺序对齐 src/shared/menu.ts 的 buildMenuTree()：待机 → 转向 → 拖拽 → 点击回应 →
 * 移动 → 随机动作分类 → 事件（数组槽位展平）。
 */
export declare function animationNames(animations: unknown): string[];
/**
 * 第三方资源地址规范化：只放行 http / https 的完整 URL，其余一律 null（调用方回 bad-request）。
 *
 * 桌面端换源是 `el.src = url` 直连（不经 `/thumb`），`file:` 能让渲染端读本地任意文件，
 * `javascript:` / `data:` 更没有理由开这个口。跨域不在这里解决、也不该在这里解决：桌面素材走
 * fetch + blob，CORS 由浏览器强制，第三方只能自己配响应头或注册同源路由；宿主不做代理，因此也
 * 没有 SSRF 面。与 ./broadcast 共用这一条规则（两个「第三方投喂」端点的 url 参数同一口径）。
 */
export declare function normalizeHttpUrl(v: unknown): string | null;
/**
 * 把外部给的点播请求与当前配置核对成一个结论。
 *
 * `name` 与 `url` 二选一：`url` 是第三方自带的素材地址，给了它就不查动画池——素材在别人手里，
 * 池里当然没有这个名字；两个都给 / 都不给都是意图不明，直接 bad-request，不替调用方猜一个。
 *
 * @param args - 点播参数：`cfg` 为成品配置（字段已填满，不做兜底解析）；`requested` 是 `?pet=` 原值
 *   （空串 → `pet-required`）；`name` / `url` 未规范化且二选一；`facing` 可选，没给则不动朝向。
 */
export declare function decideAnim(args: {
    cfg: Record<string, Record<string, unknown>>;
    requested: string;
    name: unknown;
    url: unknown;
    facing?: unknown;
}): AnimDecision;
