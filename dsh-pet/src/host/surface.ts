/**
 * 「这只宠物显示在哪一端」与调用方期望（`?surface=`）的对齐判定。
 *
 * 负责把「必然不可能」提前变成显式失败（pet-not-displayed + 实际 display），纯逻辑、可离线单测。
 * 不负责按面分发：指令照旧写进同一个叶子、两端内容照旧完全一致；要两端播不同内容用两只宠物表达。
 * 依赖无；只有宿主用得到，所以不与 src/shared 各写一份。
 * 始终成立：surface 必填（any 是「不关心哪一端」的明说方式，不是省略）；display: none 无条件拒绝。
 * 契约见 openapi.yaml 的 SurfaceQuery。
 *
 * @module dsh-pet/src/host/surface
 */

/** 调用方期望的显示端（`?surface=` 的四个取值）。 */
export type Surface = 'web' | 'desktop' | 'both' | 'any';

/** 合法取值，校验与文案共用一份。 */
export const SURFACES: readonly Surface[] = ['web', 'desktop', 'both', 'any'];

/** 缺省 / 非法时的提示文案。 */
export const SURFACE_TEXT = 'surface 必填：web / desktop / both / any';

/** 取值收窄：只认四个字面量，大小写、空白、非字符串一律不算，不认识返回 null。 */
export function normalizeSurface(v: unknown): Surface | null {
  return typeof v === 'string' && (SURFACES as readonly string[]).includes(v) ? (v as Surface) : null;
}

/**
 * 该宠物的 display 是否满足调用方的期望。
 *
 * 判定规则见 openapi.yaml 的 SurfaceQuery（both 只匹配 display: both，any 只排除 none）；
 * display 不是合法值时一律视为不满足——配置校验会拦住，这里只做防御。
 */
export function displayCovers(want: Surface, display: string): boolean {
  switch (want) {
    case 'any':
      return display === 'web' || display === 'desktop' || display === 'both';
    case 'web':
      return display === 'web' || display === 'both';
    case 'desktop':
      return display === 'desktop' || display === 'both';
    case 'both':
      return display === 'both';
  }
}
