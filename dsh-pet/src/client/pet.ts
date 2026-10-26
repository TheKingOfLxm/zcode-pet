/**
 * 宠物页面：单只宠物实例 PetCard 与多开容器 PetMulti。
 * 不负责配置解析与几何、物理计算：成品配置由 host 提供，纯逻辑来自 shared。
 * 依赖运行时注入的 react，以及 shared 的 state、pickers、motion、physics 等模块。
 * 必须始终成立：/state 是唯一数据源，动画与气泡都由叶子里的序号变化驱动。
 * @module dsh-pet/src/client/pet
 */
import {
  pick,
  rollKind,
  pickCategoryAction,
  pickSlot,
  isEventAnim,
  poolIncludes,
  nextWorkStatusAnim,
} from '../shared/pickers';
import { planMove } from '../shared/motion';
import { flattenConfigPets, isWebVisible } from '../shared/config';
import {
  balanceEventIndex,
  balancePercent,
  customViews,
  decideBalanceNotice,
  type BalanceState,
} from '../shared/balance';
// 轮询状态：页面唯一的数据来源与渲染入口，拉取、拍平、比对都在 shared。
import {
  fetchState,
  flattenCounters,
  postAction,
  readBalance,
  readSay,
  readAnim,
  readPosition,
  readThrow,
  readLock,
  readWorkStatus,
  takeChanged,
  type PollState,
  type PositionMode,
  type SayCue,
  type LockState,
  type PetFacing,
} from '../shared/state';
import { WORK_STATUS_INDEX, type WorkStatusSnapshot } from '../shared/work-status';
import { makeBalanceBubble, makeWhisperBubble } from './bubble';
import { clickScore, SCORE_MIN_SPEED, mountScorePopup, spawnScoreBurst } from '../shared/score-popup';
import {
  CANVAS_H,
  FEET_Y,
  HIT_BOX,
  DRAG_THRESHOLD,
  PET_REF_WIDTH,
  ANIMATION_EXT,
  SLINGSHOT_DOUBLE_MS,
} from '../shared/constants';
// 统一右键菜单：与桌面共用同一份组件（src/shared/menu）。
import {
  buildMenuTree,
  buildMoreBranch,
  displayMenuBranch,
  mountContextMenu,
  isNoMirrorAnimation,
  readMenuItems,
  MENU_CSS,
  type MenuLeaf,
  type MenuMoreItem,
  type MenuNode,
} from '../shared/menu';
// 悬浮提示：与桌面共用样式与摆位判据。
import { TOOLTIP_CLASS, TOOLTIP_CSS, TOOLTIP_GAP_RATIO, tooltipPlacement } from '../shared/tooltip';
// 对话弹窗：与桌面共用组件，记忆由 host 的 /chat 读写。
import { mountChatDialog } from '../shared/chat';
import { registerPose } from './pose';
import { registerProgress } from './progress';
// 字体换算只在 shared 一处，与桌面端共用，避免两端漂移。
import { fontStackOf, resolveFontPx } from '../shared/fonts';
import { petBridge } from './settings';
import { notifyFromFrame } from './notify';

// 拖拽抛掷物理：纯计算在 shared/physics.ts，两端共用。
import {
  estimateReleaseVelocity,
  springStep,
  throwBounds,
  throwStep,
  throwSubsteps,
  trimTrail,
  collidePet,
  bodyPixelBox,
  rectsOverlap,
  SQ_DURATION_MS,
  SQ_SQUASH,
  squashScale,
  landingSquash,
  throwVelocity,
  pullAngle,
  slingshotPower,
  slingshotVelocity,
  type DragSample,
  type PetCollisionSlot,
  type ThrowState,
} from '../shared/physics';
import type { Animations, Corner, Pet, PhysicsParams, Weights } from '../shared/types';
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

/** 本次会话已定论的动画扩展名，null 表示尚未判断。 */
let resolvedExt: string | null = null;

/** 点击音效：单例 audio，100ms 内连点只响一次，播放失败一律静默。 */
const CLICK_SOUND_URL = '/dsh-pet-7340/sound/click-duck.wav';
const CLICK_SOUND_VOLUME = 0.5;
const CLICK_SOUND_THROTTLE_MS = 100;
let clickAudio: HTMLAudioElement | null = null;
let lastClickSoundAt = 0;
/** 点击音效开关，配置未加载前保守静音。 */
let clickSoundEnabled = false;
/** 播放点击音效，失败静默。 */
const playClickSound = (): void => {
  const now = Date.now();
  if (now - lastClickSoundAt < CLICK_SOUND_THROTTLE_MS) return;
  lastClickSoundAt = now;
  try {
    clickAudio ??= new Audio(CLICK_SOUND_URL);
    clickAudio.volume = CLICK_SOUND_VOLUME;
    clickAudio.currentTime = 0;
    void clickAudio.play().catch(() => {});
  } catch {
    /* 音频不可用，静默忽略。 */
  }
};

/** 是否优先要 mov：只有 macOS 上的 WebKit（Safari / WKWebView）需要 HEVC-with-Alpha。
 *  不能用 canPlayType 判断——Safari 能解码 VP9 webm 却会丢弃 alpha，表现为黑底；
 *  「能解码」与「透明还在」是两件事，后者没有 Web API 可查询。
 */
const prefersMov = (): boolean => {
  const ua = navigator.userAgent;
  // Chromium 系（含 Electron 桌面端）与 Firefox 原生支持 VP9-alpha，不需要 mov。
  if (/Chrome|Chromium|Edg|OPR|Firefox|FxiOS/i.test(ua)) return false;
  return /Mac/i.test(navigator.platform || ua); // 余下按 WebKit 处理，且限定 macOS。
};

/** 解析本次使用的扩展名：显式常量优先，否则按渲染端判断。
 *  宿主对缺失的 .mov 会退回同名 .webm，所以这里只管「要哪一种」。
 */
const thumbExt = (): string => {
  if (resolvedExt === null) {
    // ANIMATION_EXT 的静态类型被窄化为 ".webm"，但用户会把它改成 .mov；
    // 按 string 读才能表达这条显式意图，否则 TS 判为恒不相等。
    const explicit: string = ANIMATION_EXT;
    resolvedExt = explicit === '.mov' || prefersMov() ? '.mov' : '.webm';
  }
  return resolvedExt;
};

/** 余额气泡展示时长（ms），与动画生命周期解耦。 */
const BUBBLE_DURATION_MS = 10 * 1000;

/** /state 长轮询的挂起时长（ms）：空闲时约 1 请求/秒，有变化宿主立刻返回。 */
const STATE_WAIT_MS = 1000;

/** 老宿主或请求失败时的轮询间隔（ms）；不退避会变成忙等。 */
const STATE_FALLBACK_MS = 1000;

/** 内联样式，注入一次。 */
const css = [
  '.dsh-pet-root{position:fixed;z-index:40;pointer-events:none;user-select:none}',
  '.dsh-pet-root[data-corner="bottom-right"]{right:var(--dsh-pet-mx,24px);bottom:var(--dsh-pet-my,0)}',
  '.dsh-pet-root[data-corner="bottom-left"]{left:var(--dsh-pet-mx,24px);bottom:var(--dsh-pet-my,0)}',
  '.dsh-pet-root[data-corner="top-right"]{right:var(--dsh-pet-mx,24px);top:var(--dsh-pet-my,0)}',
  '.dsh-pet-root[data-corner="top-left"]{left:var(--dsh-pet-mx,24px);top:var(--dsh-pet-my,0)}',
  '.dsh-pet-stage{position:relative;width:var(--dsh-pet-size,462px);height:calc(var(--dsh-pet-size,462px)*9/16);pointer-events:none}',
  '.dsh-pet-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;opacity:0;transition:opacity .18s ease;transform-origin:center}',
  '.dsh-pet-video.is-front{opacity:1}',
  // 触屏拖拽必需：缺 touch-action:none 时浏览器会把手势判成滚动并触发 pointercancel；
  // 两条 -webkit-* 抑制长按选中与 iOS 长按系统菜单。
  '.dsh-pet-hit{position:absolute;pointer-events:auto;cursor:url("/dsh-pet-7340/pic/cursor-grab.png") 16 16, grab;z-index:1;touch-action:none;-webkit-user-select:none;-webkit-touch-callout:none}',
  '.dsh-pet-hit.dragging{cursor:url("/dsh-pet-7340/pic/cursor-grabbing.png") 16 16, grabbing}',
  '@media (prefers-reduced-motion: reduce){.dsh-pet-video{transition:none}}',
  // 统一右键菜单样式，与桌面注入同一份。
  MENU_CSS,
  // 悬浮提示样式，与桌面注入同一份。
  TOOLTIP_CSS,
].join('\n');
const cssTag = 'dsh-pet/style.css';
/** 注入宠物页面样式，每页只注入一次。 */
function injectCss(): void {
  if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + cssTag + '"]') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-pet';
    tag.dataset.pluginCss = cssTag;
    tag.textContent = css;
    document.head.appendChild(tag);
  }
}

/** 制造宠物页面组件（工厂），返回多开容器 PetMulti。
 *  react 能力由运行时注入；容器内部渲染多个 PetCard。
 */
