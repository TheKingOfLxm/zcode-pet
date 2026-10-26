import type { Animations, Pet, PhysicsParams, Weights } from '../shared/types';
import type * as ReactNS from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { jsx } from 'react/jsx-runtime';
/** 运行期宠物：拍平后的成品实例，条目级字段已补齐且必填。 */
export type RuntimePet = Pet & {
    animations: Animations;
    animationWeights: Weights;
    eventsRefreshSec: Record<string, number>;
    physics: PhysicsParams;
};
/** 制造宠物页面组件（工厂），返回多开容器 PetMulti。
 *  react 能力由运行时注入；容器内部渲染多个 PetCard。
 */
export declare function makePetUI(rt: {
    h: typeof jsx;
    useState: <T>(init: T) => [T, Dispatch<SetStateAction<T>>];
    useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
    useRef: <T>(initial: T) => ReactNS.MutableRefObject<T>;
}): () => ReactNode;
