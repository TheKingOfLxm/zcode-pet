/**
 * 设置面板导航图标补丁：把「桌宠配置」那一行的兜底齿轮换成指定图标。
 * DSH 的导航图标按分区 id 硬编码白名单，且私有、外部拿不到引用，只能在 DOM 层做。
 * 只打 `data-*` 标记并用 `::before` + mask 画字形，不动 DOM 结构，否则 React 会对被替换的节点 removeChild 崩。
 * 认行只能靠标题文本：投影到 DOM 的只有 label，而 account 行条件出现、位置会漂，不能用 `:nth-child`。
 * 降级：缺 document / MutationObserver、渲不出 SVG 时不装，认不出那一行时什么都不做，只告警。
 * @module dsh-pet/src/client/nav-icon
 */
/** 换图标的目标：一行导航的标题与该行要画上的字形。 */
export interface SectionNavIcon {
    /** 目标行标题，与注册 `settings.section` 时的 label 同源；每次现取。 */
    label: () => string;
    /** 把图标渲成内联 SVG 源码；由调用方注入，本模块因此不依赖 react / react-dom。 */
    renderSvg: () => string;
}
/**
 * 把内联 SVG 源码转成可作 CSS mask 的 data URI。
 * 需要补 `xmlns`（data URI 按独立图像文档解析，缺了不渲染）并把 `currentColor` 定成不透明黑（mask 只看 alpha）。
 * @param svg - 内联 SVG 源码。
 * @returns `url("data:image/svg+xml,...")`；源码为空时返回空串。
 */
export declare function svgMaskUri(svg: string): string;
/**
 * 把设置面板导航里目标分区的兜底齿轮换成指定图标。
 * @param target - 目标行标题与字形渲染器。
 * @returns 断开观察者的清理函数；已注入的样式与标记留在原地，不影响正确性。
 */
export declare function installSectionNavIcon(target: SectionNavIcon): () => void;
