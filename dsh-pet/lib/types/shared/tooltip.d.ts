/**
 * 宠物悬浮提示：替代原生 title（它的样式、字体、延迟全由浏览器或系统决定，改不动），按光标位置显示。
 * 本模块给 class、样式与摆位纯函数；节点构造与宽高实测留在两端各自的壳里。
 * 坐标一律是各端自己的视口坐标（fixed 定位），宠物走动或窗口位移不会带着提示漂。
 * 尺寸取宠物宽的 CSS 变量（两端变量名不同），用回退兼容，调用方无需传尺寸。
 * 不用 DSH 主题变量：它只存在于 DSH 页面，桌面 Electron 页里没有，会退化成透明底。
 * @module dsh-pet/src/shared/tooltip
 */
/** 提示框 class（两端共用）。 */
export declare const TOOLTIP_CLASS = "pet-tooltip";
/** 光标与提示框之间的间隙（占宠物宽度比例）：462px 的宠物下约 10px，与原生提示的偏移观感接近。 */
export declare const TOOLTIP_GAP_RATIO = 0.022;
/** 一个点（视口坐标）。 */
export type TipPoint = {
    x: number;
    y: number;
};
/** 矩形（与 TipPoint 同坐标系）。 */
export type TipRect = {
    x: number;
    y: number;
    w: number;
    h: number;
};
/** 光标位置 + 提示框实测尺寸 + 允许范围 → 提示框左上角坐标。
 *  摆法与原生提示一致：优先放光标右下，右边装不下翻到左侧，下边装不下翻到上方，翻完仍越界就夹回范围内。
 *  尺寸必须实测（offsetWidth/offsetHeight）：翻边判据依赖真实宽高，估算偏大会贴着边就翻、偏小会越界被裁。
 *  @param cursor - 光标位置。
 *  @param tip - 提示框实测尺寸（px）。
 *  @param bounds - 允许显示的范围：桌面端是窗口 ∩ 光标所在屏的工作区，浏览器端是整个视口。
 *  @param gap - 光标与提示框的间隙（px）。 */
export declare function tooltipPlacement(cursor: TipPoint, tip: {
    w: number;
    h: number;
}, bounds: TipRect, gap: number): TipPoint;
/** 提示框样式 —— 两端注入同一份（浏览器并入插件 CSS，桌面由 renderer.js 建 style 标签）。 */
export declare const TOOLTIP_CSS: string;
