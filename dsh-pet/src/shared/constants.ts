/**
 * 画布与几何常量：与 640×360 播放变体强耦合，属运行时几何，不作为配置。
 * 浏览器半侧与桌面模式共用同一组值；命中、移动与抛掷都按这组值换算，改画布尺寸须同步素材。
 * 不依赖任何模块；这些值不来自配置，运行时的位移与命中由宠物大小和 moves 段决定。
 * @module dsh-pet/src/shared/constants
 */
/** thumb 画布高度。 */
export const CANVAS_H = 360;
/** thumb 画布上脚底的 y 坐标（人物站在 y=330 线上）。 */
export const FEET_Y = 330;
/** 点击与拖拽的命中矩形（thumb 640×360 像素坐标）。 */
export const HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 };
/** 拖拽判定阈值（px）。 */
export const DRAG_THRESHOLD = 5;
/** 弹弓窗口（ms）：两次按下之间的间隔小于它即按弹弓算，与这次拖了多久、何时松手无关。
 *  只认左键，没有待拉状态（换算见 physics.ts）。 */
export const SLINGSHOT_DOUBLE_MS = 200;
/** 移动距离的缩放基准（px）：配置里的 minDist/maxDist 是基准宠物宽 462px 下的像素，
 *  运行时按「实际 size / 基准」等比缩放，任何缩放下行进距离都与人物自身大小成比例。 */
export const PET_REF_WIDTH = 462;

/** 播放动画扩展名（集中开关）：默认 .webm（VP9-alpha）两端可直接透明播放；
 *  macOS 的 Safari/WKWebView 不认 webm alpha（渲染黑底），需改为 .mov（HEVC-with-Alpha）——
 *  素材从仓库 Release 的 assets-mov tag 取，放进 main-animation/mov/ 后重新构建；
 *  npm 包用户改产物里的同名常量。 */
export const ANIMATION_EXT = '.webm';
