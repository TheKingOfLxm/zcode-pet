/**
 * 共享层：把宿主半侧的成品配置拍平成渲染用宠物列表。
 * 不负责读取、合并与校验——那是宿主半侧 readAllConfig 的职责，本层只消费其结果。
 * 不依赖 React / DOM；宿主半侧不 import 本目录，其配置实现自包含、规则须与本层同步。
 * 条目级字段必须吹进每只实例：多实例共享所属条目的同一份值。
 * @module dsh-pet/src/shared/config
 */
import type { Animations, FontConfig, ModelSelection, Pet, PetDisplay, PhysicsParams, Weights } from './types';

/** 显示位置白名单。 */
export const PET_DISPLAYS: PetDisplay[] = ['web', 'desktop', 'both', 'none'];

/** 该宠物是否参与浏览器半侧渲染。 */
export const isWebVisible = (display: PetDisplay): boolean => display === 'web' || display === 'both';

/** 该宠物是否参与桌面模式（Electron 透明窗）渲染。 */
export const isDesktopVisible = (display: PetDisplay): boolean => display === 'desktop' || display === 'both';

/** 把成品聚合拍平成渲染用宠物列表。
 *  条目级字段（animations / physics / font 等）由所属条目一份、多实例共享；assetRoot 取条目 key，
 *  即素材根。非 main 条目打 extra 标记：文件宠物在设置页不可编辑、保存时排除。 */
export function flattenConfigPets(merged: Record<string, Record<string, unknown>>): Pet[] {
  const out: Pet[] = [];
  for (const [entry, conf] of Object.entries(merged)) {
    const list = Array.isArray(conf?.pets) ? (conf.pets as Pet[]) : [];
    for (const p of list) {
      out.push({
        ...p,
        animations: conf.animations as Animations | undefined,
        animationWeights: conf.animationWeights as Weights | undefined,
        eventsRefreshSec: conf.eventsRefreshSec as Record<string, number> | undefined,
        physics: conf.physics as PhysicsParams | undefined,
        font: conf.font as FontConfig | undefined,
        confineToScreen: conf.confineToScreen as boolean | undefined,
        workStatusTexts: conf.workStatusTexts as string[][] | undefined,
        whisperModel: conf.whisperModel as ModelSelection | undefined,
        chatModel: conf.chatModel as ModelSelection | undefined,
        assetRoot: entry,
        extra: entry !== 'main',
      });
    }
  }
  return out;
}
