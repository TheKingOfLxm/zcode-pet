/**
 * 字体：字体种类 id → CSS 字体栈的唯一映射，以及字号换算。
 * 设置页选项由 FONT_PRESETS 生成，渲染层一律经 fontStackOf / resolveFontPx 取值，不再各写字面量。
 * 配置里只存 id 不存字体栈：字体栈手改写错会拼坏样式，id 有白名单可校验。
 * 宿主半侧不能用本模块（DSH 单文件加载约束），其 fontValid 是自包含副本，改清单须两边同步。
 * @module dsh-pet/src/shared/fonts
 */
import type { FontConfig, FontFamilyId } from './types';
/** 一个字体预设：写进配置的 id 与两端共用的 CSS 字体栈。 */
export interface FontPreset {
    id: FontFamilyId;
    /** CSS font-family 的值（不含尾部分号）：系统字体名跨平台并列兜底，末位必须是通用族 */
    stack: string;
}
/** 字体预设清单：顺序即设置页下拉框的显示顺序（第一项为默认）。
 *  candy 是唯一随包发布的字体，CSS 名 "ShangshouSoftCandy" 由我们自己起，改名须同步两端的 @font-face。
 *  其余都是系统字体，机器上没装时由字体栈后面的兜底自然回退，不报错也不空白。 */
export declare const FONT_PRESETS: FontPreset[];
/** 字号合法区间（px，含端点）：与宿主半侧 fontValid 同一口径——设置页据此即时提示，宿主据此拦截手改。 */
export declare const FONT_SIZE_MIN = 4;
export declare const FONT_SIZE_MAX = 200;
/** font 段默认值（与内置 config.jsonc 的 font 段一致）：462 宽宠物的气泡 21px，且随宠物大小缩放。
 *  不含 font 字段的配置因此仍按既有观感渲染。 */
export declare const DEFAULT_FONT: FontConfig;
/** 按 id 取字体栈；id 非法或缺失回退清单首项（软糖体），渲染层不再自行兜底。 */
export declare function fontStackOf(id: string): string;
/** 基准宠物宽度（px）：字号换算的锚点，等于内置配置的默认 size，也是既有 CSS 系数的设计基准。 */
export declare const FONT_REF_SIZE = 462;
/** 基准宽度下的气泡正文字号（px）＝ 0.0455 × 462 ≈ 21.02。 */
export declare const BUBBLE_FONT_BASE_PX: number;
/** 基准宽度下的悬浮提示字号（px）＝ 0.026 × 462 ≈ 12.01。 */
export declare const TIP_FONT_BASE_PX: number;
/** 气泡与悬浮提示的最终字号（px），两端共用同一份换算以免漂移。
 *  字号 = 基准 px × (font.size ÷ 默认字号) × (followPet ? 宠物宽 ÷ 462 : 1)。
 *  followPet=false 时退化为固定在 462 宽的字号；配置被手改坏则按默认口径处理，绝不产出 NaN 或 0。
 *  @param font - 该宠物的 font 配置，缺失按 DEFAULT_FONT。
 *  @param size - 该宠物的宽度 px。 */
export declare function resolveFontPx(font: FontConfig | undefined, size: number): {
    bubble: number;
    tip: number;
};
/** 气泡底边探出宠物盒顶边的比例（对应气泡 CSS 的 bottom: calc(100% - size×0.108)）。
 *  探出的这段同样计入气泡可用的垂直空间，见 bubbleTopMarginPx。 */
export declare const BUBBLE_OVERLAP_RATIO = 0.108;
/** 气泡布局度量（em，基准 = 气泡正文最终字号 --f）。
 *  系数与两端渲染层 .dsh-pet-bubble 的 CSS、shared/whisper.ts 的 MEME_BUBBLE_CSS 同源，
 *  改任何一条 CSS 系数都必须同步这里，否则桌面窗口上边距会算少、气泡顶端被窗口切掉。 */
export declare const BUBBLE_METRICS: {
    readonly lineHeight: 1.6;
    readonly padY: 0.4835;
    readonly subScale: 0.7692;
    readonly imgWidth: 7.4725;
    readonly imgMargin: 0.3736;
    /** 配图长宽比上限（内置 assets/memes 全为 128 宽、高不超过 128） */
    readonly imgMaxRatio: 1;
};
/** 气泡最大高度（px）：两行文本（余额气泡的主行 + 次要行）加一张配图。桌面端据此定窗口上边距。 */
export declare function bubbleMaxHeightPx(font: FontConfig | undefined, size: number): number;
/** 桌面窗口的最小上边距（px）：至少要容得下整只气泡。
 *  气泡底边落在宠物盒顶边下方 0.108 × 尺寸 处，故余量 = 气泡最大高度 − 这一段。
 *  默认配置（462px 宠物 / 21px 字号）算得 195px，仍小于既有余量 231px，窗口尺寸不变。 */
export declare function bubbleTopMarginPx(font: FontConfig | undefined, size: number): number;
