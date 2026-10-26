/**
 * 「桌宠配置」设置页（`settings.section` 插槽，id 为 pet-config）：编辑 main 条目的宠物列表与全局默认值。
 * 只读成品配置里可编辑的 main 条目并统计文件宠物条数，不自行拼条目级字段；文件宠物永不回写。
 * 保存与同步都全量写用户层，再用宿主返回的成品聚合调 `petBridge.reload`，容器据此重渲染、无需刷新。
 * 样式对齐官方设置页：max-width 720px，全部走 `--dsw-alias-*` 语义 token。
 * @module dsh-pet/src/client/settings
 */
import { PET_DISPLAYS } from '../shared/config';
import { DEFAULT_FONT, FONT_PRESETS, FONT_SIZE_MAX, FONT_SIZE_MIN } from '../shared/fonts';
import { DEFAULT_PHYSICS } from '../shared/physics';
import { NOTIFY_ICONS, reloadNotifications, requestNotificationPermission, wireNotificationClick } from './notify';
import type { Corner, FontConfig, FontFamilyId, ModelSelection, Pet, PetDisplay, PhysicsParams } from '../shared/types';
import type { ChangeEvent, Dispatch, FunctionComponent, SetStateAction } from 'react';
import type * as ReactNS from 'react';
import type { jsx } from 'react/jsx-runtime';

/** 容器与设置页共享的桥（同一 bundle 单例）：current 是最新成品拍平列表（容器是唯一写入方），
 * reload 是容器注册的重载回调（传成品聚合即直接拍平，缺省由容器自行拉取），template 是 main 条目的首只宠物。 */
export const petBridge: {
  current: Pet[];
  reload: (merged?: Record<string, Record<string, unknown>>) => void;
  template: Pet | undefined;
} = {
  current: [],
  reload: () => {},
  template: undefined,
};

/** 字典命名空间。 */
export const NS = 'pet.config';

/** 一处「服务商 + 模型」是否合法：要么都留空（跟随当前对话），要么都非空。
 * 与宿主 `modelSelectionValid` 同一套规则（非法时宿主回 400，这里先就地给红字提示）。 */
const modelPairValid = (m: ModelSelection): boolean => (m.provider.trim() === '') === (m.model.trim() === '');

/** 候选清单里的一组：一个服务商及它名下的模型（`GET /models` 的响应形态）。 */
interface ModelCatalogGroup {
  id: string;
  name: string;
  models: Array<{ id: string; name: string }>;
}

/**
 * 设置页内联 CSS：只放伪类、悬浮、过渡与栅格这类行内样式表达不了的东西，其余排版走组件内联 style。
 * 类名统一 `dsh-pet-` 前缀，注入方式与宠物页面一致（`data-plugin-css` 去重）。
 */
const SETTINGS_CSS = [
  '.dsh-pet-mp{position:relative;min-width:0;display:flex;flex-direction:column;gap:4px}',
  '.dsh-pet-mp__trigger{display:flex;align-items:center;gap:6px;width:100%;max-width:340px;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;text-align:left;cursor:pointer;outline:none}',
  '.dsh-pet-mp__trigger:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}',
  '.dsh-pet-mp__trigger:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
  '.dsh-pet-mp__trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
  '.dsh-pet-mp__label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
  '.dsh-pet-mp__sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex-shrink:1000;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}',
  '.dsh-pet-mp__chevron{flex:none;margin-left:auto;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));transition:transform .12s}',
  '.dsh-pet-mp__chevron.is-open{transform:rotate(180deg)}',
  // 浮层用 fixed 脱离设置页的滚动容器（不被 overflow 裁掉）；z-index 与插件右键菜单同一档。
  '.dsh-pet-mp__panel{position:fixed;z-index:2147483000;display:flex;flex-direction:column;gap:4px;padding:4px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent,0 8px 30px rgba(0,0,0,.35));color:var(--dsw-alias-label-primary)}',
  '.dsh-pet-mp__search{box-sizing:border-box;width:100%;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;outline:none}',
  '.dsh-pet-mp__search:focus{border-color:var(--dsw-alias-state-business-primary)}',
  '.dsh-pet-mp__list{display:flex;flex-direction:column;min-height:0;overflow-y:auto;scrollbar-width:thin}',
  '.dsh-pet-mp__group{padding:6px 8px 2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
  '.dsh-pet-mp__item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}',
  '.dsh-pet-mp__item:hover:not(:disabled),.dsh-pet-mp__item.is-active{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-pet-mp__item[aria-checked="true"]{color:var(--dsw-alias-state-business-primary)}',
  '.dsh-pet-mp__item:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
  '.dsh-pet-mp__name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
  '.dsh-pet-mp__check{flex:none;margin-left:auto}',
  '.dsh-pet-mp__status{padding:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',

  '.dsh-pet-cfg{container-type:inline-size;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
  '.dsh-pet-cfg__title{display:flex;align-items:center;gap:6px;margin:0;font-size:16px;font-weight:500;line-height:24px}',

  '.dsh-pet-cfg__card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}',
  '.dsh-pet-cfg__cardHead{display:flex;align-items:center;gap:6px;min-height:20px}',
  '.dsh-pet-cfg__cardTitle{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',

  '.dsh-pet-cfg__grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 16px;align-items:end}',
  '.dsh-pet-cfg__grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px 16px;align-items:end}',
  '.dsh-pet-cfg__grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 16px;align-items:end}',

  '@container (max-width:600px){.dsh-pet-cfg__grid4{grid-template-columns:repeat(2,minmax(0,1fr))}}',
  '@container (max-width:400px){.dsh-pet-cfg__grid2,.dsh-pet-cfg__grid3,.dsh-pet-cfg__grid4{grid-template-columns:minmax(0,1fr)}}',

  '.dsh-pet-cfg__field{display:flex;flex-direction:column;gap:4px;min-width:0}',
  '.dsh-pet-cfg__flabel{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary)}',

  '.dsh-pet-cfg__inp{box-sizing:border-box;width:100%;min-height:28px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}',
  '.dsh-pet-cfg__inp:focus{border-color:var(--dsw-alias-state-business-primary)}',
  '.dsh-pet-cfg__inp:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',

  // 人设复用 __inp 的边框与字号，只补高度与纵向缩放；人设没有长度上限，右下角只显示字数、不阻断输入。
  '.dsh-pet-cfg__persona{display:flex;flex-direction:column;gap:2px;min-width:0}',
  '.dsh-pet-cfg__area{min-height:66px;resize:vertical;line-height:18px}',
  '.dsh-pet-cfg__count{font-size:11px;color:var(--dsw-alias-label-tertiary);text-align:right}',

  '.dsh-pet-cfg__toggle{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary)}',
  '.dsh-pet-cfg__toggle>label{display:inline-flex;align-items:center;gap:6px;cursor:pointer;min-width:0}',
  '.dsh-pet-cfg__toggle>label>span{overflow-wrap:anywhere}',
  '.dsh-pet-cfg__toggle input[type=checkbox]{flex:none;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}',

  // 悬浮说明通用件：任何带 data-tip 的元素悬浮即出气泡，组件侧用 tip() 生成属性，不额外包 DOM。
  '.dsh-pet-cfg [data-tip]{position:relative}',
  // 气泡默认左对齐：触发元素常贴卡片左缘，居中会向左伸出并被 overflow 裁掉；贴右缘的用 data-tip-end。
  '.dsh-pet-cfg [data-tip]::after{display:none;content:attr(data-tip);position:absolute;left:-4px;bottom:calc(100% + 8px);width:max-content;max-width:260px;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-tooltip-bg);color:#fff;font-size:12px;font-style:normal;font-weight:400;line-height:18px;text-align:left;white-space:normal;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .12s ease;box-shadow:0 6px 20px rgba(0,0,0,.22);z-index:2147483000}',
  '.dsh-pet-cfg [data-tip]:hover::after{display:block;opacity:1;visibility:visible}',
  '.dsh-pet-cfg [data-tip][data-tip-end]::after{left:auto;right:-4px}',

  // 问号：气泡的一个圆形宿主外观。
  '.dsh-pet-cfg__q{display:inline-flex;align-items:center;justify-content:center;flex:none;width:14px;height:14px;border:1px solid var(--dsw-alias-label-tertiary);border-radius:50%;color:var(--dsw-alias-label-tertiary);font-size:10px;font-style:normal;line-height:1;cursor:help;user-select:none}',

  '.dsh-pet-cfg__btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 14px;font:inherit;font-size:12px;line-height:20px;cursor:pointer;white-space:nowrap}',
  // 实心主按钮必须排除在通用 hover 外：半透明 hover 会顶掉 button-info-fill，让蓝色按钮一悬停就发白；
  // 主按钮的 hover 走主题自己的 button-info-hover。
  '.dsh-pet-cfg__btn:hover:not(:disabled):not(.is-primary){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-pet-cfg__btn:disabled{opacity:.5;cursor:default}',
  '.dsh-pet-cfg__btn.is-primary{border-color:var(--dsw-alias-button-info-fill);background:var(--dsw-alias-button-info-fill);color:#fff}',
  '.dsh-pet-cfg__btn.is-primary:hover:not(:disabled){border-color:var(--dsw-alias-button-info-hover);background:var(--dsw-alias-button-info-hover)}',
  '.dsh-pet-cfg__btn.is-danger{border-color:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary)}',
  '.dsh-pet-cfg__btn.is-sm{padding:2px 10px}',
  '.dsh-pet-cfg__btn.is-ghost{border-style:dashed;color:var(--dsw-alias-label-secondary)}',

  '.dsh-pet-cfg__tabs{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
  '.dsh-pet-cfg__tabsLabel{font-size:12px;color:var(--dsw-alias-label-secondary)}',
  '.dsh-pet-cfg__tab{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 12px;font:inherit;font-size:13px;cursor:pointer}',
  '.dsh-pet-cfg__tab:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-pet-cfg__tab:disabled{opacity:.5;cursor:default}',
  '.dsh-pet-cfg__tab.is-active{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-active)}',
  '.dsh-pet-cfg__tab.is-ghost{border-style:dashed;color:var(--dsw-alias-label-secondary)}',

  '.dsh-pet-cfg__actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}',
  '.dsh-pet-cfg__msg{margin-left:4px;font-size:12px;color:var(--dsw-alias-state-success-primary)}',
  '.dsh-pet-cfg__msg.is-err{color:var(--dsw-alias-state-error-primary)}',
  '.dsh-pet-cfg__note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.dsh-pet-cfg__path{font-size:12px;line-height:18px;word-break:break-all;user-select:text;color:var(--dsw-alias-label-secondary)}',
  '.dsh-pet-cfg__path b{color:var(--dsw-alias-label-primary);font-weight:400}',
  '.dsh-pet-cfg__cmd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Courier New",monospace;font-size:12px;line-height:18px;word-break:break-all;user-select:text;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}',
].join('\n');

const settingsCssTag = 'dsh-pet/settings.css';
/** 注入设置页样式，只注入一次。 */
function injectSettingsCss(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector('style[data-plugin-css="' + settingsCssTag + '"]') !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-pet';
  tag.dataset.pluginCss = settingsCssTag;
  tag.textContent = SETTINGS_CSS;
  document.head.appendChild(tag);
}

/** 选择器浮层里的一行：跟随当前对话、服务商分组头、模型或「该服务商没有可用模型」。 */
type ModelRow =
  | { kind: 'follow'; key: string }
  | { kind: 'group'; key: string; name: string }
  | { kind: 'none'; key: string }
  | { kind: 'model'; key: string; provider: string; model: { id: string; name: string } };