export function makePetUI(rt: {
  h: typeof jsx;
  useState: <T>(init: T) => [T, Dispatch<SetStateAction<T>>];
  // 用 React 命名空间类型而非 typeof：type-only import 的 hook 无法进入声明导出（TS4078）。
  useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
  useRef: <T>(initial: T) => ReactNS.MutableRefObject<T>;
}): () => ReactNode {
  const { h, useState, useEffect, useRef } = rt;
  injectCss();

  /** 余额气泡：数据与显隐由 PetCard 传入。 */
  const BalanceBubble = makeBalanceBubble({ h, useState, useEffect });
  /** 碎碎念气泡：文本与显隐由 PetCard 传入。 */
  const WhisperBubble = makeWhisperBubble({ h });

  /** 单个宠物实例，配置由容器传入。 */
  function PetCard({
    cfg,
    balance,
    balanceTick,
    balanceNoticeTick,
    balanceManual,
    workStatus,
    workStatusTick,
    say,
    sayTick,
    animCue,
    animCueTick,
    posCue,
    posCueTick,
    throwCue,
    throwCueTick,
    lock,
    lockTick,
    menuItemsRef,
    arena,
  }: {
    /** 成品配置。 */
    cfg: RuntimePet;
    /** 最近一次余额结果。 */
    balance: BalanceState | null;
    /** 余额成功拉取次数，变化时播档位动画。 */
    balanceTick: number;
    /** 余额不可用提示次数。 */
    balanceNoticeTick: number;
    /** 本次余额是否由用户手动请求；手动请求即使关闭 balanceEnabled 也答复。 */
    balanceManual: boolean;
    /** 工作状态快照。 */
    workStatus: WorkStatusSnapshot | null;
    /** 工作状态变化次数。 */
    workStatusTick: number;
    /** 本宠物的说话指令；kind 为 clear 时收起气泡，其余弹气泡。 */
    say?: SayCue & { seq: number };
    /** 说话指令变化次数。 */
    sayTick: number;
    /** 本宠物的点播指令：name 是池内名，url 是第三方完整地址，两者恰好一个；
     *  facing 未指定时保持当前朝向（不回落 left）。
     */
    animCue?: { name?: string; url?: string; seq: number; playbackId?: string; facing?: PetFacing };
    animCueTick: number;
    /** 本宠物的位置指令：x/y 是宠物中心的归一化坐标，duration 仅 line 模式有效。 */
    posCue?: { x: number; y: number; mode: PositionMode; duration: number; seq: number };
    posCueTick: number;
    /** 本宠物的抛掷指令：angle 单位为度，0 为正右、逆时针为正。 */
    throwCue?: { angle: number; power: number; seq: number };
    throwCueTick: number;
    /** 本宠物的占用锁；expiresAt 是唯一过期真相，宿主不会推「锁没了」。 */
    lock?: LockState;
    lockTick: number;
    /** 第三方菜单项快照；传 ref 是因为只在右键那一刻读。 */
    menuItemsRef: ReactNS.MutableRefObject<MenuMoreItem[]>;
    /** 宠物间碰撞站场。 */
    arena: ReactNS.MutableRefObject<{ slots: Record<string, PetCollisionSlot> }>;
  }) {
    // 尺寸与派生几何。
    const [size, setSize] = useState(cfg.size);
    // 字号按本宠物尺寸算好注入 root，气泡与悬浮提示读它。
    const fontPx = resolveFontPx(cfg.font, size);
    const halfW = size / 2;
    const halfH = (size * 9) / 16 / 2;
    // 舞台脚底垫高：命中框 y、碰撞 body 框与 stage 位移共用。
    const bottomPad = (size * (9 / 16) * (CANVAS_H - FEET_Y)) / CANVAS_H;
    // 动画池与权重已在拍平时吹入 cfg，直接读，不做回落。
    const petAnims = cfg.animations;
    const petWeights = cfg.animationWeights;

    // React 状态。
    const [anim, setAnim] = useState(petAnims.idle[0] ?? '');
    const [once, setOnce] = useState(true);
    const [facing, setFacing] = useState('left' as 'left' | 'right');
    const [dragging, setDragging] = useState(false);
    // 悬浮提示显隐；指针捕获期间由拖拽逻辑主动收起。
    const [tipOn, setTipOn] = useState(false);
    const tipRef = useRef<HTMLDivElement | null>(null);
    const [customPos, setCustomPos] = useState<null | { rx: number; ry: number }>(null);
    // 初始角落与边距，可被容器更新覆盖。
    const [corner, setCorner] = useState<Corner>(cfg.position.corner);
    const [margin, setMargin] = useState({ x: cfg.position.marginX, y: cfg.position.marginY });
    // 余额气泡显隐，事件触发时显示，10s 后自动消失。
    const [bubbleOn, setBubbleOn] = useState(false);
    // 余额气泡展开页；每次重新弹出都归位到收起态。
    const [balanceViewIndex, setBalanceViewIndex] = useState(0);
    const bubbleTimerRef = useRef<number | null>(null);
    // 碎碎念气泡显隐，计时与余额气泡各自独立。
    const [whisperBubbleOn, setWhisperBubbleOn] = useState(false);
    const whisperBubbleTimerRef = useRef<number | null>(null);
    // 碎碎念文本与配图名，配图名由 host 随机抽定并随文本一起来。
    const [whisperText, setWhisperText] = useState<string | null>(null);
    const [whisperImage, setWhisperImage] = useState<string | undefined>(undefined);
    /** 配图的 url 形态，与 whisperImage 二选一。 */
    const [whisperUrl, setWhisperUrl] = useState<string | undefined>(undefined);
    // 工作状态气泡：终态 10s 收起，非终态常驻。
    const [workBubbleOn, setWorkBubbleOn] = useState(false);
    const workBubbleTimerRef = useRef<number | null>(null);
    const [workText, setWorkText] = useState<string | null>(null);
    // 右键菜单当前的 close 句柄，卸载或重开前清理。
    const menuRef = useRef<{ close: () => void } | null>(null);
    // 对话弹窗当前的 close 句柄，卸载或重开前清理。
    const chatRef = useRef<{ close: () => void } | null>(null);

    // 配置变化即时跟随，容器重新合并或设置页保存后触发。
    useEffect(() => {
      setSize(cfg.size);
      setCorner(cfg.position.corner);
      setMargin({ x: cfg.position.marginX, y: cfg.position.marginY });
    }, [cfg.size, cfg.position.corner, cfg.position.marginX, cfg.position.marginY]);
    const [seq, setSeq] = useState(0);

    // DOM 与状态 refs。
    const rootRef = useRef<HTMLDivElement | null>(null);
    const stageRef = useRef<HTMLDivElement | null>(null);
    const videoARef = useRef<HTMLVideoElement | null>(null);
    const videoBRef = useRef<HTMLVideoElement | null>(null);
    const frontRef = useRef(0);
    const pendingRef = useRef<null | { anim: string; once: boolean; gen: number }>(null);
    /** url 形态的一次性交接位；用 ref 是因为清空本身不应再触发一次 effect。 */
    const cueUrlRef = useRef<string | null>(null);
    // 点播编号随 anim 经 state 下发；目标动画与当前相同时客户端不换源，
    // state 变化会再驱动一次 effect 落到防重分支，从而如实回 playing。
    // 用 ref 会把这个编号留到后续自播换源上。
    const [cuePlayback, setCuePlayback] = useState<string | null>(null);
    /** 当前正在播的第三方点播编号，null 表示自播动画；播完、失败或被打断后清空。 */
    const playingPlaybackRef = useRef<string | null>(null);
    const genRef = useRef(0);
    // 占用锁：冻结期间只挡自播行为，显式指令照常。
    // frozenRef 初值从叶子算，刷新后的第一帧就是冻的；用 ref 是因为它不参与渲染，
    // 随机链入口与事件 effect 需要在更早的闭包里读到「此刻」。
    const frozenRef = useRef(lock?.locked === true && lock.expiresAt > Date.now());
    /** 解冻定时器：宿主不会推「锁没了」，这里按叶子里的 expiresAt 自行解除。 */
    const lockTimerRef = useRef<number | null>(null);
    const dragRef = useRef({
      active: false,
      dragging: false,
      sx: 0,
      sy: 0,
      offX: 0,
      offY: 0,
      // 触屏长按定时器；null 表示当前没有待触发的长按。
      lpTimer: null as ReturnType<typeof setTimeout> | null,
      // 弹弓：本次拖拽按拉距算力度；anchorX/Y 是按下时的宠物中心。
      sling: false,
      anchorX: 0,
      anchorY: 0,
    });
    const justDraggedRef = useRef(false);
    // 拖拽抛掷物理状态：轨迹样本、包围盒左上角、弹簧目标与速度、各 rAF 句柄。
    const dragTrailRef = useRef<DragSample[]>([]);
    const boxPxRef = useRef<{ x: number; y: number } | null>(null);
    const dragTargetRef = useRef<{ x: number; y: number } | null>(null);
    const dragVelRef = useRef({ vx: 0, vy: 0 });
    const dragFollowRef = useRef<number | null>(null);
    const dragFollowTokenRef = useRef(0);
    const throwRef = useRef<number | null>(null);
    const throwTokenRef = useRef(0);
    // 抛掷实时状态，供宠物间碰撞查询；落定清空。
    const throwStateRef = useRef<ThrowState | null>(null);
    // 本次按下是否已触发积分，防止松开的 click 再触发一次。
    const pressScoreFiredRef = useRef(false);
    // 上一次按下的时刻（0 表示未记录）：弹弓只比较两次按下的间隔。
    const lastPressAtRef = useRef(0);
    // Q 弹挤压：rAF 句柄与待压标记，等新动画成为前台后再压新首帧。
    const squashRef = useRef<number | null>(null);
    const squashTokenRef = useRef(0);
    const pendingSquashRef = useRef(false);
    const animRef = useRef(anim);
    animRef.current = anim;
    // workStatus 最新值同步：onended 闭包注册时可能早于状态更新，护栏用 ref 读当前值。
    const workStatusRef = useRef(workStatus);
    workStatusRef.current = workStatus;
    // fetch + blob 素材加载：两个视频槽各自的 blob URL，换新前 revoke。
    const blobUrlRef = useRef<{ a: string | null; b: string | null }>({ a: null, b: null });
    // 卸载竞态防护：mountedRef 由 effect 维护，inflightRef 记录在途 fetch；
    // 卸载时统一 abort，否则卸载后完成的 fetch 会创建无人回收的 blob URL。
    const mountedRef = useRef(false);
    const inflightRef = useRef<AbortController[]>([]);

    /** 上报第三方点播的真实状态；自播动画不报。
     *  host 只知道受理，不知道播放结果，浏览器侧是唯一真相；失败只 warn，不影响播放。
     */
    const reportPlayback = (playbackId: string, status: string, reason?: string): void => {
      void postAction(
        '/dsh-pet-7340/playback/' + encodeURIComponent(playbackId) + '/report',
        reason === undefined ? { status } : { status, reason },
      ).then((ok: boolean) => {
        if (!ok) {
          console.warn('[dsh-pet] 播放回执未送达 pet=' + cfg.id + ' id=' + playbackId + ' status=' + status);
        }
      });
    };

    /** 切换视频源并驱动 A/B 双缓冲播放。 */
    const switchTo = (next: string, nextOnce: boolean, cuePlaybackId: string | null) => {
      // 一次性消费点播编号：清空会再跑一趟 effect，那一趟落入防重分支。
      if (cuePlaybackId !== null) setCuePlayback(null);
      // url 交接位同样一次性取走并清空，必须早于任何 return：否则防重分支提前返回时，
      // 它会留到下一次普通换源，把那个动画误播成这个地址。
      const cueUrl = cueUrlRef.current;
      cueUrlRef.current = null;
      if (!next) return;
      const pending = pendingRef.current;
      if (pending && pending.anim === next && pending.once === nextOnce) {
        // 防重命中时仍消费 Q 弹标记，压当前前台视频，保证点击唯一动画时反馈不丢。
        if (pendingSquashRef.current) {
          pendingSquashRef.current = false;
          const front = frontRef.current === 0 ? videoARef : videoBRef;
          if (front.current) startSquash(front.current);
        }
        // 目标本来就在播：没有换源但确实在播，如实回 playing，避免调用方干等 timeout。
        if (cuePlaybackId !== null) {
          playingPlaybackRef.current = cuePlaybackId;
          reportPlayback(cuePlaybackId, 'playing');
        }
        return;
      }
      const gen = ++genRef.current;
      pendingRef.current = { anim: next, once: nextOnce, gen };
      const target = frontRef.current === 0 ? videoBRef : videoARef;
      const el = target.current;
      if (!el) return;
      // 诊断日志：事件池动画被切换时打印，once 反映 loop 语义。
      const inEvents = isEventAnim(petAnims.events, next);
      if (inEvents) {
        console.log(
          '[dsh-pet] ' +
            new Date().toTimeString().slice(0, 8) +
            ' pet=' +
            cfg.id +
            ' switch ' +
            next +
            ' once=' +
            nextOnce,
        );
      }
      // 素材地址：url 形态直接用第三方的完整地址，host 已限 http/https；
      // name 形态按「素材根 + 名字」拼路径，后续 fetch + blob 两条路共用。
      const assetUrl =
        cueUrl ??
        '/dsh-pet-7340/thumb/' +
          encodeURIComponent(cfg.assetRoot ?? cfg.id) +
          '/' +
          encodeURIComponent(next) +
          thumbExt();
      el.loop = !nextOnce;
      el.muted = true;
      el.autoplay = true;
      el.playsInline = true;
      el.onended = nextOnce ? handleEnded : null;
      // 元素级解码失败只补一条回执，不改播放控制；换源时与 onended 一起清掉。
      el.onerror = cuePlaybackId === null ? null : () => reportPlayback(cuePlaybackId, 'failed', 'decode-error');
      // fetch + blob 一次拿全文件，绕开 video 流式加载在 DSH WebServer 上偶发的 stalled。
      // cache 用默认策略：服务端 max-age=3600，有效期内不走网络；不能用 force-cache，
      // 否则用户把自定义动画换成同名文件后仍会一直看到旧缓存。
      const targetIsB = frontRef.current === 0;
      const ac = new AbortController();
      inflightRef.current.push(ac);
      const fetchTimer = window.setTimeout(() => ac.abort(), 10000);
      fetch(assetUrl, { cache: 'default', signal: ac.signal })
        .then((r) => {
          if (!r.ok) throw new Error('asset HTTP ' + r.status);
          return r.blob();
        })
        .then((blob) => {
          window.clearTimeout(fetchTimer);
          const ix = inflightRef.current.indexOf(ac);
          if (ix !== -1) inflightRef.current.splice(ix, 1);
          if (!mountedRef.current) return; // 已卸载：不再创建 blob URL 或操作已 detach 的 video。
          if (pendingRef.current?.gen !== gen) return; // 已被更新的切换覆盖：丢弃本次加载。
          const slot = targetIsB ? 'b' : 'a';
          const oldUrl = blobUrlRef.current[slot];
          if (oldUrl) URL.revokeObjectURL(oldUrl);
          const obj = URL.createObjectURL(blob);
          blobUrlRef.current[slot] = obj;
          el.src = obj;
          el.load();
        })
        .catch((err) => {
          window.clearTimeout(fetchTimer);
          const ix = inflightRef.current.indexOf(ac);
          if (ix !== -1) inflightRef.current.splice(ix, 1);
          if (!mountedRef.current) return; // 卸载后的 abort：静默。
          if (pendingRef.current?.gen !== gen) return; // 已被更新的切换覆盖。
          pendingRef.current = null; // 释放挂起的 pending，避免后续点击困在防重循环里。
          // 素材没拿到，这段点播不可能播起来，如实回 failed。
          if (cuePlaybackId !== null) {
            if (playingPlaybackRef.current === cuePlaybackId) playingPlaybackRef.current = null;
            reportPlayback(cuePlaybackId, 'failed', 'asset-load');
          }
          console.warn(
            '[dsh-pet] 素材加载失败 pet=' +
              cfg.id +
              ' anim=' +
              next +
              '：' +
              (err instanceof Error ? err.message : String(err)) +
              '（已释放本次切换）',
          );
        });
      const onReady = () => {
        el.removeEventListener('loadeddata', onReady);
        if (pendingRef.current?.gen !== gen) return;
        const old = frontRef.current === 0 ? videoARef : videoBRef;
        el.classList.add('is-front');
        if (old.current && old.current !== el) {
          old.current.classList.remove('is-front');
          // 降级为背景的视频若继续播完，残留的 onended 会掐断当前前台动画；清 handler 并停播。
          old.current.onended = null;
          old.current.onerror = null;
          old.current.pause();
          // 被换下的第三方点播若没播完，如实回 cancelled；这里补的是点击、拖拽等非点播打断。
          const outgoing = playingPlaybackRef.current;
          if (outgoing !== null && outgoing !== cuePlaybackId) {
            reportPlayback(outgoing, 'cancelled', 'superseded');
          }
        }
        frontRef.current = frontRef.current === 0 ? 1 : 0;
        pendingRef.current = null;
        playingPlaybackRef.current = cuePlaybackId;
        el.style.transform = facingRef.current === 'right' ? 'scaleX(-1)' : '';
        el.play()
          .then(() => {
            // 只有 play() 兑现才代表确实开始出画，loadeddata 只代表可解码。
            if (cuePlaybackId !== null) reportPlayback(cuePlaybackId, 'playing');
          })
          .catch(() => {
            // 自动播放被拒或元素不可播：如实回 failed，不改播放控制。
            if (cuePlaybackId === null) return;
            if (playingPlaybackRef.current === cuePlaybackId) playingPlaybackRef.current = null;
            reportPlayback(cuePlaybackId, 'failed', 'play-rejected');
          });
        // 点击 Q 弹：等新动画就位后才压，压的是新点击动画的首帧。
        if (pendingSquashRef.current) {
          pendingSquashRef.current = false;
          startSquash(el);
        }
        if (pendingMoveRef.current) startMoveDrive(el);
      };
      el.addEventListener('loadeddata', onReady);
    };

    // 状态驱动播放。
    useEffect(() => {
      switchTo(anim, once, cuePlayback);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖由 anim/once/seq/cuePlayback 的换源身份决定；补 switchTo（每渲染重建）会让 effect 每渲染重跑，防重分支提前消费 pendingSquash 标记，Q 弹压到旧前台帧
    }, [anim, once, seq, cuePlayback]);
    useEffect(() => {
      mountedRef.current = true;
      // 把本页这只宠物的实时位置与朝向注册给只读服务 petApi7340（见 ./pose）；
      // 消费者按需读闭包，拖拽、抛掷中途也能拿到当前值，不是快照。
      const unregisterPose = registerPose(cfg.id, () => ({
        x: currentCenterX() / window.innerWidth,
        y: currentCenterY() / window.innerHeight,
        facing: facingRef.current,
      }));
      // 播放进度走同一个 Cordis 入口（见 ./progress）；读前台 video，A/B 切换期间读 back 会跳。
      const unregisterProgress = registerProgress(cfg.id, () => {
        const el = frontRef.current === 0 ? videoARef.current : videoBRef.current;
        const playbackId = playingPlaybackRef.current;
        const anim = animRef.current;
        if (el === null) {
          // 首帧还没挂上元素，给可解析的零值，别让调用方拿到 undefined。
          return { playbackId, anim, currentTime: 0, duration: 0, paused: true, buffering: false };
        }
        // duration 在元数据就绪前是 NaN，统一成 0。
        const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
        return {
          playbackId,
          anim,
          currentTime: el.currentTime,
          duration,
          paused: el.paused,
          buffering: el.readyState < 3 || el.seeking,
        };
      });
      const bu = blobUrlRef.current;
      const inflight = inflightRef.current;
      return () => {
        mountedRef.current = false;
        unregisterPose(); // 卸载即摘除：静默失效比读到陈旧值安全。
        unregisterProgress();
        for (const c of inflight) c.abort();
        inflight.length = 0;
        stopMove();
        stopDragFollow();
        stopThrow();
        stopSquash();
        if (bu.a) URL.revokeObjectURL(bu.a);
        if (bu.b) URL.revokeObjectURL(bu.b);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载/卸载各跑一次：闭包读的是 refs 与稳定 props
    }, []);
    useEffect(
      () => () => {
        if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
        if (whisperBubbleTimerRef.current !== null) window.clearTimeout(whisperBubbleTimerRef.current);
      },
      [],
    );
    // 卸载时关闭可能开着的右键菜单与对话弹窗。
    useEffect(
      () => () => {
        if (menuRef.current) {
          menuRef.current.close();
          menuRef.current = null;
        }
        if (chatRef.current) {
          chatRef.current.close();
          chatRef.current = null;
        }
      },
      [],
    );
    // 余额事件：按档位播事件动画并弹气泡。手动请求无条件弹，自动轮询要求开启且有百分比；
    // 档位动画始终只属于启用余额的宠物。
    const prevTickRef = useRef(0);
    useEffect(() => {
      if (balanceTick === 0 || balanceTick === prevTickRef.current) return;
      prevTickRef.current = balanceTick;
      // 占用锁：自动余额不看，手动请求照常；tick 消费之后再判，占用期间这一拍就当过去。
      if (frozenRef.current && !balanceManual) return;
      if (!balance || !balance.ok) return;
      if (!cfg.balanceEnabled && !balanceManual) return; // 自动轮询受开关门控，手动请求无条件通过。
      const p = balancePercent(balance);
      // 自动轮询的弹出门槛：内置形态要求有百分比；custom 不看百分比，内容由第三方设计。
      if (balanceManual || p !== undefined || balance.shape === 'custom') {
        setBalanceViewIndex(0); // 新一轮查询从第一页开始。
        setBubbleOn(true);
        // 气泡 10s 定时消失，与动画解耦；重复触发先清旧定时器。
        if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
        bubbleTimerRef.current = window.setTimeout(() => setBubbleOn(false), BUBBLE_DURATION_MS);
      }
      if (!cfg.balanceEnabled) return; // 档位动画只属于启用余额的宠物。
      if (p === undefined) return; // 当前数据源没有百分比语义，不触发档位动画。
      const pool = petAnims.events?.balance;
      if (!pool || pool.length === 0) {
        console.error('[dsh-pet] 配置缺少 animations.events.balance，无法播放余额事件动画');
        return;
      }
      const idx = balanceEventIndex(p);
      const slot = pool[idx];
      if (!slot) {
        console.error('[dsh-pet] balance 档位索引越界：p=' + p + ' idx=' + idx);
        return;
      }
      const name = pickSlot(slot, animRef.current); // 档内随机抽 1，并避开当前正播动画。
      console.log(
        '[dsh-pet] ' +
          new Date().toTimeString().slice(0, 8) +
          ' balance pet=' +
          cfg.id +
          ' p=' +
          p.toFixed(1) +
          '% -> [档' +
          idx +
          '] ' +
          name,
      );
      stopMove();
      setOnce(true);
      setAnim(name);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖由 balanceTick 事件驱动：余额与 tick 在 applyBalance 里同批写入，prevTick 守卫保证一拍只播一次；补 balance/cfg 只会让无关重渲染空跑
    }, [balanceTick]);

    // 余额不可用：容器递增 balanceNoticeTick，本宠物只弹文字说明，不播档位动画；
    // 手动请求无条件弹，自动轮询受 balanceEnabled 门控。
    const prevNoticeRef = useRef(0);
    useEffect(() => {
      if (!cfg.balanceEnabled && !balanceManual) return; // 自动轮询受开关门控，手动请求无条件通过。
      if (balanceNoticeTick === 0 || balanceNoticeTick === prevNoticeRef.current) return;
      prevNoticeRef.current = balanceNoticeTick;
      // 占用锁：自动来源不看，手动请求照常。
      if (frozenRef.current && !balanceManual) return;
      if (!balance || balance.ok) return;
      setBubbleOn(true);
      if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
      bubbleTimerRef.current = window.setTimeout(() => setBubbleOn(false), BUBBLE_DURATION_MS);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖由 balanceNoticeTick 事件驱动：balance 与 tick 同批写入，同一原因只由 decideBalanceNotice 去重后递增一次；补 balance/cfg 只会让无关重渲染空跑
    }, [balanceNoticeTick]);

    // 工作状态联动：按 events.workStatus 档位播动画并弹文本气泡。
    // 非终态（thinking/working/result/waiting）常驻并循环；终态（success/error）10s 收起并播一遍。
    // state 为 null 时收起气泡回待机。
    const prevWorkTickRef = useRef(0);
    // 调试日志：上一档位，null 表示空闲，undefined 表示启动后尚未触发。
    const prevWorkStateRef = useRef<string | null | undefined>(undefined);
    useEffect(() => {
      if (!cfg.workStatusEnabled) return; // 未启用工作状态联动，该宠物完全免疫。
      if (workStatusTick === 0 || workStatusTick === prevWorkTickRef.current) return;
      prevWorkTickRef.current = workStatusTick;
      // 占用锁：工作状态是自动来源，锁生效时不响应；解冻时由 applyFreeze 重新对齐当前状态。
      // 不挡宿主写入：sections.workStatus 是所有宠物共用一份，按宠物在渲染端忽略。
      if (frozenRef.current) return;
      if (!workStatus || workStatus.state === null) {
        // 调试日志：状态回空闲，动画改成播完即停。
        console.log(
          '[dsh-pet] ' +
            new Date().toTimeString().slice(0, 8) +
            ' pet=' +
            cfg.id +
            ' ' +
            (prevWorkStateRef.current ?? 'null') +
            '->null    播完即停（回待机，收起气泡）',
        );
        prevWorkStateRef.current = null;
        // 回空闲时把循环中的工作动画改成「播完即停」：否则 ended 永不触发，动画链拿不到
        // 推进信号，宠物会一直卡在工作动画上。
        if (poolIncludes(petAnims.events?.workStatus ?? [], animRef.current)) {
          const front = frontRef.current === 0 ? videoARef.current : videoBRef.current;
          if (front) {
            front.loop = false;
            front.onended = handleEnded;
          }
        }
        // 空闲：收起常驻气泡。
        if (workBubbleTimerRef.current !== null) window.clearTimeout(workBubbleTimerRef.current);
        workBubbleTimerRef.current = null;
        setWorkText(null);
        setWorkBubbleOn(false);
        return;
      }
      const pool = petAnims.events?.workStatus;
      if (!pool || pool.length === 0) {
        console.error('[dsh-pet] 配置缺少 animations.events.workStatus，无法播放工作状态动画');
        return;
      }
      const idx = WORK_STATUS_INDEX[workStatus.state];
      const slot = pool[idx];
      if (slot === undefined) {
        console.error('[dsh-pet] work-status 档位索引越界：state=' + workStatus.state + ' idx=' + idx);
        return;
      }
      const name = pickSlot(slot, animRef.current); // 档内随机抽 1，并避开当前正播动画。
      console.log(
        '[dsh-pet] ' +
          new Date().toTimeString().slice(0, 8) +
          ' pet=' +
          cfg.id +
          ' ' +
          (prevWorkStateRef.current ?? 'null') +
          '->' +
          workStatus.state +
          '    ' +
          name,
      );
      const stateChanged = prevWorkStateRef.current !== workStatus.state;
      prevWorkStateRef.current = workStatus.state;
      stopMove();
      // 气泡文本：任务详情优先，否则从 workStatusTexts[档位] 随机抽一句。
      const textGroup = Array.isArray(cfg.workStatusTexts) ? cfg.workStatusTexts[idx] : undefined;
      const configuredText =
        Array.isArray(textGroup) && textGroup.length > 0
          ? textGroup[Math.floor(Math.random() * textGroup.length)]
          : undefined;
      // 文本总是更新，任务详情可能在同一状态下变化。
      setWorkText(workStatus.task ?? configuredText ?? null);
      const terminal = workStatus.state === 'success' || workStatus.state === 'error';
      // 只在状态变化时点亮或收起气泡：同状态后续 tick 不重新点亮已自动收起的终态气泡。
      if (stateChanged) {
        setWorkBubbleOn(true);
        if (workBubbleTimerRef.current !== null) window.clearTimeout(workBubbleTimerRef.current);
        workBubbleTimerRef.current = terminal
          ? window.setTimeout(() => setWorkBubbleOn(false), BUBBLE_DURATION_MS)
          : null; // 非终态常驻，不设自动收起。
      }
      // 循环语义：终态播一遍；非终态单候选无限循环，多候选播一遍后由 handleEnded 轮换。
      const rotating = !terminal && Array.isArray(slot) && slot.length > 1;
      setOnce(terminal || rotating);
      setAnim(name);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖由 workStatusTick 事件驱动：workStatus 与 tick 同批写入，prevWorkTick 守卫保证一拍一次；补 workStatus/cfg 只会让无关渲染空跑
    }, [workStatusTick]);

    // 说话（碎碎念、命令气泡、对话回复、清空）：seq 变化即执行 clear 或弹气泡。
    // 唯一数据源是 /state，首拉基线由容器统一处理；whisperEnabled 只关自动周期。
    const prevSaySeqRef = useRef(0);
    useEffect(() => {
      if (!say || say.seq === prevSaySeqRef.current) return;
      prevSaySeqRef.current = say.seq;
      if (say.kind === 'clear') {
        clearWhisperBubble();
        return;
      }
      triggerWhisper(say.text, say.image, say.url, say.duration, say.anim);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖由 sayTick 事件驱动：say 由容器写进 ref 并按 tick 分发，seq 在本 effect 内一次性消费；补 say/triggerWhisper（每渲染重建）只会让无关渲染空跑（seq 守卫挡重复弹）
    }, [sayTick]);

    // 点播动画：seq 变化即播，复用右键菜单的处理函数，镜像修正与移动语义天然一致。
    const prevAnimSeqRef = useRef(0);
    useEffect(() => {
      if (!animCue || animCue.seq === prevAnimSeqRef.current) return;
      prevAnimSeqRef.current = animCue.seq;
      // facing 必须在换源前落地，并同步 facingRef：switchTo 在 onReady 里读它。
      // 未传 facing 时保持当前朝向，不回落 left。
      const explicitFacing = animCue.facing !== undefined;
      if (animCue.facing !== undefined) {
        setFacing(animCue.facing);
        facingRef.current = animCue.facing;
      }
      // url 形态只插播一段：停漫游、换源播一次，播完由 handleEnded 回正常动画链；
      // 不走 handleMenuAction——裸地址没有文字类、移动类这些菜单属性。
      if (animCue.url !== undefined) {
        stopMove();
        cueUrlRef.current = animCue.url;
        setOnce(true);
        setSeq((s) => s + 1); // 同一地址连播两次时状态不变，递增 seq 强制 switchTo 走一遍。
        setAnim(animCue.url);
        setCuePlayback(animCue.playbackId ?? null);
        return;
      }
      if (animCue.name === undefined) return;
      // keepFacing：显式指定的朝向优先于「文字类强制朝左」的镜像修正。
      handleMenuAction({ label: animCue.name, anim: animCue.name }, animCue.playbackId, explicitFacing);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖由 animCueTick 事件驱动：animCue 由容器写进 ref 并按 tick 分发，seq 在本 effect 内一次性消费；补 animCue/handleMenuAction（每渲染重建）会让无关渲染重跑并重入点播分支
    }, [animCueTick]);

    // 位置指令：seq 变化即执行，用户正按着宠物时整拍丢弃。
    const prevPosSeqRef = useRef(0);
    useEffect(() => {
      if (!posCue || posCue.seq === prevPosSeqRef.current) return;
      prevPosSeqRef.current = posCue.seq;
      applyPositionCue(posCue.x, posCue.y, posCue.mode, posCue.duration);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖由 posCueTick 事件驱动：posCue 由容器写进 ref 并按 tick 分发，seq 在本 effect 内一次性消费；补 posCue/applyPositionCue（每渲染重建）只会让无关渲染空跑
    }, [posCueTick]);

    // 抛掷指令：seq 变化即执行。
    const prevThrowSeqRef = useRef(0);
    useEffect(() => {
      if (!throwCue || throwCue.seq === prevThrowSeqRef.current) return;
      prevThrowSeqRef.current = throwCue.seq;
      applyThrowCue(throwCue.angle, throwCue.power);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖由 throwCueTick 事件驱动：throwCue 由容器写进 ref 并按 tick 分发，seq 在本 effect 内一次性消费；补 throwCue/applyThrowCue（每渲染重建）只会让无关渲染空跑
    }, [throwCueTick]);

    /** 收起说话气泡；只动气泡，不碰动画、余额与工作状态气泡。 */
    const clearWhisperBubble = () => {
      if (whisperBubbleTimerRef.current !== null) window.clearTimeout(whisperBubbleTimerRef.current);
      whisperBubbleTimerRef.current = null;
      setWhisperBubbleOn(false);
      setWhisperText(null);
      setWhisperImage(undefined);
    };

    // 碎碎念：随机抽 events.whisper 动画并弹文本气泡，两者独立。
    // anim 为 false 时跳过动画联动；duration 为 0 时不改动当前气泡。
    // image 是池内名（按素材根拼路径），url 是第三方完整地址，两者互斥。
    const triggerWhisper = (text: string, image?: string, url?: string, duration?: number, anim?: boolean) => {
      let name: string | null = null;
      if (anim !== false) {
        const pool = petAnims.events?.whisper;
        if (!pool || pool.length === 0) {
          console.error('[dsh-pet] 配置缺少 animations.events.whisper，无法播放碎碎念动画');
          return;
        }
        // 整池随机抽 1 槽并避开当前正播动画；槽位为数组时再在档内随机。
        name = pickSlot(pick(pool, animRef.current), animRef.current);
      }
      console.log(
        '[dsh-pet] ' +
          new Date().toTimeString().slice(0, 8) +
          ' whisper pet=' +
          cfg.id +
          (name === null ? ' （不联动动画）' : ' -> [' + name + ']') +
          ' 「' +
          text +
          '」',
      );
      // 先起动画：动画与气泡时长是两个独立参数。
      if (name !== null) {
        stopMove();
        setOnce(true);
        setAnim(name);
      }
      if (duration === 0) return;
      setWhisperText(text);
      setWhisperImage(image);
      setWhisperUrl(url);
      setWhisperBubbleOn(true);
      // 气泡定时消失，与动画解耦；重复触发先清旧定时器。
      if (whisperBubbleTimerRef.current !== null) window.clearTimeout(whisperBubbleTimerRef.current);
      whisperBubbleTimerRef.current = window.setTimeout(
        () => setWhisperBubbleOn(false),
        duration ?? BUBBLE_DURATION_MS,
      );
    };
    useEffect(() => {
      const onResize = () => setCustomPos((prev) => (prev ? { ...prev } : prev));
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }, []);

    /** 按权重掷骰选择下一个自播动画。 */
    const pickNext = () => {
      // 占用锁：随机链唯一入口不掷骰，随机动画、转向、走位一起停住。
      if (frozenRef.current) return;
      const animations = petAnims;
      const animationWeights = petWeights;
      const roll = Math.random();
      // 宠物固定时，掷骰把「转向/移动」权重按 0 算；菜单点播与 /anim 不走这里。
      const k = rollKind(roll, animationWeights, { fixed: cfg.fixedEnabled });
      let kind: string;
      let next: string;
      if (k === 'idle') {
        kind = 'IDLE';
        next = pick(animations.idle, animRef.current);
        setAnim(next);
      } else if (k === 'turn') {
        kind = 'TURN';
        next = pick(animations.turn, animRef.current);
        setAnim(next);
      } else if (k === 'move') {
        const moved = tryMove();
        if (moved === false) {
          const act = pickCategoryAction(animations.categories, animations.idle, facingRef.current, animRef.current);
          kind = act.id;
          next = act.name;
          setAnim(next);
        } else {
          kind = 'MOVES';
          // 成功返回具体动作名；占用中返回 true（已有移动在进行）。
          next = typeof moved === 'string' ? moved : '移动进行中(不重播)';
        }
      } else {
        const act = pickCategoryAction(animations.categories, animations.idle, facingRef.current, animRef.current);
        kind = act.id;
        next = act.name;
        setAnim(next);
      }
      console.log(
        '[dsh-pet] ' +
          new Date().toTimeString().slice(0, 8) +
          ' pet=' +
          cfg.id +
          ' facing=' +
          facingRef.current +
          ' roll=' +
          roll.toFixed(4) +
          ' -> [' +
          kind +
          '] ' +
          next,
      );
      setOnce(true);
      setSeq((s) => s + 1);
    };

    // 互动结束恢复：非终态工作状态回到档位循环；无状态或终态返回 false，调用方走原逻辑。
    const resumeWorkStatusAnim = (): boolean => {
      // 锁定期间不由这条路恢复档位动画；解冻路径会先把 frozenRef 置 false 再调用。
      if (frozenRef.current) return false;
      const ws = workStatusRef.current;
      if (!ws || !ws.state || ws.state === 'success' || ws.state === 'error') return false;
      const pool = petAnims.events?.workStatus;
      if (!pool || pool.length === 0) return false;
      const idx = WORK_STATUS_INDEX[ws.state];
      const slot = pool[idx];
      if (slot === undefined) return false;
      const name = pickSlot(slot, animRef.current); // 档内随机抽 1，并避开当前正播动画。
      console.log(
        '[dsh-pet] ' + new Date().toTimeString().slice(0, 8) + ' pet=' + cfg.id + ' 互动结束恢复状态动画: ' + name,
      );
      // 多候选档位恢复后同样走 ended 轮换；单候选维持无限循环。
      setOnce(Array.isArray(slot) && slot.length > 1);
      setAnim(name);
      return true;
    };

    /** 前台视频播完后的动画链推进。 */
    const handleEnded = (e?: Event) => {
      // 只认前台视频的 ended：后台视频即便有残留事件也丢弃，防止掐断当前动画。
      const evEl = e && (e.currentTarget as HTMLVideoElement | null);
      if (evEl && !evEl.classList.contains('is-front')) return;
      // 播放回执放在拖拽守卫之前：「播完」是既成事实，不应受动画链推进逻辑影响。
      const donePlayback = playingPlaybackRef.current;
      if (donePlayback !== null) {
        playingPlaybackRef.current = null; // 先清再上报，后续换源不会把它当成被打断。
        reportPlayback(donePlayback, 'ended');
      }
      const animations = petAnims;
      if (dragRef.current.active) return;
      // 锁生效时动画链一律不推进：下面各分支都会按当前工作状态换源，effect 的门禁拦不住。
      // 最容易撞上的是「事件动画播完 → 恢复工作状态档位」，持锁者每投一次气泡就会触发。
      // 回执已在上方上报，不受这一行影响。
      if (frozenRef.current) return;
      // 事件动画播完回 idle，不进入随机链。
      const isEvent = isEventAnim(animations.events, animRef.current);
      // 非终态期间 workStatus 动画意外 ended 时续播或轮换，避免回 idle；其余事件动画仍回 idle。
      const wsNow = workStatusRef.current;
      if (isEvent && wsNow && wsNow.state && wsNow.state !== 'success' && wsNow.state !== 'error') {
        // 多候选档位播完自动轮换到下一候选，长时间状态不单段重复。
        const nextWork = nextWorkStatusAnim(animations.events?.workStatus ?? [], animRef.current);
        if (nextWork !== null) {
          console.log(
            '[dsh-pet] ' +
              new Date().toTimeString().slice(0, 8) +
              ' pet=' +
              cfg.id +
              ' workStatus 档内轮换: ' +
              animRef.current +
              ' -> ' +
              nextWork,
          );
          setOnce(true); // 保持 once=true，下一段播完再轮换。
          setAnim(nextWork);
          setSeq((s) => s + 1);
          return;
        }
        // 单候选档位意外 ended 时续播同一段。
        if (poolIncludes(animations.events?.workStatus ?? [], animRef.current)) {
          console.log(
            '[dsh-pet] ' +
              new Date().toTimeString().slice(0, 8) +
              ' pet=' +
              cfg.id +
              ' workStatus 循环续播: ' +
              animRef.current,
          );
          setOnce(false);
          setSeq((s) => s + 1);
          return;
        }
      }
      if (isEvent) {
        // 诊断日志：事件动画 ended 落地。
        console.log(
          '[dsh-pet] ' +
            new Date().toTimeString().slice(0, 8) +
            ' pet=' +
            cfg.id +
            ' 事件动画播完 ended anim=' +
            animRef.current +
            ' ws=' +
            ((workStatusRef.current && workStatusRef.current.state) || 'null'),
        );
        // 事件动画抢占播完后立即恢复档位循环，否则长事件期间会误入随机链。
        if (resumeWorkStatusAnim()) return;
        if (animations.idle.length) setAnim(pick(animations.idle, animRef.current));
        setOnce(true);
        setSeq((s) => s + 1);
        return;
      }
      if (animations.turn.includes(animRef.current)) {
        const next = facing === 'left' ? 'right' : 'left';
        setFacing(next);
        facingRef.current = next; // 立即同步，翻转后的 pickNext 用新朝向过滤 noMirror。
      }
      if (animations.drag.includes(animRef.current) || animations.clicks.includes(animRef.current)) {
        // 互动动画播完：非终态恢复状态循环，否则回 idle。
        if (resumeWorkStatusAnim()) return;
        if (animations.idle.length) setAnim(pick(animations.idle, animRef.current));
        setOnce(true);
        setSeq((s) => s + 1);
        return;
      }
      pickNext();
    };

    // 移动系统。
    const moveRef = useRef<number | null>(null);
    const moveTokenRef = useRef(0);
    const pendingMoveRef = useRef<null | {
      startRatio: number;
      startYRatio: number;
      targetRatio: number;
      dir: number;
      totalRatio: number;
      leadSec: number;
      tailSec: number;
    }>(null);
    const customPosRef = useRef(customPos);
    customPosRef.current = customPos;

    /** 当前宠物中心的视口 X 坐标。 */
    const currentCenterX = () => {
      const cp = customPosRef.current;
      if (cp) return cp.rx * window.innerWidth;
      const rootEl = rootRef.current;
      if (rootEl) return rootEl.getBoundingClientRect().left + halfW;
      return window.innerWidth - 24 - halfW;
    };
    /** 当前宠物中心的视口 Y 坐标。 */
    const currentCenterY = () => {
      const cp = customPosRef.current;
      if (cp) return cp.ry * window.innerHeight;
      const rootEl = rootRef.current;
      if (rootEl) return rootEl.getBoundingClientRect().top + halfH;
      return window.innerHeight - 20 - halfH;
    };

    /** 按视频播放时间推进自主走位。 */
    const startMoveDrive = (el: HTMLVideoElement) => {
      const pm = pendingMoveRef.current;
      if (!pm || moveRef.current !== null) return;
      pendingMoveRef.current = null;
      const { startRatio, startYRatio, targetRatio, dir, totalRatio, leadSec, tailSec } = pm;
      const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 10.09;
      const travelWindow = Math.max(0.1, duration - leadSec - tailSec);
      const token = ++moveTokenRef.current;
      const step = () => {
        if (moveTokenRef.current !== token) return;
        const t = el.currentTime || 0;
        const rootEl = rootRef.current;
        if (rootEl) {
          const W = window.innerWidth;
          const H = window.innerHeight;
          let ratioX;
          if (t <= leadSec) ratioX = startRatio;
          else if (t >= duration - tailSec) ratioX = targetRatio;
          else ratioX = startRatio + dir * totalRatio * ((t - leadSec) / travelWindow);
          const px = ratioX * W;
          const py = startYRatio * H;
          rootEl.style.left = px - halfW + 'px';
          rootEl.style.top = py - halfH + 'px';
          rootEl.style.right = 'auto';
          rootEl.style.bottom = 'auto';
        }
        if (t < duration - tailSec) moveRef.current = requestAnimationFrame(step);
        else {
          moveRef.current = null;
          setCustomPos({ rx: targetRatio, ry: startYRatio });
        }
      };
      moveRef.current = requestAnimationFrame(step);
    };

    /** 尝试发起一次移动：占用中返回 true，无法移动返回 false，成功返回动作名。
     *  preferredName 用于菜单点播，否则随机从 moves.actions 选。 */
    const tryMove = (preferredName?: string): boolean | string => {
      if (moveRef.current !== null || pendingMoveRef.current || throwRef.current !== null) return true;
      const moves = petAnims.moves;
      const actions = moves.actions;
      if (!actions.length) return false;
      const chosen = preferredName
        ? (actions.find((a) => a.name === preferredName) ?? null)
        : actions[Math.floor(Math.random() * actions.length)];
      if (!chosen) return false;
      const mp = Object.assign({}, moves.default, chosen.params || {});
      // 走路方向只看当前 facing；不要用 turn 动画反推方向，facingRef 已在 handleEnded 即时同步。
      const dir = facingRef.current === 'right' ? 1 : -1;
      const W = window.innerWidth;
      // 移动距离随宠物缩放：minDist/maxDist 是基准尺寸下的 px，按 size / 基准等比缩放。
      const distScale = size / PET_REF_WIDTH;
      const plan = planMove({
        cx: currentCenterX(),
        cy: currentCenterY(),
        W,
        H: window.innerHeight,
        dir,
        minDist: mp.minDist * distScale,
        maxDist: mp.maxDist * distScale,
        margin: mp.margin,
        halfW,
        sideAllow,
      });
      if (!plan) return false;
      pendingMoveRef.current = {
        ...plan,
        dir,
        leadSec: mp.leadSec,
        tailSec: mp.tailSec,
      };
      setOnce(true);
      setAnim(chosen.name);
      return chosen.name;
    };
    /** 停止自主走位与位置跟随。 */
    const stopMove = () => {
      pendingMoveRef.current = null;
      moveTokenRef.current++;
      if (moveRef.current !== null) {
        cancelAnimationFrame(moveRef.current);
        moveRef.current = null;
      }
      // 位置跟随的弹簧也是自主移动，停走路时必须一并停掉，否则两套运动同时改 DOM 位置。
      stopPosFollow();
    };

    // 拖拽抛掷物理：与桌面同构，纯计算在 shared/physics.ts。
    /** 停止弹簧跟随，不碰指针捕获状态。 */
    const stopDragFollow = () => {
      dragFollowTokenRef.current++;
      if (dragFollowRef.current !== null) {
        cancelAnimationFrame(dragFollowRef.current);
        dragFollowRef.current = null;
      }
      dragTargetRef.current = null;
      dragVelRef.current = { vx: 0, vy: 0 };
    };
    /** 停止抛掷并清空速度状态，否则抓住后放下会残留飞行速度。 */
    const stopThrow = () => {
      throwTokenRef.current++;
      if (throwRef.current !== null) {
        cancelAnimationFrame(throwRef.current);
        throwRef.current = null;
      }
      throwStateRef.current = null;
    };
    /** rAF 弹簧跟随：包围盒过阻尼追赶拖拽目标，抹平高频抖动。 */
    const startDragFollow = (rootEl: HTMLDivElement) => {
      if (dragFollowRef.current !== null) return;
      const token = ++dragFollowTokenRef.current;
      let last = performance.now();
      const step = () => {
        if (dragFollowTokenRef.current !== token) return;
        const target = dragTargetRef.current;
        if (!target) {
          dragFollowRef.current = null;
          return;
        }
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, 1 / 30);
        last = now;
        const vel = dragVelRef.current;
        let x = boxPxRef.current?.x ?? 0;
        let y = boxPxRef.current?.y ?? 0;
        vel.vx = springStep(vel.vx, x, target.x, dt, cfg.physics.throwPower);
        vel.vy = springStep(vel.vy, y, target.y, dt, cfg.physics.throwPower);
        x += vel.vx * dt;
        y += vel.vy * dt;
        boxPxRef.current = { x, y };
        rootEl.style.left = x + 'px';
        rootEl.style.top = y + 'px';
        rootEl.style.right = 'auto';
        rootEl.style.bottom = 'auto';
        dragFollowRef.current = requestAnimationFrame(step);
      };
      dragFollowRef.current = requestAnimationFrame(step);
    };
    /** 抛掷驱动：重力、边缘反弹与落地摩擦；飞行中只改 DOM，落定后提交 customPos。 */
    const startThrow = (px: number, py: number, vx: number, vy: number) => {
      stopDragFollow();
      stopMove();
      const bounds = throwBounds({ W: window.innerWidth, H: window.innerHeight, size, sideAllow });
      const token = ++throwTokenRef.current;
      let state: ThrowState = { x: px, y: py, vx, vy };
      let last = performance.now();
      let prevGrounded = false; // 落地 Q 弹只在空中到地面的转换帧触发一次。
      const rootEl = rootRef.current;
      const step = () => {
        if (throwTokenRef.current !== token) return;
        const now = performance.now();
        const dt = (now - last) / 1000;
        last = now;
        const fallingVy = state.vy; // 本帧积分前的竖直速度，即落地冲击速度。
        // 细分积分：弹弓一帧可能跨过上百 px，不拆会跳过落地与反弹帧，漏掉 Q 弹和 atRest。
        const substeps = throwSubsteps(state.vx, state.vy, dt);
        let res = throwStep(state, dt / substeps, bounds, cfg.physics);
        for (let i = 1; i < substeps && !res.atRest; i++) {
          res = throwStep(res, dt / substeps, bounds, cfg.physics);
        }
        state = { x: res.x, y: res.y, vx: res.vx, vy: res.vy };
        throwStateRef.current = state;
        // 宠物间碰撞：仅 petCollision 开启时处理。
        if (cfg.physics.petCollision) {
          const myBody = bodyPixelBox({ x: state.x, y: state.y, size, bottomPad });
          for (const slotId of Object.keys(arena.current.slots)) {
            if (slotId === cfg.id) continue;
            const slot = arena.current.slots[slotId];
            const otherBox = slot.getBox();
            if (!otherBox) continue;
            const otherBody = bodyPixelBox({
              x: otherBox.x,
              y: otherBox.y,
              size: slot.size,
              bottomPad: slot.bottomPad,
            });
            if (!rectsOverlap(myBody, otherBody)) continue;
            const vel = slot.getVel();
            const hit = collidePet(
              { x: state.x, y: state.y, vx: state.vx, vy: state.vy, size },
              { x: otherBox.x, y: otherBox.y, vx: vel.vx, vy: vel.vy, size: slot.size },
            );
            if (hit) {
              // 飞行方按动量继续弹开；被撞方回调 onHit，以新初速抛出去。
              state.vx = hit.fvx;
              state.vy = hit.fvy;
              throwStateRef.current = state;
              slot.onHit(hit.hvx, hit.hvy);
              break; // 一帧只处理一次碰撞，避免连锁抖动。
            }
          }
        }
        if (rootEl) {
          rootEl.style.left = res.x + 'px';
          rootEl.style.top = res.y + 'px';
          rootEl.style.right = 'auto';
          rootEl.style.bottom = 'auto';
        }
        boxPxRef.current = { x: res.x, y: res.y };
        customPosRef.current = {
          rx: (res.x + halfW) / window.innerWidth,
          ry: (res.y + halfH) / window.innerHeight,
        };
        // 落地 Q 弹：只在空中到地面的转换帧触发，力度随冲击速度。
        const grounded = res.y >= bounds.maxY - 1;
        if (res.bounced && grounded && !prevGrounded) {
          const frontEl = frontRef.current === 0 ? videoARef.current : videoBRef.current;
          if (frontEl) startSquash(frontEl, landingSquash(fallingVy));
        }
        prevGrounded = grounded;
        if (res.atRest) {
          throwRef.current = null;
          throwStateRef.current = null;
          setCustomPos(customPosRef.current);
          return;
        }
        throwRef.current = requestAnimationFrame(step);
      };
      throwRef.current = requestAnimationFrame(step);
    };
    /** 最新的 startThrow 引用，供碰撞回调转发，避免陈旧闭包。 */
    const startThrowLatestRef = useRef<(px: number, py: number, vx: number, vy: number) => void>(() => {});
    startThrowLatestRef.current = startThrow;

    // 位置与抛掷指令：seq 变化即执行，复用既有运动路径，不新写运动学。
    /** 位置指令的跟随 rAF，spring 与 line 共用；有终点，收敛或到点后必须自己收掉。 */
    const posFollowRef = useRef<number | null>(null);
    const posFollowTokenRef = useRef(0);

    /** 停止位置跟随。 */
    const stopPosFollow = () => {
      posFollowTokenRef.current++;
      if (posFollowRef.current !== null) {
        cancelAnimationFrame(posFollowRef.current);
        posFollowRef.current = null;
      }
    };

    /** 执行位置指令：把宠物中心挪到归一化坐标。
     *  instant 一帧到位，spring 走过阻尼弹簧，line 在 duration 毫秒内直线走完。
     *  用户正按着宠物时整拍静默丢弃。
     */
    const applyPositionCue = (rx: number, ry: number, mode: PositionMode, duration: number) => {
      if (dragRef.current.active) return; // 用户交互优先。
      stopThrow(); // 先显式接管，停掉飞行与走路；stopMove 顺带停掉上一次的位置跟随。
      stopMove();
      // 中心换算成包围盒左上角 px，与提交 customPos 时的换算互逆。
      const px = rx * window.innerWidth - halfW;
      const py = ry * window.innerHeight - halfH;
      const rootEl = rootRef.current;
      if (!rootEl || mode === 'instant' || (mode === 'line' && duration <= 0)) {
        boxPxRef.current = { x: px, y: py };
        setCustomPos({ rx, ry });
        return;
      }
      const token = ++posFollowTokenRef.current;
      /** 写包围盒与四个 style，弹簧和直线两条路共用。 */
      const paint = (x: number, y: number) => {
        boxPxRef.current = { x, y };
        rootEl.style.left = x + 'px';
        rootEl.style.top = y + 'px';
        rootEl.style.right = 'auto';
        rootEl.style.bottom = 'auto';
      };
      if (mode === 'line') {
        // 直线补间在像素空间插值；按归一化比例插值会把斜线走歪。
        const from = boxPxRef.current ?? { x: px, y: py };
        const t0 = performance.now();
        const step = () => {
          if (posFollowTokenRef.current !== token) return;
          const p = Math.min((performance.now() - t0) / duration, 1);
          if (p >= 1) {
            // 精确落位，终点不留残余偏差。
            paint(px, py);
            posFollowRef.current = null;
            setCustomPos({ rx, ry });
            return;
          }
          paint(from.x + (px - from.x) * p, from.y + (py - from.y) * p);
          posFollowRef.current = requestAnimationFrame(step);
        };
        posFollowRef.current = requestAnimationFrame(step);
        return;
      }
      // spring：过阻尼弹簧跟随，没有行程时间，靠收敛判定自己收尾。
      let last = performance.now();
      const vel = { vx: 0, vy: 0 };
      const step = () => {
        if (posFollowTokenRef.current !== token) return;
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, 1 / 30);
        last = now;
        let x = boxPxRef.current?.x ?? px;
        let y = boxPxRef.current?.y ?? py;
        vel.vx = springStep(vel.vx, x, px, dt, cfg.physics.throwPower);
        vel.vy = springStep(vel.vy, y, py, dt, cfg.physics.throwPower);
        x += vel.vx * dt;
        y += vel.vy * dt;
        paint(x, y);
        // 收敛判定：足够近且足够慢时精确落位并提交。
        if (Math.abs(px - x) < 0.5 && Math.abs(py - y) < 0.5 && Math.abs(vel.vx) < 1 && Math.abs(vel.vy) < 1) {
          paint(px, py);
          posFollowRef.current = null;
          setCustomPos({ rx, ry });
          return;
        }
        posFollowRef.current = requestAnimationFrame(step);
      };
      posFollowRef.current = requestAnimationFrame(step);
    };

    /** 执行抛掷指令：角度（度，0 为正右，逆时针为正）与力度倍率换算成初速度，交给 startThrow。
     *  下游物理全部复用，不设死区。
     */
    const applyThrowCue = (angleDeg: number, power: number) => {
      if (dragRef.current.active) return; // 用户交互优先。
      const { vx, vy } = throwVelocity(angleDeg, power);
      const box = boxPxRef.current ?? { x: currentCenterX() - halfW, y: currentCenterY() - halfH };
      startThrow(box.x, box.y, vx, vy);
    };
    /** 被撞回调：停当前动作，从落点以新初速抛出去。 */
    const onPetHit = (vx: number, vy: number) => {
      stopMove();
      stopDragFollow();
      stopThrow();
      const bx = boxPxRef.current;
      let sx = 0;
      let sy = 0;
      if (bx) {
        sx = bx.x;
        sy = bx.y;
      } else {
        const r = rootRef.current?.getBoundingClientRect();
        if (r) {
          sx = r.left;
          sy = r.top;
        }
      }
      startThrowLatestRef.current(sx, sy, vx, vy);
    };
    // 碰撞站场注册：getVel 取最新抛掷状态，onHit 经 ref 转发，避免陈旧闭包。
    useEffect(() => {
      const arenaSlots = arena.current.slots;
      arenaSlots[cfg.id] = {
        size,
        bottomPad,
        getBox: () => {
          if (boxPxRef.current) return boxPxRef.current;
          const r = rootRef.current?.getBoundingClientRect();
          return r ? { x: r.left, y: r.top } : null;
        },
        getVel: () =>
          throwRef.current !== null && throwStateRef.current
            ? { vx: throwStateRef.current.vx, vy: throwStateRef.current.vy }
            : { vx: 0, vy: 0 },
        onHit: onPetHit,
      };
      return () => {
        delete arenaSlots[cfg.id];
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖由碰撞注册身份 cfg.id/size/bottomPad/arena 决定：onPetHit 只经 startThrowLatestRef 转发、不捕获渲染期状态；补 onPetHit（每渲染重建）会让碰撞槽每渲染注销重注册
    }, [cfg.id, size, bottomPad, arena]);
    /** Q 弹挤压：前台视频贴地压扁再回弹，曲线在 shared（squashScale）；reduce-motion 时跳过。 */
    const startSquash = (el: HTMLVideoElement, depth: number = SQ_SQUASH) => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const token = ++squashTokenRef.current;
      if (squashRef.current !== null) cancelAnimationFrame(squashRef.current);
      const origin = el.style.transformOrigin;
      el.style.transformOrigin = 'bottom';
      const t0 = performance.now();
      const step = () => {
        if (squashTokenRef.current !== token) return;
        const u = Math.min((performance.now() - t0) / SQ_DURATION_MS, 1);
        const scale = squashScale(u, depth);
        el.style.transform = (facingRef.current === 'right' ? 'scaleX(-1) ' : '') + 'scaleY(' + scale + ')';
        if (u < 1) {
          squashRef.current = requestAnimationFrame(step);
        } else {
          squashRef.current = null;
          el.style.transformOrigin = origin;
          // 恢复纯镜像；若期间 switchTo 重置过 transform，也以镜像为准。
          el.style.transform = facingRef.current === 'right' ? 'scaleX(-1)' : '';
        }
      };
      squashRef.current = requestAnimationFrame(step);
    };
    /** 停止 Q 弹挤压。 */
    const stopSquash = () => {
      squashTokenRef.current++;
      if (squashRef.current !== null) {
        cancelAnimationFrame(squashRef.current);
        squashRef.current = null;
      }
    };

    const facingRef = useRef<'left' | 'right'>(facing);
    facingRef.current = facing;

    // 悬浮提示：贴光标显示。
    /** 把提示框摆到光标右下，放不下时翻边并夹回视口。
     *  直接写 DOM style：每次鼠标移动都走 React 状态会让整个 PetCard 重渲染。
     */
    const placeTip = (clientX: number, clientY: number): void => {
      const tipEl = tipRef.current;
      if (!tipEl) return;
      const viewport = document.documentElement;
      const p = tooltipPlacement(
        { x: clientX, y: clientY },
        { w: tipEl.offsetWidth, h: tipEl.offsetHeight },
        { x: 0, y: 0, w: viewport.clientWidth, h: viewport.clientHeight },
        size * TOOLTIP_GAP_RATIO,
      );
      tipEl.style.left = p.x + 'px';
      tipEl.style.top = p.y + 'px';
    };

    // 占用锁：宿主靠内存持有，渲染端靠 /state 的 pets.<id>.lock 叶子感知。
    // 宿主不会推「锁没了」，这里按叶子里的 expiresAt 自行解除。
    // 冻结只挡自播行为：随机链、当前自播动画、自动来源的余额与工作状态、屏上的任务气泡。
    // 显式指令（say / anim / position / throw）一概不挡，那正是持锁者要保护的内容。
    /** 应用冻结状态；只在真正翻转时动作，挂载时不补播 idle。 */
    const applyFreeze = (next: boolean): void => {
      if (frozenRef.current === next) return;
      frozenRef.current = next;
      const el = frontRef.current === 0 ? videoARef.current : videoBRef.current;
      const stamp = '[dsh-pet] ' + new Date().toTimeString().slice(0, 8) + ' pet=' + cfg.id;
      if (next) {
        // 光堵随机链不够：它只在动画播完时调用，不暂停会把当前这段播完才停。
        stopMove();
        el?.pause();
        // 冻结打断了正在播的第三方点播，如实回 cancelled；解冻不会把它接回来，所以不是暂停。
        // 先清 playingPlaybackRef 再上报，避免后续换源重复上报。
        const interrupted = playingPlaybackRef.current;
        if (interrupted !== null) {
          playingPlaybackRef.current = null;
          reportPlayback(interrupted, 'cancelled', 'frozen');
        }
        // 任务状态气泡：锁一生效就收掉，解冻不补亮。
        if (workBubbleTimerRef.current !== null) window.clearTimeout(workBubbleTimerRef.current);
        workBubbleTimerRef.current = null;
        setWorkBubbleOn(false);
        console.log(stamp + ' 占用锁生效：冻结（随机链停 + 当前动画暂停 + 任务状态气泡收起）');
        return;
      }
      console.log(stamp + ' 占用锁解除：恢复');
      // 解冻：非终态工作状态回档位循环，否则回 idle 一次，播完由 handleEnded 接回随机链。
      if (resumeWorkStatusAnim()) return;
      if (petAnims.idle.length) {
        setAnim(pick(petAnims.idle, animRef.current));
        setOnce(true);
        setSeq((s) => s + 1);
      }
    };

    useEffect(() => {
      if (lockTimerRef.current !== null) {
        window.clearTimeout(lockTimerRef.current);
        lockTimerRef.current = null;
      }
      // expiresAt 已过去就是没有锁；刷新后拿到陈旧叶子时必须这么判，不能只看 locked。
      const expiresAt = lock?.locked === true ? lock.expiresAt : 0;
      applyFreeze(expiresAt > Date.now());
      if (expiresAt <= Date.now()) return;
      lockTimerRef.current = window.setTimeout(
        () => {
          lockTimerRef.current = null;
          applyFreeze(false);
        },
        Math.max(0, expiresAt - Date.now()),
      );
      return () => {
        if (lockTimerRef.current !== null) {
          window.clearTimeout(lockTimerRef.current);
          lockTimerRef.current = null;
        }
      };
      // applyFreeze 每次渲染都是新函数，但只读 ref 与稳定 setter，刻意不进依赖。
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖由 lockTick/lock 决定：applyFreeze 每渲染重建但只读 ref 与稳定 setter；补 applyFreeze 会让每次渲染都清掉并重设解冻定时器
    }, [lockTick, lock]);

    // 点击与拖拽。
    /** 按下：处理积分、拖拽与弹弓，并开启指针捕获。 */
    const handlePointerDown = (e: ReactNS.PointerEvent<HTMLDivElement>) => {
      // 只认左键：右键会与菜单判定打架，两端一致。
      if (e.button !== 0) return;
      // 用户点了或拖了这只宠物就是接管：立即本地解冻并 force 释放宿主锁。
      // 先本地解冻是为了不等一次往返；此刻确实有锁，乐观释放是安全的。
      if (frozenRef.current) {
        if (lockTimerRef.current !== null) {
          window.clearTimeout(lockTimerRef.current);
          lockTimerRef.current = null;
        }
        applyFreeze(false);
        void postAction('/dsh-pet-7340/lock/release?pet=' + encodeURIComponent(cfg.id), { force: true });
      }
      // 抓取速度日志：在 stopThrow 之前读，静止时记录 0。
      const grabState = throwStateRef.current;
      console.log(
        '[dsh-pet] ' +
          new Date().toTimeString().slice(0, 8) +
          ' pet=' +
          cfg.id +
          ' grab vx=' +
          (grabState ? Math.round(grabState.vx) : 0) +
          ' vy=' +
          (grabState ? Math.round(grabState.vy) : 0) +
          ' |v|=' +
          (grabState ? Math.round(Math.hypot(grabState.vx, grabState.vy)) : 0),
      );
      // 点击积分在按下瞬间触发（不等松开）；标记本次已触发，松开的 click 不再重复弹。
      pressScoreFiredRef.current = false;
      if (grabState) {
        const grabSpeed = Math.hypot(grabState.vx, grabState.vy);
        if (grabSpeed >= SCORE_MIN_SPEED) {
          const sc = clickScore(grabSpeed, size);
          pressScoreFiredRef.current = true;
          console.log(
            '[dsh-pet] ' +
              new Date().toTimeString().slice(0, 8) +
              ' pet=' +
              cfg.id +
              ' click-score speed=' +
              Math.round(grabSpeed) +
              ' size=' +
              size +
              ' -> +' +
              sc,
          );
          spawnScoreBurst(e.clientX, e.clientY);
          mountScorePopup({ x: e.clientX, y: e.clientY, score: sc, speed: grabSpeed, size });
        }
      }
      // 空中抓取：停掉抛掷、漫游与弹簧跟随，从当前落点开始拖拽。
      stopThrow();
      stopDragFollow();
      stopMove();
      dragTrailRef.current = [];
      e.currentTarget.classList.add('dragging');
      e.currentTarget.setPointerCapture(e.pointerId);
      // 指针捕获期间 pointerleave 不触发，不主动收起提示就会一直跟着跑。
      setTipOn(false);
      const rootEl = rootRef.current;
      let offX = 0;
      let offY = 0;
      if (rootEl) {
        const rr = rootEl.getBoundingClientRect();
        offX = e.clientX - (rr.left + rr.width / 2);
        offY = e.clientY - (rr.top + rr.height / 2);
        boxPxRef.current = { x: rr.left, y: rr.top };
      }
      // 弹弓只比较两次按下的间隔，与本次拖了多久、何时松手无关。
      const pressNow = performance.now();
      const sling = pressNow - lastPressAtRef.current < SLINGSHOT_DOUBLE_MS;
      lastPressAtRef.current = sling ? 0 : pressNow; // 命中后清零，免得连点三下弹两次。
      const anchor = boxPxRef.current;
      dragRef.current = {
        active: true,
        dragging: false,
        sx: e.clientX,
        sy: e.clientY,
        offX,
        offY,
        lpTimer: null,
        sling,
        anchorX: anchor ? anchor.x + halfW : e.clientX,
        anchorY: anchor ? anchor.y + halfH : e.clientY,
      };
      // 触屏长按 500ms 打开菜单；手指移动超过 8px 取消，鼠标与笔不走这条分支。
      if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') {
        const lpEl = e.currentTarget;
        const lpId = e.pointerId;
        const lpX = e.clientX;
        const lpY = e.clientY;
        dragRef.current.lpTimer = setTimeout(() => {
          dragRef.current.lpTimer = null;
          const dl = dragRef.current;
          if (!dl.active || dl.dragging) return;
          // 结束本次按压：松手时既不抛掷也不播点击动画。
          dl.active = false;
          pressScoreFiredRef.current = true;
          if (lpEl.hasPointerCapture(lpId)) lpEl.releasePointerCapture(lpId);
          console.log('[dsh-pet] ' + new Date().toTimeString().slice(0, 8) + ' pet=' + cfg.id + ' -> [TOUCH-MENU]');
          // 与鼠标右键同一入口：派发 contextmenu 交给 handleContextMenu。
          lpEl.dispatchEvent(
            new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: lpX,
              clientY: lpY,
              button: 2,
            }),
          );
        }, 500);
      }
    };
    /** 移动：更新悬浮提示、拖拽阈值与弹簧目标。 */
    const handlePointerMove = (e: ReactNS.PointerEvent<HTMLDivElement>) => {
      // 提示跟随光标，必须在拖拽早退之前。
      if (tipOn) placeTip(e.clientX, e.clientY);
      const d = dragRef.current;
      if (!d.active) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      // 长按窗口内手指移动超过 8px 即取消。
      if (d.lpTimer && Math.hypot(dx, dy) > 8) {
        clearTimeout(d.lpTimer);
        d.lpTimer = null;
      }
      if (!d.dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        d.dragging = true;
        setDragging(true);
        setOnce(true);
        if (petAnims.drag.length) {
          const name = pick(petAnims.drag);
          console.log('[dsh-pet] ' + new Date().toTimeString().slice(0, 8) + ' pet=' + cfg.id + ' -> [DRAG] ' + name);
          setAnim(name);
        }
      }
      // 记录指针轨迹，供初速估算。
      const now = performance.now();
      dragTrailRef.current = trimTrail([...dragTrailRef.current, { t: now, x: e.clientX, y: e.clientY }], now);
      // 弹簧目标是包围盒左上角，跟随循环逐帧追赶。
      dragTargetRef.current = { x: e.clientX - d.offX - halfW, y: e.clientY - d.offY - halfH };
      const rootEl = rootRef.current;
      if (rootEl) startDragFollow(rootEl);
      const stageEl = stageRef.current;
      if (stageEl) stageEl.style.transform = 'none';
    };
    /** 松开：结算拖拽或抛掷，并复位悬浮提示。 */
    const handlePointerUp = (e: ReactNS.PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      // pointercancel 也走这个处理器，长按定时器在这里一并清掉。
      if (d.lpTimer) {
        clearTimeout(d.lpTimer);
        d.lpTimer = null;
      }
      const wasDragging = d.dragging;
      d.active = false;
      d.dragging = false;
      e.currentTarget.classList.remove('dragging');
      stopDragFollow();
      if (wasDragging) {
        justDraggedRef.current = true;
        setTimeout(() => {
          justDraggedRef.current = false;
        }, 100);
        setDragging(false);
        const stageEl = stageRef.current;
        if (stageEl) stageEl.style.transform = 'translateY(' + bottomPad + 'px)';
        // 拖拽松手：非终态恢复工作循环，否则播一遍待机后回随机链。
        // once 必须为 true，否则 ended 不触发，随机链回不来。
        if (!resumeWorkStatusAnim()) {
          if (petAnims.idle.length) setAnim(pick(petAnims.idle, animRef.current));
          setOnce(true);
        }
        // 释放位置取弹簧跟随的实时包围盒，而不是指针目标。
        const bx = boxPxRef.current;
        const px = bx ? bx.x : e.clientX - d.offX - halfW;
        const py = bx ? bx.y : e.clientY - d.offY - halfH;
        if (d.sling) {
          // 弹弓：力度取拉距（与手速无关），方向与拉向相反；拉向量用宠物实际中心算。
          // 之后与甩抛走同一条 startThrow。
          const pullX = px + halfW - d.anchorX;
          const pullY = py + halfH - d.anchorY;
          const dist = Math.hypot(pullX, pullY);
          const power = slingshotPower(dist, size);
          const v = slingshotVelocity(pullAngle(pullX, pullY), power, cfg.physics.throwPower);
          dragTrailRef.current = [];
          console.log(
            '[dsh-pet] ' +
              new Date().toTimeString().slice(0, 8) +
              ' pet=' +
              cfg.id +
              ' sling dist=' +
              Math.round(dist) +
              ' power=' +
              power.toFixed(2) +
              ' vx=' +
              Math.round(v.vx) +
              ' vy=' +
              Math.round(v.vy),
          );
          startThrow(px, py, v.vx, v.vy);
        } else {
          // 初速估算：够快就抛掷，否则原地放下。
          const vel = estimateReleaseVelocity(dragTrailRef.current, performance.now(), cfg.physics);
          dragTrailRef.current = [];
          if (vel) {
            console.log(
              '[dsh-pet] ' +
                new Date().toTimeString().slice(0, 8) +
                ' pet=' +
                cfg.id +
                ' release vx=' +
                Math.round(vel.vx) +
                ' vy=' +
                Math.round(vel.vy) +
                ' |v|=' +
                Math.round(Math.hypot(vel.vx, vel.vy)),
            );
            // 飞行期间由 rAF 直接写 left/top，落定后才提交 customPos。
            startThrow(px, py, vel.vx, vel.vy);
          } else {
            // 原地放下：提交 customPos，由 React 按 rootStyle 重排位置。
            setCustomPos({ rx: (px + halfW) / window.innerWidth, ry: (py + halfH) / window.innerHeight });
          }
        }
      }
      // 提示复位：指针捕获期间 pointerleave 不触发，不主动恢复就得移出再移回。
      // 先按松手位置摆好再显示。
      const hitRect = e.currentTarget.getBoundingClientRect();
      if (
        e.clientX >= hitRect.left &&
        e.clientX <= hitRect.right &&
        e.clientY >= hitRect.top &&
        e.clientY <= hitRect.bottom
      ) {
        placeTip(e.clientX, e.clientY);
        setTipOn(true);
      }
    };
    /** 点击：播放点击动画并触发 Q 弹。 */
    const handleClick = () => {
      const d = dragRef.current;
      if (d.active || d.dragging || justDraggedRef.current) return;
      // 本次按下已触发过积分：只收手停住，不再播普通点击动画。
      if (pressScoreFiredRef.current) {
        pressScoreFiredRef.current = false;
        stopThrow();
        stopMove();
        return;
      }
      stopThrow(); // 点击飞行中的宠物即收手停住。
      stopMove();
      // 点击音效放在所有「不播点击动画」的早退分支之后。
      if (clickSoundEnabled) playClickSound();
      setOnce(true);
      if (!petAnims.clicks.length) return;
      const name = pick(petAnims.clicks);
      console.log('[dsh-pet] ' + new Date().toTimeString().slice(0, 8) + ' pet=' + cfg.id + ' -> [CLICK] ' + name);
      pendingSquashRef.current = true; // 等新点击动画切到前台后再压新首帧。
      // 单动画点击时状态不变，useEffect 不会重放；递增 seq 强制 switchTo 走一遍，
      // 防重分支负责消费 Q 弹标记。
      setSeq((s) => s + 1);
      setAnim(name);
    };

    // 右键菜单：独立浮层，只在命中区拦截右键，不改动 DSH 页面自己的菜单。
    /** keepFacing 为真时跳过「文字类动画强制朝左」的镜像修正，显式朝向优先。 */
    const handleMenuAction = (leaf: MenuLeaf, playbackId?: string, keepFacing = false) => {
      if (leaf.action === 'third-party') {
        // 第三方菜单项只上报 owner、label 与当前宠物 id，具体动作由注册方查询。
        const owner = leaf.owner ?? '';
        if (owner !== '') {
          postAction('/dsh-pet-7340/menu/click', { owner, label: leaf.label, pet: cfg.id }).catch((e: unknown) =>
            console.warn('[dsh-pet] 第三方菜单点击上报失败', e),
          );
        }
        return;
      }
      if (leaf.action === 'show-balance') {
        // 查看余额：动作端点让 host 刷新并写入 /state，页面什么都不用做。
        console.info('[dsh-pet] 菜单查看余额 pet=' + cfg.id);
        postAction('/dsh-pet-7340/balance')
          .then((ok: boolean) => {
            if (!ok) console.warn('[dsh-pet] 余额刷新动作未成功 pet=' + cfg.id);
          })
          .catch((e: unknown) => console.warn('[dsh-pet] 余额刷新异常', e));
        return;
      }
      if (leaf.action === 'whisper') {
        // 手动碎碎念：动作端点不回文本，文本随版本变化由长轮询送达，不受 whisperEnabled 限制。
        console.info('[dsh-pet] 菜单触发碎碎念 pet=' + cfg.id);
        // surface 必填：本页面就是网页端。
        postAction('/dsh-pet-7340/whisper?pet=' + encodeURIComponent(cfg.id) + '&surface=web')
          .then((ok: boolean) => {
            if (!ok) console.warn('[dsh-pet] 碎碎念手动触发失败 pet=' + cfg.id);
          })
          .catch((e: unknown) => console.warn('[dsh-pet] 碎碎念手动触发异常', e));
        return;
      }
      if (leaf.action === 'chat') {
        // 对话：shared 组件，记忆经 host /chat 读写，浏览器与桌面共用。
        // 弹窗贴在身体命中区右上角，视频框右上角不等于宠物右上角；超出视口夹回。
        if (chatRef.current) chatRef.current.close();
        const hitRect = stageRef.current?.querySelector('.dsh-pet-hit')?.getBoundingClientRect();
        chatRef.current = mountChatDialog({
          petId: cfg.id,
          baseUrl: '/dsh-pet-7340/chat',
          surface: 'web',
          x: hitRect ? hitRect.right + 6 : window.innerWidth - 256,
          y: hitRect ? hitRect.top + 6 : 8,
          onSent: () => {
            // 发送成功：回复已写进 /state，长轮询会立刻返回并弹气泡。
            console.info('[dsh-pet] 对话已发送 pet=' + cfg.id);
          },
          onClose: () => {
            chatRef.current = null;
          },
        });
        return;
      }
      if (leaf.action === 'set-display') {
        // 显示位置：写配置后重新拉取成品配置；改成不含 web 的值后宠物会从页面消失。
        const display = leaf.display;
        if (!display) return;
        console.info('[dsh-pet] 菜单切换显示位置 pet=' + cfg.id + ' display=' + display);
        void fetch('/dsh-pet-7340/pet-display', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: cfg.id, display }),
        })
          .then(async (r) => {
            if (!r.ok) throw new Error('pet-display HTTP ' + r.status);
            const body = (await r.json()) as Record<string, unknown>;
            // 业务失败是 HTTP 200 + {ok:false, reason}，只看状态码会把失败体当成成品聚合。
            if (body.ok === false) throw new Error('pet-display 被拒：' + String(body.reason ?? ''));
            // 响应体就是改动后的成品聚合，必须交给 reload；否则会再拉一次 GET /config，可能拿到旧值。
            petBridge.reload(body as Record<string, Record<string, unknown>>);
          })
          .catch((e: unknown) => console.warn('[dsh-pet] 显示位置切换失败', e));
        return;
      }
      if (leaf.action === 'home') {
        // 回到初始位置：停漫游与抛掷，清掉会话位置，回配置角落。
        stopThrow();
        stopMove();
        setCustomPos(null);
        return;
      }
      if (!leaf.anim) return;
      // 点播编号随这次换源一起下发；自播动画传 null，顺带清掉上一次的编号。
      const cuePlaybackId = playbackId ?? null;
      // 文字类朝右站姿是镜像的，点播前强制朝左；keepFacing 时跳过，显式朝向优先。
      if (!keepFacing && isNoMirrorAnimation(petAnims.categories, leaf.anim) && facingRef.current === 'right') {
        setFacing('left');
      }
      // 点播移动动画：走真实位移，仅「选哪个动画」由菜单决定；边界内挪不动时退化为纯播放。
      if (petAnims.moves.actions.some((a) => a.name === leaf.anim)) {
        if (tryMove(leaf.anim) === false) {
          stopMove();
          setOnce(true);
          setAnim(leaf.anim);
          setCuePlayback(cuePlaybackId);
        } else if (cuePlaybackId !== null) {
          // 移动系统接管，不换视频源，本段点播不会真的播起来，如实回 failed/busy。
          reportPlayback(cuePlaybackId, 'failed', 'busy');
        }
        return;
      }
      stopMove();
      setOnce(true);
      setAnim(leaf.anim);
      setCuePlayback(cuePlaybackId);
    };
    /** 打开右键菜单。 */
    const handleContextMenu = (e: ReactNS.MouseEvent<HTMLDivElement>) => {
      // 工具项与动作树；「查看余额」无条件显示，手动请求不受开关限制。
      // 第三方菜单项收在「更多」下，0 项不出现，单 owner 单条时平铺（见 buildMoreBranch）。
      const more = buildMoreBranch(menuItemsRef.current);
      const tools: MenuNode[] = [
        { label: '查看余额', action: 'show-balance' },
        { label: '碎碎念', action: 'whisper' },
        { label: '对话', action: 'chat' },
        { label: '回到初始位置', action: 'home' },
        // 显示位置子菜单与桌面端同一份；改成不含 web 的值后本宠物会从页面消失。
        displayMenuBranch(),
      ];
      const tree: MenuNode[] = [...tools, ...buildMenuTree(petAnims), ...(more ? [more] : [])];
      if (!tree.length) return;
      e.preventDefault();
      e.stopPropagation(); // 不触碰 DSH 页面的菜单与右键处理。
      const d = dragRef.current;
      if (d.active || d.dragging || justDraggedRef.current) return;
      stopThrow(); // 菜单弹出前停住飞行中的宠物。
      stopMove(); // 菜单悬停期间宠物不漫游。
      if (menuRef.current) menuRef.current.close();
      menuRef.current = mountContextMenu({
        tree,
        x: e.clientX,
        y: e.clientY,
        onAction: handleMenuAction,
        // 菜单被点外或 Esc 关闭时置空句柄，避免残留引用。
        onClose: () => {
          if (menuRef.current) menuRef.current = null;
        },
      });
    };

    // 渲染。
    // 左右透明边余量：夹取按身体贴边，宠物能走到屏幕边缘而身体不越界。
    const sideAllow = (HIT_BOX.x0 / 640) * size;
    const stageStyle = dragging ? { transform: 'none' } : { transform: 'translateY(' + bottomPad + 'px)' };
    const rootStyle = customPos
      ? (() => {
          const rx = customPos.rx;
          const ry = customPos.ry;
          // 拖拽位置即松手位置，不做边界夹取；漫游与抛掷的目标自身已界内。
          return {
            left: rx * window.innerWidth - halfW + 'px',
            top: ry * window.innerHeight - halfH + 'px',
            right: 'auto',
            bottom: 'auto',
          };
        })()
      : {};
    // 气泡单槽：三种气泡共用同一套定位，同时渲染会叠在一起，按优先级只挂一个。
    // 终态任务优先于碎碎念与对话，其次是余额，最后是非终态任务。
    // 终态任务只活 10s，所以不让位；非终态常驻，让位 10s 没有损失。
    /** 余额气泡页数：custom 取视图数，windows 两页，其余一页。 */
    const balancePageCount = (() => {
      if (!balance || !balance.ok) return 1;
      if (balance.shape === 'custom') return Math.max(1, customViews(balance)?.length ?? 1);
      return balance.shape === 'windows' ? 2 : 1;
    })();
    /** 点余额气泡切到下一页并重置 10s 计时，否则第 8 秒点开就只剩 2 秒。 */
    const toggleBalanceDetail = () => {
      setBalanceViewIndex((i) => (i + 1) % balancePageCount);
      if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
      bubbleTimerRef.current = window.setTimeout(() => setBubbleOn(false), BUBBLE_DURATION_MS);
    };
    const workTerminal = workStatus?.state === 'success' || workStatus?.state === 'error';
    const bubbleNode = (() => {
      if (workTerminal && workBubbleOn && workText && cfg.workStatusEnabled) {
        return h(WhisperBubble, { text: workText, on: workBubbleOn });
      }
      if (whisperBubbleOn && whisperText) {
        // assetRoot 只在按名称取图时使用，决定去哪个表情包目录链取。
        return h(WhisperBubble, {
          text: whisperText,
          image: whisperImage,
          url: whisperUrl,
          assetRoot: cfg.assetRoot,
          on: whisperBubbleOn,
        });
      }
      if (bubbleOn && balance && (cfg.balanceEnabled || balanceManual)) {
        return h(BalanceBubble, {
          state: balance,
          on: bubbleOn,
          index: balanceViewIndex,
          onCycle: toggleBalanceDetail,
        });
      }
      if (workBubbleOn && workText && cfg.workStatusEnabled) {
        return h(WhisperBubble, { text: workText, on: workBubbleOn });
      }
      return null;
    })();
    const commonVideoProps = { muted: true, playsInline: true, autoPlay: true };
    const hitProps = {
      className: 'dsh-pet-hit',
      style: {
        left: (HIT_BOX.x0 / 640) * 100 + '%',
        top: (HIT_BOX.y0 / 360) * 100 + '%',
        width: ((HIT_BOX.x1 - HIT_BOX.x0) / 640) * 100 + '%',
        height: ((HIT_BOX.y1 - HIT_BOX.y0) / 360) * 100 + '%',
      },
      onClick: handleClick,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerUp,
      onPointerEnter: (e: ReactNS.PointerEvent<HTMLDivElement>) => {
        placeTip(e.clientX, e.clientY); // 先摆位再显示，否则会先在兜底坐标闪一帧。
        setTipOn(true);
      },
      onPointerLeave: () => setTipOn(false),
      onContextMenu: handleContextMenu,
      // 原生 title 换成自绘浮层后，无障碍名称仍要保留。
      'aria-label': cfg.name,
    };
    return h('div', {
      ref: rootRef,
      className: 'dsh-pet-root',
      'data-corner': corner,
      'data-facing': facing,
      style: Object.assign(
        {
          '--dsh-pet-size': size + 'px',
          '--dsh-pet-mx': margin.x + 'px',
          '--dsh-pet-my': margin.y + 'px',
          // 字号注入最终 px；CSS 侧带原值回退，漏注入也不会坏。
          '--dsh-pet-font-bubble': fontPx.bubble + 'px',
          '--dsh-pet-font-tip': fontPx.tip + 'px',
        },
        rootStyle,
      ),
      children: [
        // 气泡单槽；余额不可用说明也走这里，手动请求与命令气泡不受 whisperEnabled 限制。
        bubbleNode,
        h('div', {
          ref: stageRef,
          className: 'dsh-pet-stage',
          style: stageStyle,
          children: [
            h('video', Object.assign({}, commonVideoProps, { ref: videoARef, className: 'dsh-pet-video is-front' })),
            h('video', Object.assign({}, commonVideoProps, { ref: videoBRef, className: 'dsh-pet-video' })),
            h('div', hitProps),
          ],
        }),
        // 悬浮提示常驻只切 class，挂卸节点吃不到淡入过渡；坐标由 placeTip 直接写 style。
        // pointer-events:none 见 TOOLTIP_CSS，否则会挡住命中区导致 enter/leave 闪烁。
        h('div', {
          ref: tipRef,
          className: TOOLTIP_CLASS + (tipOn ? ' is-on' : ''),
          'aria-hidden': 'true',
          children: cfg.name,
        }),
      ],
    });
  }

  /** 多开容器：一次拉取成品配置，拍平后渲染多个 PetCard。 */
  function PetMulti() {
    const [pets, setPets] = useState<Pet[]>([]);
    const [ready, setReady] = useState(false);
    // 碰撞站场：每只 PetCard 注册槽位，纯 ref 同步，不触发重渲染。
    const arenaRef = useRef<{ slots: Record<string, PetCollisionSlot> }>({ slots: {} });
    // 余额状态：容器统一拉取，PetCard 共享；两个 tick 分别驱动动画与文字说明。
    const [balance, setBalance] = useState<BalanceState | null>(null);
    const [balanceTick, setBalanceTick] = useState(0);
    const [balanceNoticeTick, setBalanceNoticeTick] = useState(0);
    // 本次余额是否由用户手动请求；手动请求无条件弹，开关只关自动。
    const [balanceManual, setBalanceManual] = useState(false);
    // 上次已提示的不可用原因，自动轮询只在原因变化时再弹。
    const noticeKeyRef = useRef<string | null>(null);
    // 余额结果统一入口；存 ref 是为了让 /state effect 的依赖保持 [ready]。
    // explicit 表示本次是否手动触发。
    const applyBalanceRef = useRef<(state: BalanceState, explicit: boolean) => void>(() => {});
    applyBalanceRef.current = (state, explicit) => {
      setBalance(state);
      setBalanceManual(explicit); // 手动标记随本次数据一起下发，每次到达都覆盖。
      if (state.ok) {
        setBalanceTick((t) => t + 1); // 成功：播档位动画并弹余额气泡。
        return;
      }
      const { show, key } = decideBalanceNotice(state, noticeKeyRef.current, explicit);
      noticeKeyRef.current = key;
      if (show) setBalanceNoticeTick((t) => t + 1); // 弹文字说明气泡（不播动画）
      // 未登记服务商是配置事实，已由气泡说明；其余原因照旧显式报错。
      if (state.reason !== 'unsupported') {
        console.error('[dsh-pet] 余额查询失败 reason=' + state.reason + (state.message ? ' ' + state.message : ''));
      }
    };
    // 工作状态：容器统一轮询 sections.workStatus，快照与 tick 驱动各宠物播档位动画。
    const [workStatus, setWorkStatus] = useState<WorkStatusSnapshot | null>(null);
    const [workStatusTick, setWorkStatusTick] = useState(0);
    // 说话：容器把 pets.<id>.say 按宠物分发给对应 PetCard。

    // 字体族写到 documentElement：对话窗与得分弹窗挂在 body 下，继承不到宠物根容器。
    // 多只宠物共用同一份配置，列表为空时不动。
    useEffect(() => {
      const family = pets[0]?.font?.family;
      if (family === undefined) return;
      document.documentElement.style.setProperty('--dsh-pet-font-family', fontStackOf(family));
    }, [pets]);

    useEffect(() => {
      let alive = true;
      /** 唯一填充点：成品聚合 → 渲染列表；条目级字段只由 flattenConfigPets 吹入。 */
      const applyMerged = (merged: Record<string, Record<string, unknown>>): void => {
        const main = (merged as { main?: Record<string, unknown> } | null)?.main;
        // 形状校验：响应异常时显式抛错，绝不用空列表清空已有宠物。
        if (typeof main !== 'object' || main === null) {
          throw new Error('配置响应不是成品聚合（host 版本不匹配？）');
        }
        // 点击音效开关只读 main 条目，非 true 一律静音。
        clickSoundEnabled = main.clickSoundEnabled === true;
        const flattened = flattenConfigPets(merged);
        petBridge.current = flattened;
        // 「添加宠物」模板取 main 条目的 pets[0]。
        petBridge.template = Array.isArray(main.pets) ? ((main.pets as Pet[])[0] ?? undefined) : undefined;
        setPets(flattened);
      };
      /** 拉取成品聚合：host readAllConfig 的输出，客户端零校验零兜底。 */
      const loadMerged = async (): Promise<Record<string, Record<string, unknown>>> => {
        // cache:'no-store' 与 fetchState 同口径，避免「版本变化后重拉」拿到旧值。
        const r = await fetch('/dsh-pet-7340/config', { cache: 'no-store' });
        if (!r.ok) throw new Error('config HTTP ' + r.status);
        return (await r.json()) as Record<string, Record<string, unknown>>;
      };
      (async () => {
        try {
          const merged = await loadMerged();
          if (!alive) return;
          applyMerged(merged);
          setReady(true);
        } catch (e) {
          console.error('[dsh-pet] 配置加载失败', e); // 成品拉取失败要显式报错，不静默隐藏。
        }
      })();
      // 设置页保存或同步后，用权威成品重新拍平；传入 merged 时直接用写接口的响应体。
      petBridge.reload = (merged) => {
        void (async () => {
          try {
            const next = merged ?? (await loadMerged());
            if (!alive) return;
            applyMerged(next);
          } catch (e) {
            console.error('[dsh-pet] 配置重载失败，保留当前渲染列表', e); // 显式报错，不清空已有宠物。
          }
        })();
      };
      return () => {
        alive = false;
        petBridge.reload = () => {};
      };
    }, []);

    // overlay 只渲染 display 为 web 或 both 的宠物。
    const visiblePets = pets.filter((p) => isWebVisible(p.display));

    // 统一轮询 /state：每个叶子 = { counter, data }，首拉只记基线，之后 counter 变化才分发。
    // 说话等命令与宠物开关无关，所以不为功能开关裁剪轮询。
    const [sayTick, setSayTick] = useState(0);
    const sayRef = useRef<Record<string, SayCue & { seq: number }>>({});
    const [animCueTick, setAnimCueTick] = useState(0);
    const animCueRef = useRef<
      Record<string, { name?: string; url?: string; seq: number; playbackId?: string; facing?: PetFacing }>
    >({});
    const [posCueTick, setPosCueTick] = useState(0);
    const posCueRef = useRef<
      Record<string, { x: number; y: number; mode: PositionMode; duration: number; seq: number }>
    >({});
    const [throwCueTick, setThrowCueTick] = useState(0);
    const throwCueRef = useRef<Record<string, { angle: number; power: number; seq: number }>>({});
    // 占用锁是状态而不是指令：PetCard 读它决定冻结，并按 expiresAt 自行解除。
    const [lockTick, setLockTick] = useState(0);
    const lockRef = useRef<Record<string, LockState>>({});
    // 第三方菜单项只在打开右键菜单时读一次，不参与渲染。
    const menuItemsRef = useRef<MenuMoreItem[]>([]);
    useEffect(() => {
      if (!ready) return;
      let alive = true;
      let baseline: Record<string, number> | null = null;
      // 长轮询版本号；undefined 表示首拉，不带参数立刻拿全量。
      let since: number | undefined;
      // 响应带 counter 表示支持长轮询；老宿主会立刻返回全量，必须退回固定间隔，否则就是忙等。
      let longPoll = true;
      /** 应用一份轮询状态：首拉只记基线，之后按 counter 变化逐个分发。 */
      const applyState = (s: PollState) => {
        if (baseline === null) {
          baseline = flattenCounters(s); // 首拉只记基线，不渲染。
          // 菜单项是当前状态而不是事件，首拉也必须装上，否则刷新后第三方菜单会一直为空。
          menuItemsRef.current = readMenuItems(s.sections.menu?.data, 'web');
          return;
        }
        for (const { path, leaf } of takeChanged(s, baseline)) {
          if (leaf.data === null) continue;
          if (path === 'sections.config') {
            // 配置被别处改过（唯一写方是 POST /pet-display），重新拉取并拍平。
            // 叶子 data 只是信号，配置本体太大，不能塞进 /state。
            petBridge.reload(); // 内部 GET /config，再 applyMerged 重算 visiblePets。
          } else if (path === 'sections.balance') {
            const hit = readBalance(leaf);
            if (hit) applyBalanceRef.current(hit.state, hit.manual);
          } else if (path === 'sections.workStatus') {
            const snap = readWorkStatus(leaf);
            if (snap) {
              setWorkStatus(snap);
              setWorkStatusTick((t) => t + 1); // 任何变化都触发，含回到空闲。
            }
          } else if (path === 'sections.notify') {
            // 系统通知：单槽，由 host 决定保留哪一条，内部有开关与权限门。
            notifyFromFrame(leaf.data);
          } else if (path === 'sections.menu') {
            // 第三方菜单快照只更新 ref，不触发渲染。
            menuItemsRef.current = readMenuItems(leaf.data, 'web');
          } else if (path.startsWith('pets.') && path.endsWith('.say')) {
            // 说话叶子：宠物 id 允许含点号，按前缀与后缀切片，绝不 split('.')。
            const petId = path.slice('pets.'.length, -'.say'.length);
            const said = readSay(leaf);
            if (said) {
              sayRef.current[petId] = { ...said, seq: (sayRef.current[petId]?.seq ?? 0) + 1 };
              setSayTick((t) => t + 1);
            }
          } else if (path.startsWith('pets.') && path.endsWith('.anim')) {
            // 点播叶子：路径形如 pets.<id>.anim；每次写入都会递增 counter，连点两次也会分发两次。
            const petId = path.slice('pets.'.length, -'.anim'.length);
            const hit = readAnim(leaf);
            if (hit) {
              animCueRef.current[petId] = {
                name: hit.name,
                url: hit.url,
                playbackId: hit.playbackId,
                facing: hit.facing,
                seq: (animCueRef.current[petId]?.seq ?? 0) + 1,
              };
              setAnimCueTick((t) => t + 1);
            }
          } else if (path.startsWith('pets.') && path.endsWith('.position')) {
            // 位置指令叶子，路径形如 pets.<id>.position。
            const petId = path.slice('pets.'.length, -'.position'.length);
            const hit = readPosition(leaf);
            if (hit) {
              posCueRef.current[petId] = { ...hit, seq: (posCueRef.current[petId]?.seq ?? 0) + 1 };
              setPosCueTick((t) => t + 1);
            }
          } else if (path.startsWith('pets.') && path.endsWith('.throw')) {
            // 抛掷指令叶子，路径形如 pets.<id>.throw。
            const petId = path.slice('pets.'.length, -'.throw'.length);
            const hit = readThrow(leaf);
            if (hit) {
              throwCueRef.current[petId] = { ...hit, seq: (throwCueRef.current[petId]?.seq ?? 0) + 1 };
              setThrowCueTick((t) => t + 1);
            }
          } else if (path.startsWith('pets.') && path.endsWith('.lock')) {
            // 占用锁叶子：它是状态而不是指令，PetCard 按 expiresAt 自行解除。
            const petId = path.slice('pets.'.length, -'.lock'.length);
            const hit = readLock(leaf);
            if (hit) {
              lockRef.current[petId] = hit;
              setLockTick((t) => t + 1);
            }
          }
        }
      };
      // 自调度循环：请求 → 处理 → 立刻再请求；宿主没变化时挂起，空闲约 1 请求/秒。
      // 动作端点都会写叶子，版本一变挂着的这一拍就返回。
      const loop = async () => {
        while (alive) {
          let s: PollState | null = null;
          try {
            s = await fetchState(
              undefined,
              longPoll && since !== undefined ? { since, timeoutMs: STATE_WAIT_MS } : undefined,
            );
          } catch {
            /* 轻量轮询失败静默，下一拍再试。 */
          }
          if (!alive) return;
          if (s) {
            longPoll = typeof s.counter === 'number';
            if (longPoll) since = s.counter;
            applyState(s);
          }
          // 长轮询命中或首拉时立刻再请求；失败或老宿主则退避一个间隔。
          if (!s || !longPoll) await new Promise((r) => setTimeout(r, STATE_FALLBACK_MS));
        }
      };
      void loop();
      return () => {
        alive = false;
      };
    }, [ready]);

    return ready
      ? visiblePets.map((p) =>
          h(PetCard, {
            key: p.id,
            cfg: p as RuntimePet,
            balance,
            balanceTick,
            balanceNoticeTick,
            balanceManual,
            workStatus,
            workStatusTick,
            say: sayRef.current[p.id],
            sayTick,
            animCue: animCueRef.current[p.id],
            animCueTick,
            posCue: posCueRef.current[p.id],
            posCueTick,
            throwCue: throwCueRef.current[p.id],
            throwCueTick,
            lock: lockRef.current[p.id],
            lockTick,
            menuItemsRef,
            arena: arenaRef,
          }),
        )
      : null;
  }

  return PetMulti;
}
