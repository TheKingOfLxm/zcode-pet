/**
 * 「实况」（位置 + 朝向）的页面内注册表：PetCard 挂载时注册读法，供 Cordis 只读服务 `petApi7340` 读取。
 * 网页端的位置天生按页面各一份：宠物在各自视口里，读到的也正好是这一页里的这只，无需实例 id。
 * 只服务浏览器半侧；不负责宿主半侧的快照——桌面宠物走自己的 `POST /pose/report` 与 `GET /pose`。
 * 坐标口径与 `POST /position` 完全一致（归一化中心坐标），且按需读取，不是注册时的快照。
 * @module dsh-pet/src/client/pose
 */
/** 一次实况：宠物中心的归一化坐标与朝向。 */
export type Pose = {
    x: number;
    y: number;
    facing: 'left' | 'right';
};
/**
 * 注册一只宠物在这一页的实况读法。
 * @param petId - 宠物 id。
 * @param read - 取当前实况的函数。
 * @returns 摘除函数；重复调用无害。
 */
export declare function registerPose(petId: string, read: () => Pose): () => void;
/**
 * 读某只宠物在这一页的实况；不在这页（未注册 / 未挂载 / `display` 不含 `web`）时为 `null`。
 * 与桌面端 `GET /pose` 的「明确不可用」同义；每次调用都取当前值，走位、拖拽中途也能读到。
 */
export declare function readPose(petId: string): Pose | null;
/** 当前注册了几只（测试与观测用：验证卸载不泄漏）。 */
export declare function poseReaderCount(): number;