/** 设置页中文文案。 */
export const zh = {
  nav: '桌宠配置',
  intro: '管理多个桌宠：每个宠物可独立设置大小与位置（保存后即时生效）。',
  // 卡片标题与卡片级说明；说明统一进问号气泡。
  petCardTitle: '宠物配置',
  petCardHint:
    '每只宠物独立配置：名字 / 大小 / 显示位置 / 位置 / 偏移 / 四个功能开关。改完点最下面的「保存」即时生效。',
  globalTitle: '全局开关',
  globalHint:
    '所有宠物共用（pet pack 可在自己种类文件里单独覆盖）。这几个开关只改本地状态，随「保存」整包写入用户配置（不做即时写入）；系统通知在保存后即时重读，无需刷新页面。',
  cornerHint: '宠物贴着屏幕的哪个角（桌面端按各自显示器的工作区算）。',
  marginXHint: '距所选角落的水平距离（px），可为任意数字。',
  marginYHint: '距所选角落的垂直距离（px），可为任意数字。',
  // 「/」命令菜单的行标题（图标由 app.ts 经 command-faces.ts 补上）。
  'cmd.chat': '对话',
  'cmd.pet': '桌宠',
  'cmd.balance': '余额',
  petsLabel: '宠物列表',
  add: '添加宠物',
  remove: '删除',
  confirmRemove: '确定删除宠物「{id}」吗？',
  confirmTitle: '确认操作',
  cancel: '取消',
  ok: '知道了',
  atLeastOne: '至少保留一个宠物。',
  emptyPets: '暂无宠物，点击「添加宠物」创建。',
  sizeLabel: '大小（宽度 px）',
  sizeHint: '高度自动 = 宽度 × 9/16。',
  nameLabel: '名字',
  nameHint: '显示名：鼠标悬浮宠物时弹出，也会加进 AI 人设（你的名字是 X）。可重复，留空按宠物 id 处理。',
  personaLabel: '人设（可选）',
  personaHint:
    '只影响这只宠物。留空 = 跟随所属条目的人设——输入框里的灰色文字就是那份内容。实际发给模型的 system = 这段 + 自动追加的「你的名字是“<名字>”」+ 当前时间背景，所以别在这里再写名字和日期。',
  personaCount: '{n} 字',
  balanceEnabled: '余额功能',
  balanceEnabledHint: '启用后该宠物触发余额动画并显示余额气泡。',
  whisperEnabled: '碎碎念',
  whisperEnabledHint: '启用后该宠物按周期用 AI 生成一句话并播碎碎念动画（人设见下方「人设」框，留空跟随条目）。',
  workStatusEnabled: '工作状态联动',
  workStatusEnabledHint:
    '启用后该宠物跟随 DSH 工作状态：思考/工作中/等待确认/完成/出错时自动切对应动画并弹气泡（动画池在配置顶层，仅监听不调用模型）。',
  fixedEnabled: '宠物固定',
  fixedEnabledHint:
    '启用后随机动画不再让宠物自己转向或走开，只播原地待机与随机小动作；右键菜单点播、接口触发、余额/碎碎念/工作状态动画不受影响。',
  displayLabel: '显示位置',
  displayHint: 'web=仅浏览器 / desktop=仅桌面 / both=两者都显示 / none=都不显示',
  'display.web': '仅浏览器',
  'display.desktop': '仅桌面',
  'display.both': '两者都显示',
  'display.none': '都不显示',
  cornerLabel: '位置',
  'corner.top-left': '左上角',
  'corner.top-right': '右上角',
  'corner.bottom-left': '左下角',
  'corner.bottom-right': '右下角',
  marginX: '水平偏移',
  marginY: '垂直偏移',
  save: '保存',
  saveHotkey: 'Ctrl+S / Cmd+S',
  sync: '同步',
  confirmSync: '确定同步吗？将用项目内置的默认配置（完整字段 + 注释）覆盖用户配置，当前的自定义内容会丢失。',
  corruptTitle: '用户配置已损坏，未保存',
  corruptConfirm: '强行保存',
  corruptBody:
    '用户配置文件解析不了（内容已损坏，不是合法 JSON/JSONC）：{path}。继续保存会按白名单重建这个文件——它里面现有的内容（animations / physics / memes 等自定义字段）会全部丢失。取消 = 不动文件（先去把配置改回合法再保存）；确认 = 强行保存（丢弃文件里现有的内容）。',
  syncHint:
    '「同步」会把项目内置的默认配置（含注释与全部高级字段）写入用户配置文件，覆盖当前自定义内容；之后可直接编辑该文件。注意两点：① 文件一旦生成即为显式覆盖层——插件升级后内置默认的变化不会自动生效（除非再次同步或删除该文件）；② 在本页点「保存」会按白名单重写该文件（字段值保留，但注释会被去掉）。',
  configMeta: '高级配置（文件）',
  configMetaHint:
    '用户配置可覆盖宠物列表 / 动画池 / 播放权重，修改后刷新或重启生效：浏览器端刷新页面，桌面端右键宠物 →「重载配置」（重载全部桌面宠物窗口）；默认配置为完整参考。',
  defaultConfig: '默认配置（只读，完整参考）',
  userConfig: '用户配置（自定义覆盖）',
  animationDir: '动画素材目录（可自定义/扩充动画）',
  memesDir: '表情包目录（可自定义/扩充配图）',
  logFile: '日志文件（排障用，可清空）',
  logFileNote:
    '桌面版没有控制台，插件的运行日志（启动、桌面宠物崩溃/重启、错误与告警）全部写进这一个文件；反馈问题请附上它。单文件上限 1 MB，写满只留最新的 512 KB。',
  saved: '已保存，桌宠即时生效。',
  loadError: '加载配置失败',
  saveError: '保存配置失败，请检查服务连接、配置目录的写入权限或服务日志。',
  saveInvalid: '保存配置失败：配置内容无效，请检查后重试。',
  syncError: '同步配置失败，请检查服务连接和配置目录的写入权限。',
  loading: '正在加载配置…',
  retry: '重试',
  invalid: '请检查输入：大小需为正数，边距可为任意数字。',
  busy: '保存中…',
  extraPetsHint:
    '另 {n} 只额外宠物由 pet/ 目录文件定义（<名>-config.json + <名>-animation/ + <名>-memes/），它们不在此列表——改文件后浏览器刷新页面、桌面端右键「重载配置」即可生效。',
  notifyToggle: '系统通知',
  notifyToggleHint: '对话完成 / 生成失败 / 权限申请 / 用户选择，在窗口失焦时弹出系统级通知（桌面右下角）。',
  clickSoundToggle: '点击音效',
  clickSoundToggleHint:
    '点一下宠物播一声内置音效（assets/sound/click-duck.wav，音量 0.5；100ms 内的连续点击只响一次，多开也不会叠音）。关掉即完全静音。随「保存」写入用户配置。',
  whisperImageToggle: '碎碎念配图',
  whisperImageToggleHint:
    '碎碎念时从表情包池随机抽一张，连同那句话一起显示（图片映射在配置文件顶层 memes）。token：碎碎念本来就每次生成都要调一次模型，配图只是把抽中那张的名称+描述（约 100 字符 / ≈60 token）加进同一次请求，增量可忽略。',
  chatImageToggle: '对话配图',
  chatImageToggleHint:
    '对话时由 AI 按当前语境从表情包池挑一张配图（可不挑；图片映射在配置文件顶层 memes）。token：每条消息都要把整张清单附进请求，当前约 1.1k 字符（≈650 token，约碎碎念配图的 11 倍），并随图片数量线性增长；关掉则一个字符都不附。',
  confineToggle: '锁定在当前屏幕',
  confineToggleHint:
    '多屏用户：开了之后宠物只在当前所在那块屏幕内活动——甩出去的宠物只在松手时所在那块屏内弹（屏缝当墙，不飞到隔壁屏），自主漫游也只在当前所在那块屏内走（越出屏缝的那一步直接取消）。关掉则照常跨屏飞行 / 跨屏行走。只影响桌面模式——浏览器 overlay 本来就只在视口内活动。',
  trayToggle: '系统托盘',
  trayToggleHint:
    '桌面模式启动后在通知区域（macOS 为菜单栏）常驻一个图标，列出配置里的全部宠物，勾选就能切换显示位置——包括当前不在桌面、没有窗口可右键的那些。关掉之后要把宠物叫回桌面，只能开浏览器用设置页，或在网页端那只宠物身上右键。Windows 本来就会把它折叠进「隐藏的图标」面板。仅影响桌面模式。',
  physicsTitle: '物理（拖拽抛掷手感）',
  physicsHint:
    '全局默认，所有宠物共用（pet pack 可在自己种类文件里单独覆盖）；随「保存」写入用户配置（不做即时写入）。浏览器保存后即时生效，桌面端由保存重载宠物窗口后生效。',
  'physics.gravity': '重力 gravity',
  'physics.gravityHint': 'px/s²，越大落得越快；0 = 无重力（抛出去匀速直线飞）',
  'physics.restitution': '弹性 restitution',
  'physics.restitutionHint': '0~1，碰壁 / 落地反弹保留的速度比例（1 = 完全弹性，0 = 撞上即停）',
  'physics.groundFriction': '地面摩擦 groundFriction',
  'physics.groundFrictionHint': '/s，落地后水平速度的衰减率；0 = 冰面不减速',
  'physics.throwPower': '总力度 throwPower',
  'physics.throwPowerHint': '> 0，弹簧跟手与甩出初速的整体倍率（1 = 默认；越大越跟手、甩得越猛）',
  physicsCeilingBounce: '顶部反弹 ceilingBounce',
  physicsCeilingBounceHint: '关掉后抛掷可飞出屏幕顶部（重力仍会把它拉回来）',
  physicsPetCollision: '宠物互撞 petCollision',
  physicsPetCollisionHint: '飞行中的宠物撞到别的宠物按动量守恒弹开（质量 ∝ 尺寸²）',
  invalidPhysics: '请检查物理参数：重力 / 地面摩擦 ≥ 0，弹性 0~1，总力度 > 0。',
  fontTitle: '外观与字体',
  fontHint:
    '字体种类作用于现在用软糖体的全部文字：宠物气泡、悬浮提示、对话窗、得分弹窗；字号只作用于宠物气泡与悬浮提示（对话窗与得分弹窗的字号不变）。全局默认，所有宠物共用（pet pack 可在自己种类文件里单独覆盖）；随「保存」写入用户配置，浏览器保存后即时生效，桌面端由保存重载宠物窗口后生效。',
  fontFamilyLabel: '字体',
  fontFamilyHint:
    '「软糖体（内置）」随插件提供；其余为系统字体，机器上没装时自动回退到字体栈里的下一个（不会空白或报错）。',
  fontSizeLabel: '字号（px）',
  fontSizeHint: '气泡正文字号；悬浮提示与气泡内的小字按既有比例派生。范围 4~200。',
  fontFollowToggle: '字号随宠物大小缩放',
  fontFollowToggleHint:
    '开启（默认）：宠物调大时字号等比放大，462 宽时正好是上面设定的字号；关闭：字号恒定，不随宠物大小变化。',
  invalidFont: '请检查字体设置：字体需在下拉列表内，字号需为 4~200 的数字。',
  'font.candy': '软糖体（内置）',
  'font.yahei': '微软雅黑 / 苹方',
  'font.youyuan': '幼圆',
  'font.kaiti': '楷体',
  'font.simsun': '宋体',
  'font.comic': '漫画体',
  'font.system': '系统默认',
  modelTitle: 'AI 模型与对话上下文',
  modelHint:
    '碎碎念与对话各自用哪个模型，以及对话每次带多少历史进上下文。选「跟随当前对话」= 用你当前对话正在用的那个模型（默认）。全局默认：对所有宠物生效，pet pack 可在自己种类文件里单独覆盖。选项与 DSH 的模型选择器同源，由宿主实时提供。',
  modelFollow: '跟随当前对话',
  modelSearch: '搜索模型…',
  modelEmpty: '没有匹配的模型。',
  modelNoModels: '没有可用的模型。',
  modelLoading: '正在刷新模型列表…',
  modelTriggerAria: '选择模型，当前 {model}',
  modelUnknown: '（当前配置，不在列表中）',
  modelNone: '该服务商没有可用模型',
  whisperModelLabel: '碎碎念模型',
  chatModelLabel: '对话模型',
  modelFieldHint: '选「跟随当前对话」= 用当前对话的模型；指定了但调用失败会自动回落到当前对话的模型重试一次。',
  invalidModel: '请检查模型设置：服务商与模型要么都选，要么都留空（跟随当前对话）。',
  modelCatalogFailed: '模型列表加载失败（刷新页面可重试）；当前配置值仍会原样保留。',
  chatMemory: '对话历史条数',
  chatMemoryHint:
    '每次对话请求携带的最近历史轮数（1 轮 = 1 问 1 答；0 = 不带历史，每句都是全新对话）。对话记忆本身全存不删，此值只决定截多少进上下文——越大越记得住，也越费 token。全局默认，所有宠物共用（pet pack 可在自己种类文件里单独覆盖）。',
  invalidChatMemory: '请检查对话历史条数：需为 ≥ 0 的数字。',
  chatImageLimit: '对话配图张数上限',
  chatImageLimitHint:
    '对话时发给模型的表情包清单最多几张（「前 N 张」= 配置里写在前面的那 N 条，想让哪几张优先被发出去就把顺序往前挪）。整张清单是每条消息都要附的，token 随张数线性增长——张数一多就是纯烧钱，限制成前 N 张，模型只从这几张里挑。0 = 不限制（全部发）。内置默认 10。全局默认，所有宠物共用（pet pack 可在自己种类文件里覆盖）。只影响对话选图：碎碎念只带抽中的那一张。',
  invalidChatImageLimit: '请检查对话配图张数上限：需为 ≥ 0 的数字（0 = 不限制）。',
  notifyTest: '测试弹窗',
  notifyTestOk: '测试通知已发送，请查看桌面右下角。',
  notifyDenyUnsupported: '当前环境不支持系统通知（浏览器无 Notification API）。',
  notifyDenyBlocked: '通知权限已被浏览器标记为「阻止」。',
  notifyDenyRejected: '你在权限询问弹窗中选择了「阻止」。',
  notifyDenyError: '申请权限时出错',
  notifyGuide: '引导：点击地址栏左侧 🔒/ⓘ →「网站设置」→「通知」→ 改为「允许」，刷新页面后重试。',
  storageTitle: '卸载与存储',
  storageHint: '插件在本机落下的全部位置。删缓存不影响使用（会自动重下/重建）；删「插件用户数据」会丢配置与对话记忆。',
  'storage.userData':
    '插件用户数据：自定义配置 main-config.jsonc、对话记忆 memory.json、自定义动画素材 main-animation/、文件宠物 pet/',
  'storage.electron': '桌面宠物用的 Electron 运行时（体积较大；删除后下次启用桌面模式会自动重新下载）',
  'storage.desktopCache': '桌面宠物窗口的缓存与主屏缩放缓存（可删，会自动重建）',
  'storage.electronCache': 'Electron 安装包下载缓存（可删，需要时会重新下载）',
  'storage.package': '插件本体（由 DSH 管理，用下面的卸载命令移除，不要手删）',
  storageMissing: '（尚未创建）',
  uninstallTitle: '卸载方法',
  uninstallStep1: '1. 先退出 DSH（桌面宠物随之退出）；不要在桌宠运行时删除上面的文件。',
  uninstallStep2: '2. 卸载插件本体（终端执行，会同时从 profile 的 bundle 层移除）：',
  uninstallStep3:
    '3. 按需删除上面的位置：缓存类删了无影响；「插件用户数据」删了会丢配置与对话记忆（想保留就先备份其中的 main-config.jsonc）。',
  uninstallCmd: 'dsh plugin --profile {profile} remove dsh-pet',
};

