/**
 * 浏览器半侧的余额与碎碎念气泡：哑组件，只把 shared 的行数据或节点树映射成 React 节点。
 * 不发起请求，显隐与停留时长由 pet.ts 控制。
 * 依赖运行时注入的 react 与 shared 的 balance / whisper 视图。
 * 必须始终成立：样式与桌面端同源，文案与档位由 shared 计算。
 * @module dsh-pet/src/client/bubble
 */
import { type BalanceState } from '../shared/balance';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type * as ReactNS from 'react';
import type { jsx } from 'react/jsx-runtime';
/** 制造余额气泡组件（工厂），注入样式一次。
 *  内容来自 shared 的 balanceBubbleView / balanceDetailView；内置形态走行数据，
 *  custom 走第三方节点树。切页是淡出 → 换内容 → 淡入，显隐与 10s 计时归 pet.ts 管。
 */
export declare function makeBalanceBubble(rt: {
    h: typeof jsx;
    useState: <T>(init: T) => [T, Dispatch<SetStateAction<T>>];
    useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
}): (props: {
    state: BalanceState;
    on: boolean;
    /** 目标页：0 为初始页；内置 windows 形态下 0 收起、1 展开。 */
    index: number;
    /** 点击气泡：上层切到下一页并重置 10s 计时器。 */
    onCycle: () => void;
}) => ReactNode;
/** 制造碎碎念气泡组件（工厂），与余额气泡共用样式与行渲染。
 *  image 是池内名（按素材根拼路径），url 是第三方完整地址，两者互斥且由 host 判定层保证。
 *  有配图时渲染在文字上方，图片样式取自 shared 的 MEME_BUBBLE_CSS。
 */
export declare function makeWhisperBubble(rt: {
    h: typeof jsx;
}): (props: {
    text: string;
    image?: string;
    url?: string;
    assetRoot?: string;
    on: boolean;
}) => ReactNode;
