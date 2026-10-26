import type { Corner, Rect } from './types';
/** 一次移动的几何参数（比例坐标）。 */
export interface MovePlan {
    startRatio: number;
    startYRatio: number;
    targetRatio: number;
    totalRatio: number;
}
/** 计算一次移动的起点/终点比例坐标；目标越出边界（含边距）时返回 null。
 *  sideAllow = 左右透明边余量：边界按身体贴边而不是按整个视频盒贴边，宠物能走到屏幕边缘、身体不越界。
 *  areas 传入时（桌面多显示器）改判工作区并集：缝隙两侧都有屏即可骑缝走过，外接矩形的空洞走不进去；
 *  不传时按 W/H 单矩形判定，浏览器半侧行为不变。 */
export declare const planMove: (o: {
    cx: number;
    cy: number;
    W: number;
    H: number;
    dir: 1 | -1;
    minDist: number;
    maxDist: number;
    margin: number;
    halfW: number;
    /** 可选：身体相对视频盒左/右各留多少像素（默认 0 = 按视频盒贴边） */
    sideAllow?: number;
    /** 可选：显示器工作区列表（与 cx/cy 同坐标系）。给了就按并集判定落点可达性 */
    areas?: Rect[];
}) => MovePlan | null;
/**
 * 角落 + 边距 → 宠物根节点左上角像素坐标，与浏览器半侧 overlay 的 CSS 角落语义一致。
 * area 传入时角落取那块屏而不是视口外接矩形：不规则布局下外接矩形的角落可能不属于任何屏，
 * 配了该角落的宠物会开机即隐身，所以桌面端必须传主屏工作区。不传时按 W/H，overlay 行为不变。
 */
export declare const anchorPixel: (o: {
    corner: Corner;
    marginX: number;
    marginY: number;
    size: number;
    W: number;
    H: number;
    /** 可选：角落所属的工作区矩形（与调用方同坐标系）；缺省用 {0,0,W,H} */
    area?: Rect;
}) => {
    x: number;
    y: number;
};