/** 设置页英文文案。 */
export const en = {
  nav: 'Pet Config',
  intro: 'Manage multiple pets: each pet has its own size and position (applies instantly after saving).',
  // 卡片标题与卡片级说明；说明统一进问号气泡。
  petCardTitle: 'Pet',
  petCardHint:
    'Per-pet settings: name / size / display / corner / offsets / the four feature switches. Click "Save" at the bottom to apply instantly.',
  globalTitle: 'Global switches',
  globalHint:
    'Shared by every pet (a pet pack may override them in its own kind file). These switches only change local state and are written to the user config on "Save" (never written immediately); system notifications re-read right after saving, no page refresh needed.',
  cornerHint: 'Which screen corner the pet sticks to (per-monitor work area in desktop mode).',
  marginXHint: 'Horizontal distance from the chosen corner (px); any number.',
  marginYHint: 'Vertical distance from the chosen corner (px); any number.',
  // 「/」命令菜单的行标题（图标由 app.ts 补上）。
  'cmd.chat': 'Chat',
  'cmd.pet': 'Pet',
  'cmd.balance': 'Balance',
  petsLabel: 'Pets',
  add: 'Add pet',
  remove: 'Remove',
  confirmRemove: 'Delete pet "{id}"?',
  confirmTitle: 'Confirm action',
  cancel: 'Cancel',
  ok: 'Got it',
  atLeastOne: 'Keep at least one pet.',
  emptyPets: 'No pets yet — click "Add pet" to create one.',
  sizeLabel: 'Size (width px)',
  sizeHint: 'Height is automatic = width × 9/16.',
  nameLabel: 'Name',
  nameHint:
    'Shown on hover and added to AI personas ("your name is X"). Duplicates allowed; empty falls back to the pet id.',
  personaLabel: 'Persona (optional)',
  personaHint:
    'Applies to this pet only. Leave empty to follow the entry persona — the grey text inside the box is exactly that. The system prompt actually sent = this text + an appended 「your name is "<name>"」 line + the current time context, so do not repeat the name or the date here.',
  personaCount: '{n} chars',
  balanceEnabled: 'Balance',
  balanceEnabledHint: 'When enabled, this pet plays balance animations and shows the balance bubble.',
  whisperEnabled: 'Whisper',
  whisperEnabledHint:
    'When enabled, this pet periodically generates a line via AI and plays the whisper animation (persona = the field below; empty follows the entry).',
  workStatusEnabled: 'Work status',
  workStatusEnabledHint:
    'When enabled, this pet follows DSH work state: thinking / working / waiting / done / error switch animations and show bubbles (pool in top-level config; listening only, no model calls).',
  fixedEnabled: 'Pin in place',
  fixedEnabledHint:
    'When enabled, the random chain no longer turns this pet or walks it away — only idle and in-place actions play. Right-click picks, API triggers and balance / whisper / work-status animations are unaffected.',
  displayLabel: 'Display',
  displayHint: 'web = browser only / desktop = desktop only / both = both / none = neither',
  'display.web': 'Browser only',
  'display.desktop': 'Desktop only',
  'display.both': 'Both',
  'display.none': 'Neither',
  cornerLabel: 'Position',
  'corner.top-left': 'Top-left',
  'corner.top-right': 'Top-right',
  'corner.bottom-left': 'Bottom-left',
  'corner.bottom-right': 'Bottom-right',
  marginX: 'Horizontal offset',
  marginY: 'Vertical offset',
  save: 'Save',
  saveHotkey: 'Ctrl+S / Cmd+S',
  sync: 'Sync',
  confirmSync:
    'Sync? This overwrites the user config with the bundled default config (all fields + comments); current customizations are lost.',
  corruptTitle: 'User config is corrupted — not saved',
  corruptConfirm: 'Save anyway',
  corruptBody:
    'The user config file cannot be parsed (corrupted, not valid JSON/JSONC): {path}. Saving now rebuilds it from the whitelist — everything currently in that file (animations / physics / memes …) will be lost. Cancel = leave the file untouched (fix it and save again); Confirm = save anyway (discard what is in the file).',
  syncHint:
    '"Sync" writes the bundled default config (comments + every advanced field included) to the user config file, overwriting your current customizations; the file is then directly editable. Two caveats: (1) once created, that file is an explicit override layer — later changes to the bundled defaults will not take effect automatically (until you sync again or delete the file); (2) clicking "Save" on this page rewrites the file from a whitelist — field values are kept, comments are dropped.',
  configMeta: 'Advanced (files)',
  configMetaHint:
    'User config may override pets / animation pools / weights — refresh or restart to apply: refresh the page in the browser, or right-click a desktop pet → "Reload config" (rebuilds every desktop pet window). The default config is the complete reference.',
  defaultConfig: 'Default config (read-only, complete reference)',
  userConfig: 'User config (custom overrides)',
  animationDir: 'Animation assets dir (add/customize animations here)',
  memesDir: 'Meme images dir (add/customize images here)',
  logFile: 'Log file (for troubleshooting; safe to clear)',
  logFileNote:
    'The DSH desktop app has no console, so every runtime log of the plugin (startup, desktop pet crashes/restarts, errors and warnings) goes into this single file — attach it when reporting a problem. It is capped at 1 MB; once full, only the latest 512 KB is kept.',
  saved: 'Saved — the pets updated instantly.',
  loadError: 'Failed to load config',
  saveError:
    'Failed to save config. Check the server connection, configuration directory write permissions and server log.',
  saveInvalid: 'Failed to save config: invalid configuration. Check the values and try again.',
  syncError: 'Failed to sync config. Check the server connection and configuration directory write permissions.',
  loading: 'Loading config…',
  retry: 'Retry',
  invalid: 'Check your input: size must be positive; margins can be any number.',
  busy: 'Saving…',
  extraPetsHint:
    '{n} extra pet(s) are file-defined in the pet/ directory (<name>-config.json + <name>-animation/ + <name>-memes/). They are not in this list — after editing the files, refresh the page (browser) or right-click a desktop pet → "Reload config".',
  notifyToggle: 'System notifications',
  notifyToggleHint:
    'OS-level toasts (bottom-right of the desktop) for conversation completion, failures, permission requests, and questions — only while this window is unfocused.',
  clickSoundToggle: 'Click sound',
  clickSoundToggleHint:
    'Plays the built-in click sound (assets/sound/click-duck.wav, volume 0.5) when a pet is clicked; repeated clicks within 100ms play only once, so multiple pets never stack up. Turn it off for silence. Written to the user config together with Save.',
  whisperImageToggle: 'Whisper images',
  whisperImageToggleHint:
    'Attach one random meme from the pool to each whisper line (image mapping lives in the top-level `memes` config field). Tokens: a whisper already calls the model every cycle, so the image only appends the name + description of that one meme (~100 chars / ~60 tokens) to the same request — negligible.',
  chatImageToggle: 'Chat images',
  chatImageToggleHint:
    'Let the AI pick one meme from the pool that fits the current context (optional; mapping lives in the top-level `memes` config field). Tokens: every message carries the whole catalog — currently ~1.1k chars (~650 tokens, about 11x the whisper case) and growing with the number of images; turning this off appends nothing at all.',
  confineToggle: 'Lock to the current screen',
  confineToggleHint:
    'Multi-monitor: when on, the pet stays inside the screen it is currently on — a thrown pet bounces only inside the screen it was released on (screen seams act as walls, so it never flies to the neighbouring monitor), and autonomous wandering only walks within the screen it is currently on (a step that would cross the seam is simply cancelled). Turn this off to let it cross screens as usual. Desktop only — the browser overlay always stays inside the viewport anyway.',
  trayToggle: 'System tray',
  trayToggleHint:
    'Shows a tray icon (notification area on Windows, menu bar on macOS) once desktop mode is running. It lists every pet in the config and toggles each one between desktop and web/none — including pets that are currently off the desktop and therefore have no window to right-click. With it off, bringing a pet back to the desktop requires opening the browser (the settings page, or right-clicking a web pet there). Windows already folds third-party icons into the "hidden icons" overflow. Desktop mode only.',
  physicsTitle: 'Physics (drag & throw feel)',
  physicsHint:
    'Global default, shared by every pet (a pet pack may override it in its own kind file); written to the user config on "Save" (never written immediately). Applies instantly in the browser; on the desktop it applies once Save reloads the pet windows.',
  'physics.gravity': 'Gravity',
  'physics.gravityHint': 'px/s² — the higher, the faster it falls; 0 = weightless (flies straight forever)',
  'physics.restitution': 'Bounciness',
  'physics.restitutionHint':
    '0–1, speed kept when bouncing off a wall or the floor (1 = perfectly elastic, 0 = stops dead)',
  'physics.groundFriction': 'Ground friction',
  'physics.groundFrictionHint': 'per second, horizontal damping while on the ground; 0 = frictionless ice',
  'physics.throwPower': 'Throw power',
  'physics.throwPowerHint':
    '> 0, overall multiplier for spring tracking and release speed (1 = default; higher = tighter tracking, harder throws)',
  physicsCeilingBounce: 'Ceiling bounce',
  physicsCeilingBounceHint:
    'Turn this off to let a throw fly out through the top of the screen (gravity still pulls it back)',
  physicsPetCollision: 'Pet collisions',
  physicsPetCollisionHint: 'A flying pet bounces off the others with momentum conservation (mass ∝ size²)',
  invalidPhysics: 'Check the physics values: gravity / ground friction ≥ 0, bounciness 0–1, throw power > 0.',
  fontTitle: 'Appearance & font',
  fontHint:
    'The family applies to every place that currently uses the candy font: pet bubble, hover tooltip, chat popup, score popup. The size applies only to the pet bubble and the hover tooltip (chat and score popups keep their own size). Global default, shared by every pet (a pet pack may override it in its own kind file); written to the user config on "Save" — instant in the browser, and on the desktop it applies once Save reloads the pet windows.',
  fontFamilyLabel: 'Font',
  fontFamilyHint:
    '"Candy (bundled)" ships with the plugin; the others are system fonts. If a font is missing on this machine, it falls back to the next one in the stack (never blank, never an error).',
  fontSizeLabel: 'Font size (px)',
  fontSizeHint:
    'Bubble body text size; the tooltip and the smaller lines inside the bubble scale proportionally. Range 4–200.',
  fontFollowToggle: 'Scale font with pet size',
  fontFollowToggleHint:
    'On (default): the font grows with the pet — at 462 px width it is exactly the size above. Off: the size stays fixed regardless of pet size.',
  invalidFont:
    'Check the font settings: the family must be in the list and the size must be a number between 4 and 200.',
  'font.candy': 'Candy (bundled)',
  'font.yahei': 'Microsoft YaHei / PingFang',
  'font.youyuan': 'YouYuan',
  'font.kaiti': 'KaiTi',
  'font.simsun': 'SimSun',
  'font.comic': 'Comic Sans MS',
  'font.system': 'System default',
  modelTitle: 'AI models & chat context',
  modelHint:
    'Which model each of whisper and chat uses, and how much history every chat request carries. "Follow current conversation" uses the model your current conversation is on (default). Global default: applies to every pet, and a pet pack may override it in its own kind file. The options come from the same source as the DSH model picker, served live by the host.',
  modelFollow: 'Follow current conversation',
  modelSearch: 'Search models…',
  modelEmpty: 'No matching models.',
  modelNoModels: 'No models available.',
  modelLoading: 'Refreshing model list…',
  modelTriggerAria: 'Select model, current {model}',
  modelUnknown: ' (current config, not in the list)',
  modelNone: 'No models available for this provider',
  whisperModelLabel: 'Whisper model',
  chatModelLabel: 'Chat model',
  modelFieldHint:
    '"Follow current conversation" uses the conversation model; if a chosen model fails, the plugin falls back to the conversation model and retries once.',
  invalidModel:
    'Check the model settings: pick both a provider and a model, or leave both empty (follow the current conversation).',
  modelCatalogFailed:
    'Failed to load the model list (refresh the page to retry); your current values are kept as they are.',
  chatMemory: 'Chat history rounds',
  chatMemoryHint:
    'How many recent rounds each chat request carries (1 round = 1 question + 1 answer; 0 = no history, every message starts fresh). The memory itself keeps everything — this only decides how much goes into the context: higher remembers more and costs more tokens. Global default, shared by every pet (a pet pack may override it in its own kind file).',
  invalidChatMemory: 'Check the chat history rounds: it must be a number ≥ 0.',
  chatImageLimit: 'Chat image limit',
  chatImageLimitHint:
    'How many memes at most are listed to the model during chat ("first N" = the first N you wrote in the config, so move the ones you want sent to the front). That whole list is attached to every message and tokens grow linearly with the count, so a long list is pure burn; capping it to the first N makes the model pick only among those. 0 = no limit (send everything). Built-in default 10. Global default, shared by every pet (a pet pack may override it in its own kind file). Chat only — a whisper carries just the one meme it drew.',
  invalidChatImageLimit: 'Check the chat image limit: it must be a number ≥ 0 (0 = no limit).',
  notifyTest: 'Test notification',
  notifyTestOk: 'Test notification sent — check the bottom-right of your desktop.',
  notifyDenyUnsupported: 'System notifications are not supported in this environment (no Notification API).',
  notifyDenyBlocked: 'Notification permission is blocked by the browser.',
  notifyDenyRejected: 'You chose "Block" in the permission prompt.',
  notifyDenyError: 'Failed to request permission',
  notifyGuide:
    'Guide: click the 🔒/ⓘ icon next to the address bar → Site settings → Notifications → set to "Allow", then refresh and retry.',
  storageTitle: 'Uninstall & storage',
  storageHint:
    'Every location this plugin writes to. Deleting cache folders is harmless (they re-download / rebuild); deleting "plugin user data" loses your config and chat memory.',
  'storage.userData':
    'Plugin user data: custom config main-config.jsonc, chat memory memory.json, custom animation assets main-animation/, file pets pet/',
  'storage.electron':
    'Electron runtime used by the desktop pet (large; re-downloaded automatically the next time desktop mode starts)',
  'storage.desktopCache':
    'Desktop pet window cache and primary-monitor scale cache (safe to delete, rebuilt automatically)',
  'storage.electronCache': 'Electron installer download cache (safe to delete, re-downloaded when needed)',
  'storage.package': 'The plugin itself (managed by DSH — remove it with the command below instead of deleting it)',
  storageMissing: ' (not created yet)',
  uninstallTitle: 'How to uninstall',
  uninstallStep1:
    '1. Quit DSH first (the desktop pet exits with it); do not delete these files while the pet is running.',
  uninstallStep2: '2. Remove the plugin itself (run in a terminal; this also drops it from the profile bundle layer):',
  uninstallStep3:
    '3. Delete the locations above as needed: cache folders are harmless; deleting "plugin user data" loses your config and chat memory (back up main-config.jsonc first if you want to keep it).',
  uninstallCmd: 'dsh plugin --profile {profile} remove dsh-pet',
};

/**
 * 制造「桌宠配置」设置页组件。
 * 浏览器半侧是 `__ModuleLoader__` 单文件形态，react 能力只能由宿主在运行时注入，
 * 因此以工厂接收依赖，造出组件后再注册进设置页插槽。
 * @param rt - 运行时注入的依赖：`h`、hooks 与翻译函数 `t`。
 * @returns 设置页组件；`close` 由设置页外壳提供，本页未使用。
 */
export function makePetConfigSection(rt: {
  h: typeof jsx;
  useState: <T>(init: T) => [T, Dispatch<SetStateAction<T>>];
  // 用 React 命名空间类型而非 typeof：type-only import 的 hook 无法进入声明导出（TS4078）
  useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
  useRef: <T>(initial: T) => ReactNS.MutableRefObject<T>;
  useCallback: typeof ReactNS.useCallback;
  t: (key: string) => string;
}): FunctionComponent<{ close?: () => void }> {
  const { h, useState, useEffect, useRef, useCallback, t } = rt;

  // 样式注入幂等，重复渲染不会重复插入。
  injectSettingsCss();

  const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const cornerLabel = (c: Corner): string => t('corner.' + c);

  const inputClass = 'dsh-pet-cfg__inp';

  /** 等宽字体栈（路径与命令展示用），走系统栈以免多拉一份资源。 */
  const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace';

  /** 生成一个未占用的宠物 id（pet-2、pet-3…）。 */
  const nextId = (list: Pet[]): string => {
    let n = 2;
    for (; ; n++) {
      const id = 'pet-' + n;
      if (!list.some((p) => p.id === id)) return id;
    }
  };

  /**
   * 悬浮说明的展开属性：带 `data-tip` 即悬浮出气泡（CSS 的 `[data-tip]::after`）。
   * 返回属性而不包一层 DOM，避免打乱外层 flex 的 gap / 对齐 / 拉伸；hover 与过渡只能由 CSS 表达。
   * @param text - 说明正文（已翻译）。
   * @param end - 气泡右对齐，给栅格最右列或贴右缘的元素用。
   */
  const tip = (text: string, end = false): Record<string, string> =>
    end ? { 'data-tip': text, 'data-tip-end': '' } : { 'data-tip': text };

  /**
   * 问号说明入口：气泡的一个圆形触发元素，文字仍走 `tip()`。
   * 用 `<i>` 而不是 `<button>`：它只展示说明，点了不该有行为，也不该进 Tab 顺序。
   */
  const q = (text: string, end = false): ReturnType<typeof h> =>
    h('i', {
      className: 'dsh-pet-cfg__q',
      ...tip(text, end),
      'aria-label': text,
      role: 'img',
      children: '?',
    });

  /** 卡片头：标题与问号说明；右侧动作由调用方自行追加。 */
  const cardHead = (title: string, tip?: string, end = false): ReturnType<typeof h> =>
    h('div', {
      className: 'dsh-pet-cfg__cardHead',
      children: [
        h('span', { key: 't', className: 'dsh-pet-cfg__cardTitle', children: title }),
        tip ? q(tip, end) : null,
      ],
    });

  /** 一个字段：标签（可带问号）在上、控件在下。 */
  const field = (label: string, control: ReturnType<typeof h>, tip?: string, end = false): ReturnType<typeof h> =>
    h('div', {
      className: 'dsh-pet-cfg__field',
      children: [
        h('span', {
          key: 'l',
          className: 'dsh-pet-cfg__flabel',
          children: tip ? [label, q(tip, end)] : label,
        }),
        control,
      ],
    });

  /**
   * 开关的一格：勾选框、标题与问号；说明挂在问号上，点标题只切开关。
   */
  const toggleCell = (
    label: string,
    value: boolean,
    disabled: boolean,
    onToggle: (v: boolean) => void,
    end = false,
  ): ReturnType<typeof h> =>
    h('div', {
      className: 'dsh-pet-cfg__toggle',
      children: [
        h('label', {
          key: 'l',
          children: [
            h('input', {
              key: 'i',
              type: 'checkbox',
              checked: value,
              disabled,
              onChange: (e: ChangeEvent<HTMLInputElement>) => onToggle(e.target.checked),
            }),
            h('span', { key: 't', children: t(label) }),
          ],
        }),
        q(t(label + 'Hint'), end),
      ],
    });

  /**
   * 「模型」单下拉选择器（碎碎念 / 对话各一个实例）：触发器 + 浮层（搜索 + 按服务商分组的清单）。
   * 无障碍语义、浮层定位与搜索规则都对齐 DSH 自己的模型选择器；数据同源于 `GET /models`。
   * 不用两个 `<select>`：既占地方，又容易留下只选了服务商没选模型的非法组合；也不提供手填模型 id 的退路。
   * 定义在工厂作用域：组件类型必须跨渲染稳定，否则浮层状态（打开 / 搜索词 / 高亮）每次渲染都会丢。
   */
  const ModelPicker: FunctionComponent<{
    label: string;
    value: ModelSelection;
    disabled: boolean;
    catalog: ModelCatalogGroup[] | null;
    failed: boolean;
    onChange: (v: ModelSelection) => void;
  }> = (props) => {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    // 高亮行（键盘 ↑↓ 走的就是它；只停在可选项上）
    const [active, setActive] = useState(0);
    // 浮层位置：打开时按触发器实测一次，空间不够就翻到上方（DSH 也是实测 + 视口钳制）
    const [pos, setPos] = useState<null | {
      left: number;
      top?: number;
      bottom?: number;
      width: number;
      maxHeight: number;
    }>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);

    const groups = props.catalog ?? [];
    const group = groups.find((g) => g.id === props.value.provider);
    const picked = group?.models.find((m) => m.id === props.value.model);
    const isFollow = props.value.provider === '';
    const triggerLabel = isFollow ? t('modelFollow') : (picked?.name ?? props.value.model);
    // 当前配置不在清单里（服务商下线 / 模型下架）时如实标注，绝不显示成别的模型
    const triggerSub = isFollow ? '' : (group?.name ?? props.value.provider + t('modelUnknown'));

    // 搜索：大小写不敏感的有序子序列（与 DSH 同款语义）
    const q = query.trim().toLowerCase();
    const hit = (text: string): boolean => {
      if (q === '') return true;
      let i = 0;
      for (const ch of text.toLowerCase()) {
        if (ch === q[i]) i += 1;
        if (i >= q.length) return true;
      }
      return false;
    };
    // 行清单：跟随当前对话（只在没搜索词时出现，它不是模型）+ 服务商分组头 + 该组命中的模型
    const rows: ModelRow[] = [];
    if (q === '') rows.push({ kind: 'follow', key: '__follow' });
    for (const g of groups) {
      const models = g.models.filter((m) => hit(m.name + ' ' + m.id));
      if (models.length === 0 && !(q === '' && g.models.length === 0)) continue;
      rows.push({ kind: 'group', key: g.id, name: g.name });
      if (models.length === 0) {
        rows.push({ kind: 'none', key: g.id + '/__none' });
        continue;
      }
      for (const m of models) rows.push({ kind: 'model', key: g.id + '/' + m.id, provider: g.id, model: m });
    }
    // 可选项（分组头 / 提示行不参与键盘走动）
    const selectable = rows.map((r, i) => (r.kind === 'group' || r.kind === 'none' ? -1 : i)).filter((i) => i >= 0);

    const commit = (v: ModelSelection): void => {
      props.onChange(v);
      setOpen(false);
      setQuery('');
    };
    const pick = (row: ModelRow | undefined): void => {
      if (!row) return;
      if (row.kind === 'follow') commit({ provider: '', model: '' });
      else if (row.kind === 'model') commit({ provider: row.provider, model: row.model.id });
    };
    const step = (dir: number): void => {
      if (selectable.length === 0) return;
      const at = selectable.indexOf(active);
      const next = selectable[at < 0 ? 0 : (at + dir + selectable.length) % selectable.length];
      setActive(next);
      panelRef.current?.querySelector('[data-row="' + next + '"]')?.scrollIntoView({ block: 'nearest' });
    };

    useEffect(() => {
      if (!open) return;
      const el = rootRef.current;
      // 定位 + 关闭时机：与 DSH 一致——浮层脱离文档流实测定位，滚动/缩放跟着走，点外面或 Esc 关
      const place = (): void => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        const below = window.innerHeight - r.bottom - 12;
        const above = r.top - 12;
        const width = Math.min(Math.max(r.width, 240), Math.max(200, Math.min(420, window.innerWidth - 16)));
        const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
        const up = below < 240 && above > below;
        setPos(
          up
            ? { left, bottom: window.innerHeight - r.top + 4, width, maxHeight: Math.min(360, above) }
            : { left, top: r.bottom + 4, width, maxHeight: Math.min(360, below) },
        );
      };
      place();
      // 打开即聚焦搜索框（DSH 同样把焦点交给搜索）
      panelRef.current?.querySelector('input')?.focus();
      const onDown = (e: MouseEvent): void => {
        const target = e.target as Node | null;
        if (target && (rootRef.current?.contains(target) === true || panelRef.current?.contains(target) === true)) {
          return;
        }
        setOpen(false);
      };
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') setOpen(false);
      };
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', place, true);
      window.addEventListener('resize', place);
      return () => {
        document.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('scroll', place, true);
        window.removeEventListener('resize', place);
      };
    }, [open]);

    const toggle = (): void => {
      if (props.disabled) return;
      if (!open) {
        setQuery('');
        // 打开时高亮停在当前选择上（DSH 打开菜单也是先定位到已选项）
        const at = rows.findIndex(
          (r) => r.kind === 'model' && r.provider === props.value.provider && r.model.id === props.value.model,
        );
        setActive(at >= 0 ? at : 0);
      }
      setOpen(!open);
    };

    const searchRow = h('input', {
      key: 'search',
      type: 'text',
      className: 'dsh-pet-mp__search',
      role: 'searchbox',
      placeholder: t('modelSearch'),
      'aria-label': t('modelSearch'),
      value: query,
      disabled: props.disabled,
      onChange: (e: ChangeEvent<HTMLInputElement>) => {
        setQuery(e.target.value);
        setActive(selectable.length > 0 ? selectable[0] : 0);
      },
      onKeyDown: (e: ReactNS.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          step(1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          step(-1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          pick(rows[active]);
        }
      },
    });

    const rowNode = (row: ModelRow, index: number): ReturnType<typeof h> => {
      if (row.kind === 'group') {
        return h('div', { key: row.key, className: 'dsh-pet-mp__group', children: row.name });
      }
      if (row.kind === 'none') {
        return h('div', { key: row.key, className: 'dsh-pet-mp__status', children: t('modelNone') });
      }
      const checked =
        row.kind === 'follow' ? isFollow : props.value.provider === row.provider && props.value.model === row.model.id;
      return h('button', {
        key: row.key,
        type: 'button',
        role: 'menuitemradio',
        'aria-checked': checked,
        'data-row': index,
        className: 'dsh-pet-mp__item' + (index === active ? ' is-active' : ''),
        disabled: props.disabled,
        onClick: () => pick(row),
        onMouseMove: () => setActive(index),
        children: [
          h('span', {
            key: 'n',
            className: 'dsh-pet-mp__name',
            children: row.kind === 'follow' ? t('modelFollow') : row.model.name,
          }),
          h('span', { key: 'c', className: 'dsh-pet-mp__check', children: checked ? '✓' : '' }),
        ],
      });
    };

    return h('div', {
      ref: rootRef,
      className: 'dsh-pet-mp',
      children: [
        h('button', {
          key: 'trigger',
          type: 'button',
          className: 'dsh-pet-mp__trigger',
          disabled: props.disabled,
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          'aria-label': t('modelTriggerAria').replace('{model}', triggerLabel),
          onClick: toggle,
          children: [
            h('span', { key: 'l', className: 'dsh-pet-mp__label', children: triggerLabel }),
            triggerSub ? h('span', { key: 's', className: 'dsh-pet-mp__sub', children: triggerSub }) : null,
            h('span', { key: 'c', className: 'dsh-pet-mp__chevron' + (open ? ' is-open' : ''), children: '▾' }),
          ],
        }),
        open && pos
          ? h('div', {
              key: 'panel',
              ref: panelRef,
              className: 'dsh-pet-mp__panel',
              role: 'menu',
              'aria-label': props.label,
              style: {
                left: pos.left + 'px',
                top: pos.top === undefined ? undefined : pos.top + 'px',
                bottom: pos.bottom === undefined ? undefined : pos.bottom + 'px',
                width: pos.width + 'px',
                maxHeight: pos.maxHeight + 'px',
              },
              children: [
                searchRow,
                props.catalog === null
                  ? h('div', {
                      key: 'loading',
                      className: 'dsh-pet-mp__status',
                      children: props.failed ? t('modelCatalogFailed') : t('modelLoading'),
                    })
                  : rows.length === 0
                    ? h('div', {
                        key: 'empty',
                        className: 'dsh-pet-mp__status',
                        role: 'status',
                        children: groups.length === 0 ? t('modelNoModels') : t('modelEmpty'),
                      })
                    : h('div', {
                        key: 'list',
                        className: 'dsh-pet-mp__list',
                        role: 'group',
                        children: rows.map(rowNode),
                      }),
              ],
            })
          : null,
      ],
    });
  };

  return function PetConfigSection() {
    const initPets = petBridge.current.filter((p) => !p.extra);
    // 文件定义宠物数量（pet/ 目录，不在本编辑列表；仅展示提示）
    const extraCount = petBridge.current.filter((p) => p.extra).length;
    const [pets, setPets] = useState<Pet[]>(initPets.map((p) => ({ ...p, position: { ...p.position } })));
    const [selId, setSelId] = useState<string>(initPets[0]?.id ?? '');
    const [saving, setBusy] = useState(false);
    const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
    const [loadAttempt, setLoadAttempt] = useState(0);
    const busy = saving || loadState !== 'ready';
    const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | ''; text: string }>({ kind: '', text: '' });
    // 设置页根节点：Ctrl+S 只在它可见时接管（DSH 若在别的设置页保持本组件挂载，不能把别人的快捷键抢走）
    const rootRef = useRef<HTMLElement | null>(null);
    // 确认 / 提示弹窗（仿官方：遮罩 + 居中卡片 + 按钮）：
    // remove 删除宠物、lastOne 只剩一只删不了、sync 同步覆盖、corrupt 用户配置已损坏（取消不动文件 / 确认强行重建）。
    const [dialog, setDialog] = useState<
      null | { kind: 'remove' } | { kind: 'lastOne' } | { kind: 'sync' } | { kind: 'corrupt'; path: string }
    >(null);
    // 配置文件地址与存储位置清单（「高级配置」「卸载与存储」区块）；读取失败时缺省不显示，不影响表单。
    const [paths, setPaths] = useState<null | {
      user: string;
      default: string;
      animations: string;
      /** 用户表情包目录（加图不必改包）。 */
      memes?: string;
      /** 统一日志文件；桌面版没控制台，排障只看它。 */
      logs?: string;
      /** 插件落盘的全部位置（路径与是否已存在），由宿主半侧按平台推导。 */
      storage?: Array<{ key: string; path: string; exists?: boolean }>;
      /** 当前 profile 名（拼卸载命令用；反推不出时为空串）。 */
      profile?: string;
    }>(null);
    useEffect(() => {
      fetch('/dsh-pet-7340/config/meta')
        .then((r) => (r.ok ? r.json() : null))
        .then((p) => setPaths(p))
        .catch(() => console.warn('[dsh-pet] 读取配置文件路径失败'));
    }, []);

    // 系统通知总开关：与其余全局开关同构，切换只改本地状态、随「保存」整包写入。
    // 不做即时写入：PUT /config 会重启桌面 Helper，全部桌面宠物窗口重建（拖拽落点清空、宠物跳回角落）。
    // 引擎重读放在 save() 成功后（reloadNotifications），保存后即时生效、无需刷新。
    const [notifyEnabled, setNotifyEnabled] = useState(true);
    // 点击音效开关：同通知开关，随「保存」整包写入；初值 false 是内置默认，加载效应会用成品值覆盖。
    const [clickSound, setClickSound] = useState(false);
    // 表情包配图开关（全局）：切换只改本地状态，随「保存」一起提交。
    const [whisperImage, setWhisperImage] = useState(false);
    const [chatImage, setChatImage] = useState(false);
    // 抛掷锁定开关（全局）：切换只改本地状态，随「保存」一起提交。
    const [confineScreen, setConfineScreen] = useState(false);
    // 系统托盘开关（全局）：随「保存」一起提交；宿主半侧据此决定建不建托盘、没桌面宠物时还值不值得常驻 Helper。
    const [trayEnabled, setTrayEnabled] = useState(true);
    // 物理参数（全局）：只改本地状态，随「保存」整包写入；初值仅占位，成品加载成功后才允许编辑与保存。
    const [physics, setPhysics] = useState<PhysicsParams>({ ...DEFAULT_PHYSICS });
    // 字体（全局默认）：与 physics 同一套语义；初值仅占位，成品加载成功后才允许编辑与保存。
    const [font, setFont] = useState<FontConfig>({ ...DEFAULT_FONT });
    // AI 模型（条目级）：碎碎念 / 对话各自的服务商与模型，两者都留空 = 跟随当前对话；随「保存」整包写入。
    const [whisperModel, setWhisperModel] = useState<ModelSelection>({ provider: '', model: '' });
    const [chatModel, setChatModel] = useState<ModelSelection>({ provider: '', model: '' });
    // 对话历史条数（全局默认）：初值 5 是内置默认，加载效应会用成品 main.chatMemoryRounds 覆盖。
    const [chatMemory, setChatMemory] = useState(5);
    // 对话配图张数上限（全局默认）：初值 10 是内置默认（砍掉整张清单约 2/3 开销），加载后由成品值覆盖。
    const [chatImageLimit, setChatImageLimit] = useState(10);
    // 条目级人设：设置页只编辑实例级覆盖（pets[].whisperPrompt）；这个值只用于「留空时跟随什么」的预览，不参与提交。
    const [entryPrompt, setEntryPrompt] = useState('');
    // 候选清单：宿主半侧 llm 服务的实时服务商与模型；null = 还没拉到，拉失败置 catalogErr 显示一行提示。
    const [catalog, setCatalog] = useState<ModelCatalogGroup[] | null>(null);
    const [catalogErr, setCatalogErr] = useState(false);
    // 权限申请的反馈，就地显示在按钮旁，与保存反馈分离。
    const [permMsg, setPermMsg] = useState<{ kind: 'ok' | 'err' | ''; text: string }>({ kind: '', text: '' });
    // 首次读取与恢复默认必须更新同一组控件，避免下一次保存回写过期值。
    const applyConfig = useCallback((merged: Record<string, Record<string, unknown>>) => {
      const m = merged.main;
      if (!m || !Array.isArray(m.pets)) throw new Error('Invalid config response');
      const loadedPets = m.pets as Pet[];
      setPets(loadedPets.map((p) => ({ ...p, position: { ...p.position } })));
      // 条目人设：实例级没写的宠物就是用它（合并器保证 main 条目一定有非空字符串）
      setEntryPrompt(typeof m.whisperPrompt === 'string' ? m.whisperPrompt : '');
      setSelId((id) => (loadedPets.some((p) => p.id === id) ? id : (loadedPets[0]?.id ?? '')));
      if (typeof m.notificationsEnabled === 'boolean') setNotifyEnabled(m.notificationsEnabled);
      if (typeof m.clickSoundEnabled === 'boolean') setClickSound(m.clickSoundEnabled);
      if (typeof m.whisperImageEnabled === 'boolean') setWhisperImage(m.whisperImageEnabled);
      if (typeof m.chatImageEnabled === 'boolean') setChatImage(m.chatImageEnabled);
      if (typeof m.confineToScreen === 'boolean') setConfineScreen(m.confineToScreen);
      if (typeof m.trayEnabled === 'boolean') setTrayEnabled(m.trayEnabled);
      // physics 段：成品已按「内置默认 ← 用户层」整段填满，直接取用（缺子键再用默认兜底一次）
      if (m.physics && typeof m.physics === 'object') {
        setPhysics({ ...DEFAULT_PHYSICS, ...(m.physics as PhysicsParams) });
      }
      // 字体段：同 physics——成品已填满，缺子键再用默认兜底一次
      if (m.font && typeof m.font === 'object') {
        setFont({ ...DEFAULT_FONT, ...(m.font as FontConfig) });
      }
      // 模型选择：成品同样已填满（内置默认 = 两者都空 = 跟随当前对话），读得出就原样上屏
      const wm = m.whisperModel as Partial<ModelSelection> | undefined;
      if (wm && typeof wm.provider === 'string' && typeof wm.model === 'string') {
        setWhisperModel({ provider: wm.provider, model: wm.model });
      }
      const cm = m.chatModel as Partial<ModelSelection> | undefined;
      if (cm && typeof cm.provider === 'string' && typeof cm.model === 'string') {
        setChatModel({ provider: cm.provider, model: cm.model });
      }
      // 对话历史条数：成品已合并用户层与内置默认，合法就原样上屏。
      const cmr = Number(m.chatMemoryRounds);
      if (Number.isFinite(cmr) && cmr >= 0) setChatMemory(cmr);
      // 对话配图张数上限：同上（内置默认 0 = 不限制）
      const cil = Number(m.chatImageLimit);
      if (Number.isFinite(cil) && cil >= 0) setChatImageLimit(cil);
    }, []);

    useEffect(() => {
      let alive = true;
      const controller = new AbortController();
      fetch('/dsh-pet-7340/config', { signal: controller.signal })
        .then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then((merged) => {
          if (!alive) return;
          applyConfig(merged);
          setLoadState('ready');
        })
        .catch(() => {
          if (alive) setLoadState('error');
        });
      return () => {
        alive = false;
        controller.abort();
      };
    }, [applyConfig, loadAttempt]);

    // 候选模型清单：一次性拉取（下拉框数据源）。失败只提示、不阻塞——已有配置值照常显示与保存。
    useEffect(() => {
      let alive = true;
      fetch('/dsh-pet-7340/models')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
        .then((d) => {
          if (!alive) return;
          if (d && Array.isArray(d.providers)) setCatalog(d.providers as ModelCatalogGroup[]);
          else setCatalogErr(true);
        })
        .catch(() => {
          if (alive) setCatalogErr(true);
        });
      return () => {
        alive = false;
      };
    }, []);

    // 切换系统通知：与其余全局开关同构——只改本地状态（开启时顺带借这次用户手势申请权限），
    // 配置在点「保存」时整包写入；保存成功后由 save() 调 reloadNotifications() 让引擎即时重读。
    const toggleNotify = async (v: boolean) => {
      setNotifyEnabled(v);
      // 开启时借用户手势申请系统通知权限（无手势的自动申请可能被浏览器静默压制）。
      if (v) await requestNotificationPermission();
    };

    /**
     * 「测试弹窗」按钮：发一条测试系统通知，验证整条链路。
     * 没授权时先借这次用户手势申请权限，成功后再发通知；一个按钮兼做「拿权限」与「验链路」。
     */
    const testNotification = async () => {
      setPermMsg({ kind: '', text: '' });
      const r = await requestNotificationPermission();
      if (!r.ok) {
        // 红字：失败理由 + 引导（unsupported 无引导，改环境才有意义）
        const reason =
          r.reason === 'unsupported'
            ? t('notifyDenyUnsupported')
            : r.reason === 'denied'
              ? t('notifyDenyBlocked')
              : r.reason === 'rejected'
                ? t('notifyDenyRejected')
                : t('notifyDenyError') + (r.message ? '：' + r.message : '');
        setPermMsg({ kind: 'err', text: reason + (r.reason === 'unsupported' ? '' : ' ' + t('notifyGuide')) });
        return;
      }
      try {
        // 绕过聚焦门直接发一条测试通知；点击行为与真实事件通知共用 wireNotificationClick。
        wireNotificationClick(
          new Notification('测试通知', { body: '【dsh-pet】系统通知已就绪。', icon: NOTIFY_ICONS.test }),
        );
      } catch {
        /* 个别环境构造失败：仍按已授权提示。 */
      }
      setPermMsg({ kind: 'ok', text: t('notifyTestOk') });
    };

    // 当前选中的宠物对象（表单数据源）；selId 由 add/remove/sync 同步维护，列表非空时恒有效
    const cur = pets.find((p) => p.id === selId) ?? null;

    // 更新选中的宠物：size 走顶层；position 子字段整体替换
    const updateSel = (patch: Partial<Omit<Pet, 'position'>> & { position?: Partial<Pet['position']> }) =>
      setPets((list) =>
        list.map((p) => {
          if (p.id !== selId) return p;
          const { position: posPatch, ...rest } = patch;
          return { ...p, ...rest, position: posPatch ? { ...p.position, ...posPatch } : p.position };
        }),
      );

    const validated = (): boolean => {
      for (const p of pets) {
        if (
          !Number.isFinite(p.size) ||
          p.size <= 0 ||
          !Number.isFinite(p.position.marginX) ||
          !Number.isFinite(p.position.marginY)
        ) {
          setMsg({ kind: 'err', text: t('invalid') });
          return false;
        }
      }
      // 物理参数：与宿主 physicsValid 同一套规则（非法宿主会回 400，这里先就地给红字提示）
      if (
        !Number.isFinite(physics.gravity) ||
        physics.gravity < 0 ||
        !Number.isFinite(physics.restitution) ||
        physics.restitution < 0 ||
        physics.restitution > 1 ||
        !Number.isFinite(physics.groundFriction) ||
        physics.groundFriction < 0 ||
        !Number.isFinite(physics.throwPower) ||
        physics.throwPower <= 0
      ) {
        setMsg({ kind: 'err', text: t('invalidPhysics') });
        return false;
      }
      // 模型选择：与宿主 modelSelectionValid 同一套规则——只填一半（选了服务商没选模型，或反之）非法
      if (!modelPairValid(whisperModel) || !modelPairValid(chatModel)) {
        setMsg({ kind: 'err', text: t('invalidModel') });
        return false;
      }
      // 对话历史条数：与宿主 topFieldValid 同一套规则（有限且 ≥ 0）
      if (!Number.isFinite(chatMemory) || chatMemory < 0) {
        setMsg({ kind: 'err', text: t('invalidChatMemory') });
        return false;
      }
      // 对话配图张数上限：同上（0 = 不限制，合法）
      if (!Number.isFinite(chatImageLimit) || chatImageLimit < 0) {
        setMsg({ kind: 'err', text: t('invalidChatImageLimit') });
        return false;
      }
      // 字体：与宿主 fontValid 同一套规则（family 必须在预设白名单内、size 4~200、followPet 为布尔）
      if (
        !FONT_PRESETS.some((p) => p.id === font.family) ||
        !Number.isFinite(font.size) ||
        font.size < FONT_SIZE_MIN ||
        font.size > FONT_SIZE_MAX
      ) {
        setMsg({ kind: 'err', text: t('invalidFont') });
        return false;
      }
      return true;
    };

    // force 只认严格 true，绝不能写成 `force ? ...`：React 会把 MouseEvent 当第一实参传进来（真值），
    // 从而拼上 ?force=1 绕过损坏预检、静默白名单重建、字段全丢。真实事故，已有源码守卫钉住。
    const save = async (force = false) => {
      if (busy) return;
      const isOk = validated();
      if (!isOk) return;
      setBusy(true);
      setMsg({ kind: '', text: '' });
      try {
        // 通知总开关随保存一起写；初值来自成品 main 条目，不会静默覆盖用户手写值。
        const body: Record<string, unknown> = {
          pets: pets,
          notificationsEnabled: notifyEnabled,
          clickSoundEnabled: clickSound,
          whisperImageEnabled: whisperImage,
          chatImageEnabled: chatImage,
          confineToScreen: confineScreen,
          trayEnabled: trayEnabled,
          physics: physics,
          whisperModel: whisperModel,
          chatModel: chatModel,
          chatMemoryRounds: chatMemory,
          chatImageLimit: chatImageLimit,
          font: font,
        };
        // 用户在损坏弹窗里点了确认：带 ?force=1 才允许按白名单重建损坏文件。
        const res = await fetch('/dsh-pet-7340/config' + (force === true ? '?force=1' : ''), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        // 409 = 宿主损坏预检拦下（白名单重建会把文件里剩下的内容整份丢掉）：
        // 这里不写盘，弹窗让用户决定（取消 = 不动文件 / 确认 = 强行重建）。
        if (res.status === 409) {
          // 路径取宿主回的真实写入路径，meta 拉取失败时也不至于空着。
          const info = (await res.json().catch(() => null)) as { userFile?: unknown } | null;
          setDialog({
            kind: 'corrupt',
            path: typeof info?.userFile === 'string' ? info.userFile : (paths?.user ?? ''),
          });
          return;
        }
        if (!res.ok) {
          setMsg({ kind: 'err', text: t(res.status === 400 ? 'saveInvalid' : 'saveError') });
          return;
        }
        // 同上：PUT 响应即成品聚合，容器据此重新拍平（新增/删除宠物、改大小位置都走这条路）
        petBridge.reload((await res.json()) as Record<string, Record<string, unknown>>);
        void reloadNotifications(); // 保存后即时生效，无需刷新。
        setMsg({ kind: 'ok', text: t('saved') });
      } catch {
        setMsg({ kind: 'err', text: t('saveError') });
      } finally {
        setBusy(false);
      }
    };

    // 快捷键必须用最新的 save：save 每次渲染都重建（闭包捕获 pets / physics 等状态），
    // 直接塞进 useEffect([]) 会拿旧状态存盘；这里每次渲染转发一次。
    const saveRef = useRef<() => void>(() => {});
    useEffect(() => {
      saveRef.current = () => void save();
    });

    // Ctrl+S / Cmd+S 保存：页面很长，改完不必滚到底部找按钮。
    // 只在本设置页可见时接管，且只在真要保存时 preventDefault，否则会拦掉浏览器的「保存网页」。
    useEffect(() => {
      const onKey = (e: KeyboardEvent): void => {
        if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
        if (e.key.toLowerCase() !== 's') return;
        const root = rootRef.current;
        if (!root || !root.isConnected || root.getClientRects().length === 0) return;
        e.preventDefault();
        saveRef.current();
      };
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }, []);

    const sync = () => setDialog({ kind: 'sync' });

    const doSync = async () => {
      setBusy(true);
      setMsg({ kind: '', text: '' });
      try {
        // 同步用户层：POST 把内置默认配置（原文，含注释）整份写入用户配置，响应体同样是成品聚合。
        // 之后与保存走同一条路，没有中间失败态。
        const res = await fetch('/dsh-pet-7340/config', { method: 'POST' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const merged = (await res.json()) as Record<string, Record<string, unknown>>;
        applyConfig(merged);
        // 同一份成品交给容器拍平：编辑列表（裸实例）与渲染列表（含条目级字段）都由成品派生
        petBridge.reload(merged);
        void reloadNotifications();
        setMsg({ kind: 'ok', text: t('saved') });
      } catch {
        setMsg({ kind: 'err', text: t('syncError') });
      } finally {
        setBusy(false);
      }
    };

    const addPet = () => {
      const tpl = petBridge.template;
      if (!tpl) return;
      const id = nextId(pets);
      setPets((list) => [
        ...list,
        {
          id,
          // 新宠物默认名字是自己的新 id（与「缺失 name 按 id 处理」同一语义，避免继承模板名字造成同名）。
          name: id,
          size: tpl.size,
          balanceEnabled: tpl.balanceEnabled,
          whisperEnabled: tpl.whisperEnabled,
          workStatusEnabled: tpl.workStatusEnabled,
          fixedEnabled: tpl.fixedEnabled,
          display: tpl.display,
          position: { ...tpl.position },
        },
      ]);
      setSelId(id);
    };

    const removeSel = () => {
      // 两种情形都走弹窗：能删就确认删除；只剩一只则说明删不了。
      setDialog({ kind: pets.length <= 1 ? 'lastOne' : 'remove' });
    };

    const doRemove = () => {
      const list = pets.filter((p) => p.id !== selId);
      setPets(list);
      setSelId(list[0].id);
    };

    /** 宠物数值输入（大小 / 水平偏移 / 垂直偏移）；宽度交给栅格。 */
    const numInput = (
      key: 'size' | 'marginX' | 'marginY',
      value: number,
      setter: (v: number) => void,
    ): ReturnType<typeof h> =>
      h('input', {
        type: 'number',
        className: inputClass,
        step: key === 'size' ? '10' : '1',
        min: key === 'size' ? '120' : '',
        value: String(value),
        disabled: busy,
        onChange: (e: ChangeEvent<HTMLInputElement>) => setter(Number(e.target.value)),
      });

    /** 物理参数的一格：标签与问号在上、数字输入在下。 */
    const physField = (
      key: 'gravity' | 'restitution' | 'groundFriction' | 'throwPower',
      step: string,
      min: string,
      end = false,
    ): ReturnType<typeof h> =>
      field(
        t('physics.' + key),
        h('input', {
          type: 'number',
          className: inputClass,
          step,
          min,
          value: String(physics[key]),
          disabled: busy,
          onChange: (e: ChangeEvent<HTMLInputElement>) =>
            setPhysics((p) => ({ ...p, [key]: Number(e.target.value) }) as PhysicsParams),
        }),
        t('physics.' + key + 'Hint'),
        end,
      );

    /** 「全局默认」的数字格：标签与问号在上、数字输入在下。 */
    const globalNumField = (label: string, value: number, setter: (v: number) => void): ReturnType<typeof h> =>
      field(
        t(label),
        h('input', {
          type: 'number',
          className: inputClass,
          step: '1',
          min: '0',
          value: String(value),
          disabled: busy,
          onChange: (e: ChangeEvent<HTMLInputElement>) => setter(Number(e.target.value)),
        }),
        t(label + 'Hint'),
      );

    /** 「AI 模型」的一格：标签与问号在上、单下拉选择器在下。 */
    const modelCell = (
      key: 'whisperModel' | 'chatModel',
      value: ModelSelection,
      setter: (v: ModelSelection) => void,
      end = false,
    ): ReturnType<typeof h> => {
      const label = t(key === 'whisperModel' ? 'whisperModelLabel' : 'chatModelLabel');
      return field(
        label,
        h(ModelPicker, { label, value, disabled: busy, catalog, failed: catalogErr, onChange: setter }),
        t('modelFieldHint'),
        end,
      );
    };

    return h('section', {
      ref: rootRef,
      className: 'dsh-pet-cfg',
      style: { maxWidth: '720px' },
      children: [
        // 标题：intro 与「额外宠物」说明都收进问号。
        h('h2', {
          className: 'dsh-pet-cfg__title',
          children: [
            t('nav'),
            q(extraCount > 0 ? t('intro') + '\n' + t('extraPetsHint').replace('{n}', String(extraCount)) : t('intro')),
          ],
        }),

        loadState !== 'ready'
          ? h('div', {
              role: loadState === 'error' ? 'alert' : 'status',
              className: 'dsh-pet-cfg__actions',
              children: [
                h('span', { children: t(loadState === 'error' ? 'loadError' : 'loading') }),
                loadState === 'error'
                  ? h('button', {
                      type: 'button',
                      className: 'dsh-pet-cfg__btn',
                      onClick: () => {
                        setLoadState('loading');
                        setLoadAttempt((attempt) => attempt + 1);
                      },
                      children: t('retry'),
                    })
                  : null,
              ],
            })
          : null,

        // 宠物列表与添加按钮。
        h('div', {
          className: 'dsh-pet-cfg__tabs',
          children: [
            h('span', { key: 'label', className: 'dsh-pet-cfg__tabsLabel', children: t('petsLabel') }),
            ...pets.map((p) =>
              h('button', {
                key: p.id,
                type: 'button',
                onClick: () => setSelId(p.id),
                className: 'dsh-pet-cfg__tab' + (p.id === selId ? ' is-active' : ''),
                children: (p.name || p.id) + ' (' + p.size + 'px)',
              }),
            ),
            h('button', {
              key: 'add',
              type: 'button',
              onClick: addPet,
              disabled: busy,
              className: 'dsh-pet-cfg__tab is-ghost',
              children: '+ ' + t('add'),
            }),
          ],
        }),

        // 选中宠物配置卡：第一行名字、大小、显示位置，第二行位置与偏移，第三行四个开关。
        cur
          ? h('div', {
              className: 'dsh-pet-cfg__card',
              children: [
                h('div', {
                  className: 'dsh-pet-cfg__cardHead',
                  children: [
                    h('span', { key: 't', className: 'dsh-pet-cfg__cardTitle', children: t('petCardTitle') }),
                    q(t('petCardHint')),
                    // 右侧动作组：auto margin 挂在这层 wrapper 上，保存结果出现 / 消失时按钮位置不会跳。
                    h('div', {
                      key: 'acts',
                      style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px' },
                      children: [
                        // 保存结果就近反馈（与页面底部同一份 msg 状态），否则在卡片上点保存看不到结果。
                        msg.text
                          ? h('span', {
                              key: 'msg',
                              className: 'dsh-pet-cfg__msg' + (msg.kind === 'err' ? ' is-err' : ''),
                              children: msg.text,
                            })
                          : null,
                        // 就近保存：宠物这一块改完就地存盘，不必滚到底部的「保存」；悬浮按钮即出快捷键气泡。
                        h('button', {
                          key: 'sv',
                          type: 'button',
                          onClick: () => void save(),
                          disabled: busy,
                          className: 'dsh-pet-cfg__btn is-primary is-sm',
                          ...tip(t('saveHotkey')),
                          children: t('save'),
                        }),
                        h('button', {
                          key: 'rm',
                          type: 'button',
                          onClick: removeSel,
                          disabled: busy,
                          className: 'dsh-pet-cfg__btn is-danger is-sm',
                          children: t('remove'),
                        }),
                      ],
                    }),
                  ],
                }),

                h('div', {
                  className: 'dsh-pet-cfg__grid3',
                  children: [
                    field(
                      t('nameLabel'),
                      h('input', {
                        type: 'text',
                        className: inputClass,
                        value: String(cur.name ?? ''),
                        disabled: busy,
                        maxLength: 50,
                        onChange: (e: ChangeEvent<HTMLInputElement>) => updateSel({ name: e.target.value }),
                      }),
                      t('nameHint'),
                    ),
                    field(
                      t('sizeLabel'),
                      numInput('size', cur.size, (v) => updateSel({ size: v })),
                      t('sizeHint'),
                    ),
                    field(
                      t('displayLabel'),
                      h('select', {
                        className: inputClass,
                        value: cur.display,
                        disabled: busy,
                        onChange: (e: ChangeEvent<HTMLSelectElement>) =>
                          updateSel({ display: e.target.value as PetDisplay }),
                        children: PET_DISPLAYS.map((d) =>
                          h('option', {
                            key: d,
                            value: d,
                            children: t('display.' + d),
                          }),
                        ),
                      }),
                      t('displayHint'),
                      true,
                    ),
                  ],
                }),

                h('div', {
                  className: 'dsh-pet-cfg__grid3',
                  children: [
                    field(
                      t('cornerLabel'),
                      h('select', {
                        className: inputClass,
                        value: cur.position.corner,
                        disabled: busy,
                        onChange: (e: ChangeEvent<HTMLSelectElement>) =>
                          updateSel({ position: { corner: e.target.value as Corner } }),
                        children: CORNERS.map((c) =>
                          h('option', {
                            key: c,
                            value: c,
                            children: cornerLabel(c),
                          }),
                        ),
                      }),
                      t('cornerHint'),
                    ),
                    field(
                      t('marginX'),
                      numInput('marginX', cur.position.marginX, (v) => updateSel({ position: { marginX: v } })),
                      t('marginXHint'),
                    ),
                    field(
                      t('marginY'),
                      numInput('marginY', cur.position.marginY, (v) => updateSel({ position: { marginY: v } })),
                      t('marginYHint'),
                      true,
                    ),
                  ],
                }),

                h('div', {
                  className: 'dsh-pet-cfg__grid4',
                  children: [
                    toggleCell('balanceEnabled', !!cur.balanceEnabled, busy, (v) => updateSel({ balanceEnabled: v })),
                    toggleCell('whisperEnabled', !!cur.whisperEnabled, busy, (v) => updateSel({ whisperEnabled: v })),
                    toggleCell('workStatusEnabled', !!cur.workStatusEnabled, busy, (v) =>
                      updateSel({ workStatusEnabled: v }),
                    ),
                    toggleCell('fixedEnabled', !!cur.fixedEnabled, busy, (v) => updateSel({ fixedEnabled: v }), true),
                  ],
                }),

                // 人设（可选，实例级）：写在这只宠物上的 whisperPrompt，空 = 跟随所属条目的人设。
                // 只存储与回显，不在这里拼 system；拼装（名字声明 + 时间背景）在宿主半侧。
                // 占位符直接用条目人设正文，让「跟随的是什么」可见；人设没有长度上限，右下角只显示字数。
                field(
                  t('personaLabel'),
                  h('div', {
                    className: 'dsh-pet-cfg__persona',
                    children: [
                      h('textarea', {
                        className: inputClass + ' dsh-pet-cfg__area',
                        rows: 3,
                        value: String(cur.whisperPrompt ?? ''),
                        disabled: busy,
                        placeholder: entryPrompt,
                        onChange: (e: ChangeEvent<HTMLTextAreaElement>) => updateSel({ whisperPrompt: e.target.value }),
                      }),
                      h('span', {
                        className: 'dsh-pet-cfg__count',
                        children: t('personaCount').replace('{n}', String(String(cur.whisperPrompt ?? '').length)),
                      }),
                    ],
                  }),
                  t('personaHint'),
                ),
              ],
            })
          : h('p', {
              className: 'dsh-pet-cfg__note',
              children: t('emptyPets'),
            }),

        // 全局开关卡：切换只改本地状态，随「保存」整包写入——即时写盘会重启桌面 Helper、重建全部桌面宠物窗口。
        // 系统通知额外在保存后由 save() 调 reloadNotifications() 重读；「测试弹窗」是动作，跟「保存 / 同步」同一行。
        h('div', {
          className: 'dsh-pet-cfg__card',
          children: [
            cardHead(t('globalTitle'), t('globalHint')),
            h('div', {
              className: 'dsh-pet-cfg__grid4',
              children: [
                toggleCell('notifyToggle', notifyEnabled, busy, (v) => void toggleNotify(v)),
                toggleCell('clickSoundToggle', clickSound, busy, setClickSound),
                toggleCell('whisperImageToggle', whisperImage, busy, setWhisperImage),
                toggleCell('chatImageToggle', chatImage, busy, setChatImage),
                toggleCell('confineToggle', confineScreen, busy, setConfineScreen, true),
                toggleCell('trayToggle', trayEnabled, busy, setTrayEnabled),
              ],
            }),
          ],
        }),

        // 外观与字体卡（全局默认，与全局开关 / physics 同语义：只改本地状态、随「保存」整包写入）。
        // 字体种类作用于现在用软糖体的全部文字；字号只作用于气泡与悬浮提示，对话窗与得分弹窗不变。
        h('div', {
          className: 'dsh-pet-cfg__card',
          children: [
            cardHead(t('fontTitle'), t('fontHint')),
            h('div', {
              className: 'dsh-pet-cfg__grid2',
              children: [
                field(
                  t('fontFamilyLabel'),
                  h('select', {
                    className: inputClass,
                    value: font.family,
                    disabled: busy,
                    onChange: (e: ChangeEvent<HTMLSelectElement>) =>
                      setFont((f) => ({ ...f, family: e.target.value as FontFamilyId })),
                    children: FONT_PRESETS.map((p) =>
                      h('option', { key: p.id, value: p.id, children: t('font.' + p.id) }),
                    ),
                  }),
                  t('fontFamilyHint'),
                ),
                field(
                  t('fontSizeLabel'),
                  h('input', {
                    type: 'number',
                    className: inputClass,
                    step: '1',
                    min: String(FONT_SIZE_MIN),
                    max: String(FONT_SIZE_MAX),
                    value: String(font.size),
                    disabled: busy,
                    onChange: (e: ChangeEvent<HTMLInputElement>) =>
                      setFont((f) => ({ ...f, size: Number(e.target.value) })),
                  }),
                  t('fontSizeHint'),
                  true,
                ),
              ],
            }),
            h('div', {
              className: 'dsh-pet-cfg__grid2',
              children: [
                toggleCell('fontFollowToggle', font.followPet, busy, (v) => setFont((f) => ({ ...f, followPet: v }))),
              ],
            }),
          ],
        }),

        // AI 模型与对话上下文卡：碎碎念 / 对话各自的模型（条目级）与对话历史条数、配图张数上限（全局默认）。
        // 都与四个开关同语义，只改本地状态、随「保存」整包写入；宿主半侧生成时优先用模型，失败自动回落。
        h('div', {
          className: 'dsh-pet-cfg__card',
          children: [
            cardHead(t('modelTitle'), t('modelHint')),
            catalogErr
              ? h('p', {
                  className: 'dsh-pet-cfg__note',
                  style: { color: 'var(--dsw-alias-state-error-primary)' },
                  children: t('modelCatalogFailed'),
                })
              : null,
            h('div', {
              className: 'dsh-pet-cfg__grid2',
              children: [
                modelCell('whisperModel', whisperModel, setWhisperModel),
                modelCell('chatModel', chatModel, setChatModel, true),
              ],
            }),
            h('div', {
              className: 'dsh-pet-cfg__grid4',
              children: [
                globalNumField('chatMemory', chatMemory, setChatMemory),
                globalNumField('chatImageLimit', chatImageLimit, setChatImageLimit),
              ],
            }),
          ],
        }),

        // 物理卡：四个数字输入一行、两个开关一行；只改本地状态，随「保存」整包写入。
        // 浏览器保存后即时生效；桌面端由保存触发的 Helper 重启重新读取——physics 在 sprite 构造时只读一次。
        h('div', {
          className: 'dsh-pet-cfg__card',
          children: [
            cardHead(t('physicsTitle'), t('physicsHint')),
            h('div', {
              className: 'dsh-pet-cfg__grid4',
              children: [
                physField('gravity', '50', '0'),
                physField('restitution', '0.01', '0'),
                physField('groundFriction', '0.1', '0'),
                physField('throwPower', '0.05', '0.05', true),
              ],
            }),
            h('div', {
              className: 'dsh-pet-cfg__grid2',
              children: [
                toggleCell('physicsCeilingBounce', physics.ceilingBounce, busy, (v) =>
                  setPhysics((p) => ({ ...p, ceilingBounce: v })),
                ),
                toggleCell(
                  'physicsPetCollision',
                  physics.petCollision,
                  busy,
                  (v) => setPhysics((p) => ({ ...p, petCollision: v })),
                  true,
                ),
              ],
            }),
          ],
        }),

        // 操作区：「测试弹窗」与「保存 / 同步」同一行；「同步」的副作用说明收进问号。
        h('div', {
          className: 'dsh-pet-cfg__actions',
          children: [
            h('button', {
              type: 'button',
              disabled: busy,
              onClick: () => void save(),
              className: 'dsh-pet-cfg__btn is-primary',
              // 悬浮按钮即出快捷键气泡。
              ...tip(t('saveHotkey')),
              children: t('save'),
            }),
            h('button', {
              type: 'button',
              disabled: busy,
              onClick: sync,
              className: 'dsh-pet-cfg__btn',
              children: t('sync'),
            }),
            h('button', {
              type: 'button',
              onClick: () => void testNotification(),
              className: 'dsh-pet-cfg__btn',
              children: t('notifyTest'),
            }),
            q(t('syncHint')),
            // 两个反馈各归各的：msg 是保存 / 同步结果，permMsg 是测试通知结果。
            msg.text
              ? h('span', {
                  className: 'dsh-pet-cfg__msg' + (msg.kind === 'err' ? ' is-err' : ''),
                  children: msg.text,
                })
              : null,
            permMsg.text
              ? h('span', {
                  className: 'dsh-pet-cfg__msg' + (permMsg.kind === 'err' ? ' is-err' : ''),
                  children: permMsg.text,
                })
              : null,
          ],
        }),

        // 高级配置：直接编辑配置文件用的路径，说明收进问号。
        paths
          ? h('div', {
              className: 'dsh-pet-cfg__card',
              children: [
                cardHead(t('configMeta'), t('configMetaHint')),
                h('div', { className: 'dsh-pet-cfg__path', children: t('defaultConfig') + '：' + paths.default }),
                h('div', { className: 'dsh-pet-cfg__path', children: t('userConfig') + '：' + paths.user }),
                h('div', { className: 'dsh-pet-cfg__path', children: t('animationDir') + '：' + paths.animations }),
                paths.memes
                  ? h('div', { className: 'dsh-pet-cfg__path', children: t('memesDir') + '：' + paths.memes })
                  : null,
                // 日志文件路径 + 一句说明；其余位置的用途都在问号里，唯独这条写在明面上——反馈问题时要先找它。
                paths.logs
                  ? h('div', { className: 'dsh-pet-cfg__path', children: t('logFile') + '：' + paths.logs })
                  : null,
                paths.logs ? h('div', { className: 'dsh-pet-cfg__note', children: t('logFileNote') }) : null,
              ],
            })
          : null,

        // 卸载与存储：先列出插件落盘的全部位置（路径在前、作用在后），再给出卸载方法。
        paths && paths.storage && paths.storage.length > 0
          ? h('div', {
              className: 'dsh-pet-cfg__card',
              children: [
                cardHead(t('storageTitle'), t('storageHint')),
                // 存储位置清单：每条都是「路径（等宽、可选中复制）到作用」。
                ...paths.storage.map((s) =>
                  h('div', {
                    key: s.key,
                    className: 'dsh-pet-cfg__path',
                    children: [
                      h('b', { key: 'p', style: { fontFamily: MONO }, children: s.path }),
                      // 尚未产生的目录标一下，避免用户去找不存在的文件夹。
                      h('span', {
                        key: 'd',
                        children: ' — ' + t('storage.' + s.key) + (s.exists === false ? t('storageMissing') : ''),
                      }),
                    ],
                  }),
                ),
                h('div', {
                  key: 'ut',
                  className: 'dsh-pet-cfg__cardTitle',
                  style: { marginTop: '4px' },
                  children: t('uninstallTitle'),
                }),
                h('div', { key: 'u1', className: 'dsh-pet-cfg__note', children: t('uninstallStep1') }),
                h('div', { key: 'u2', className: 'dsh-pet-cfg__note', children: t('uninstallStep2') }),
                h('div', {
                  key: 'cmd',
                  className: 'dsh-pet-cfg__cmd',
                  children: t('uninstallCmd').replace('{profile}', paths.profile || '<profile>'),
                }),
                h('div', { key: 'u3', className: 'dsh-pet-cfg__note', children: t('uninstallStep3') }),
              ],
            })
          : null,

        // 确认 / 提示弹窗（仿官方视觉：遮罩 + 居中卡片 + 按钮）。
        dialog
          ? h('div', {
              style: {
                position: 'fixed',
                inset: 0,
                zIndex: 2147483647,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(0, 0, 0, 0.45)',
              },
              onClick: () => setDialog(null),
              children: h('div', {
                style: {
                  width: '340px',
                  maxWidth: 'calc(100vw - 40px)',
                  background: 'var(--dsw-alias-bg-layer-1)',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  borderRadius: '12px',
                  padding: '16px 18px',
                  boxShadow: '0 8px 30px rgba(0, 0, 0, 0.35)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                },
                onClick: (e: ReactNS.MouseEvent<HTMLDivElement>) => e.stopPropagation(),
                children: [
                  h('div', {
                    style: { fontSize: '14px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
                    children: dialog.kind === 'corrupt' ? t('corruptTitle') : t('confirmTitle'),
                  }),
                  h('div', {
                    style: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
                    children:
                      dialog.kind === 'remove'
                        ? t('confirmRemove').replace('{id}', selId)
                        : dialog.kind === 'lastOne'
                          ? t('atLeastOne')
                          : dialog.kind === 'corrupt'
                            ? t('corruptBody').replace('{path}', dialog.path)
                            : t('confirmSync'),
                  }),
                  h('div', {
                    style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
                    // 只剩一只没有可确认的动作，只给「知道了」；其余都是取消 + 确认双按钮。
                    children:
                      dialog.kind === 'lastOne'
                        ? [
                            h('button', {
                              key: 'ok',
                              type: 'button',
                              onClick: () => setDialog(null),
                              className: 'dsh-pet-cfg__btn is-primary',
                              children: t('ok'),
                            }),
                          ]
                        : [
                            h('button', {
                              key: 'cancel',
                              type: 'button',
                              onClick: () => setDialog(null),
                              className: 'dsh-pet-cfg__btn',
                              children: t('cancel'),
                            }),
                            h('button', {
                              key: 'confirm',
                              type: 'button',
                              onClick: () => {
                                const d = dialog;
                                setDialog(null);
                                if (d.kind === 'remove') doRemove();
                                else if (d.kind === 'corrupt')
                                  void save(true); // 确认：带 ?force=1 强行重建。
                                else void doSync();
                              },
                              className: 'dsh-pet-cfg__btn ' + (dialog.kind === 'sync' ? 'is-primary' : 'is-danger'),
                              children:
                                dialog.kind === 'remove'
                                  ? t('remove')
                                  : dialog.kind === 'corrupt'
                                    ? t('corruptConfirm')
                                    : t('sync'),
                            }),
                          ],
                  }),
                ],
              }),
            })
          : null,
      ],
    });
  };
}
