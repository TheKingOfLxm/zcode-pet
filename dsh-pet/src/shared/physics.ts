/**
 * 拖拽抛掷物理：弹簧跟手、甩抛初速估算、重力与反弹、Q 弹挤压，纯计算无 DOM / rAF。
 * 浏览器半侧 overlay 与桌面 Helper 共用同一份，手感必须严格一致。
 * 坐标为宠物包围盒左上角的像素；初速估算用指针绝对坐标，两端的常数偏移在处理速度时自然抵消。
 * 物理参数运行时取自成品配置，本文件的常量只是默认值来源（与内置 config 的 physics 段一致）。
 * @module dsh-pet/src/shared/physics
 */
import type { PhysicsParams, Rect } from './types';
import { HIT_BOX } from './constants';
import { indexAtPoint, nearestIndex, rectBottom, rectRight } from './displays';

/** 拖拽弹簧刚度：越大跟手越紧。 */
export const SPRING_K = 200;
/** 拖拽弹簧阻尼：ζ = c/(2√k) ≈ 1.06，过阻尼，不 overshoot。 */
export const SPRING_C = 30;

/** 拖拽轨迹保留窗口（ms）：只留最近这一段做初速估算。 */
export const TRAIL_KEEP_MS = 200;
/** 初速估算窗口（ms）。 */
export const RELEASE_WINDOW_MS = 150;
/** 松手前停顿超过它即温柔放下（不带残余速度），即使之前甩过。 */
export const RELEASE_STALE_MS = 150;
/** 窗口太短视为不可估算（ms）。 */
export const MIN_SPAN_MS = 20;
/** 分段速度的最小 dt（ms）：高回报率鼠标事件可低至 1ms，过小 dt 会把抖动放大成虚假峰值。 */
export const SEG_MIN_DT_MS = 8;
/** 低于此速度即不抛（原地放下），px/s。 */
export const DEAD_ZONE_SPEED = 500;
/** 甩出速度软上限（px/s）：cap×(1-e^(-s/cap))，任意力度仍单调可区分，渐近不超过 cap。 */
export const MAX_THROW_SPEED = 3600;
/** 初速大小 = 端点均值×(1-w) + 窗口峰值×w，弥补快甩时位移集中在窗口内一小段的低估。 */
export const PEAK_WEIGHT = 0.5;
/** 参考加速度（px/s²）：末段加速达到它即吃满增益。 */
export const ACCEL_REF = 8000;
/** 加速度增益上限：仍在加速的甩动最多放大 60%。 */
export const ACCEL_GAIN_MAX = 0.6;

// 抛掷物理默认值：与内置 config 的 physics 段一致，运行时以成品配置为准
/** 抛掷重力（px/s²）。 */
export const GRAVITY = 1400;
/** 碰边恢复系数：每次反弹保留约 78% 速度。 */
export const RESTITUTION = 0.78;
/** 地面水平摩擦（/s）。 */
export const GROUND_FRICTION = 2.5;

/** 抛掷物理的默认参数（与内置配置一致；仅作配置缺失时的兜底）。 */
export const DEFAULT_PHYSICS: PhysicsParams = {
  gravity: GRAVITY,
  restitution: RESTITUTION,
  groundFriction: GROUND_FRICTION,
  ceilingBounce: true,
  throwPower: 1,
  petCollision: false,
};

/** 总力度默认量（throwPower=1 即现状）。 */
export const DEFAULT_THROW_POWER = 1;
/** 落地时 |vy| 小于它直接停竖直。 */
export const REST_VY = 40;
/** 地面上 |vx| 小于它认为已静止。 */
export const REST_VX = 15;
/** 单步最大 dt（s）：防后台标签页卡顿恢复后的巨帧跳变。 */
export const MAX_STEP_DT = 0.05;

/** 下压幅度：高度压到 55%。 */
export const SQ_SQUASH = 0.55;
/** 挤压时长（ms）。 */
export const SQ_DURATION_MS = 220;
/** 落地冲击速度基准：低于此即轻落（按下限幅度）。 */
export const SQ_SOFT_SPEED = 300;
/** 落地冲击速度上限：达到或超过此即重砸（吃满最大下压）。 */
export const SQ_HARD_SPEED = 1500;
/** 落地最大下压幅度（与点击一致）；轻落下限 0.8——重力 1400px/s²、恢复 0.78 下典型落地速度
 *  400~1500px/s，映射太保守会让常规甩抛的落地 Q 弹不明显，故底部留底限。 */
export const SQ_MAX_SQUASH = 0.55;

/** 落地冲击速度 → 下压幅度（速度越大压得越狠），结果作为 startSquash 的 squash 参数。 */
export const landingSquash = (impactSpeed: number): number => {
  const t = Math.min(Math.max((Math.abs(impactSpeed) - SQ_SOFT_SPEED) / (SQ_HARD_SPEED - SQ_SOFT_SPEED), 0), 1);
  return Math.min(0.8, 1 - t * (1 - SQ_MAX_SQUASH));
};

/** Q 弹挤压曲线：u∈[0,1] 进度 → scaleY。
 *  下压段（0~0.45）ease-in 压缩，回弹段（0.45~1）easeOutBack 带回约 4% 过冲，两端共用同一曲线。 */
export const squashScale = (u: number, squash: number = SQ_SQUASH): number => {
  if (u < 0.45) {
    const p = u / 0.45;
    return 1 - (1 - squash) * p * p;
  }
  const p = (u - 0.45) / 0.55;
  // easeOutBack 的标准过冲系数
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const f = 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
  return Math.min(1.12, squash + (1 - squash) * Math.max(f, 0));
};

/** 一次轨迹采样（t = performance.now() 时间戳 ms；x/y = 指针绝对坐标 px）。 */
export interface DragSample {
  t: number;
  x: number;
  y: number;
}

/** 抛掷边界：包围盒左上角的允许活动范围（与浏览器 root 的 left/top、桌面窗口位置同一套身体贴边语义）。 */
export interface ThrowBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 抛体当前状态（包围盒左上角 px + 速度 px/s）。 */
export interface ThrowState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** 由 W/H/size 计算抛掷碰撞边界：身体（盒内缩 sideAllow）贴屏幕边缘才反弹。 */
export const throwBounds = (o: { W: number; H: number; size: number; sideAllow: number }): ThrowBounds => {
  const h = (o.size * 9) / 16;
  return { minX: -o.sideAllow, minY: 0, maxX: o.W - o.size + o.sideAllow, maxY: o.H - h };
};

/** 同 throwBounds，但基于任意一块工作区矩形（原点不必是 0）；area 取整个视口时两者逐位相同。 */
export const throwBoundsIn = (area: Rect, size: number, sideAllow: number): ThrowBounds => {
  const h = (size * 9) / 16;
  return {
    minX: area.x - sideAllow,
    minY: area.y,
    maxX: rectRight(area) - size + sideAllow,
    maxY: rectBottom(area) - h,
  };
};

/** 抛掷空间：每块屏一套 AABB，而不是整个桌面一个大 AABB。
 *  不规则多屏布局下外接矩形含空洞，用它当边界会让宠物飞进不可见区域（见 shared/displays.ts）。 */
export interface ThrowSpace {
  /** 逐屏的包围盒左上角允许范围（与 areas 同序） */
  bounds: ThrowBounds[];
  /** 逐屏工作区（反弹与归属判定；任务栏挖掉的条带不在此列） */
  areas: Rect[];
  /** 逐屏完整面板（含任务栏区，与 areas 同序）：越界侧有没有邻屏要用面板探测——任务栏位于屏缝时
   *  工作区之间会空出一条不属于任何 workArea 的带，按工作区探测会把接缝当墙。
   *  缺省 = areas（单屏时两者等价）。 */
  panels: Rect[];
  /** 宠物包围盒宽 */
  size: number;
  /** 身体相对包围盒左右各内缩的量 */
  sideAllow: number;
}

/** 由工作区列表构造抛掷空间（单块屏时等价于 throwBounds）。 */
export const throwSpace = (o: { areas: Rect[]; panels?: Rect[]; size: number; sideAllow: number }): ThrowSpace => ({
  bounds: o.areas.map((a) => throwBoundsIn(a, o.size, o.sideAllow)),
  areas: o.areas,
  panels: o.panels && o.panels.length === o.areas.length ? o.panels : o.areas, // 面板缺失或不同序：退化用工作区
  size: o.size,
  sideAllow: o.sideAllow,
});

/** 宠物当前该归属哪块屏：身体中心所在屏，落在空洞里时取最近的一块。 */
export const screenOfBox = (space: ThrowSpace, x: number, y: number): number => {
  const cx = x + space.size / 2;
  const cy = y + (space.size * 9) / 16 / 2;
  const hit = indexAtPoint(space.areas, cx, cy);
  return hit >= 0 ? hit : nearestIndex(space.areas, cx, cy);
};

/** 剔除保留窗口外的旧采样；采样按时间追加，所以只需从头裁。 */
export const trimTrail = (trail: DragSample[], now: number): DragSample[] => {
  const cutoff = now - TRAIL_KEEP_MS;
  let i = 0;
  while (i < trail.length && trail[i].t < cutoff) i++;
  return i === 0 ? trail : trail.slice(i);
};

/** 过阻尼弹簧单轴速度步进：调用方随后 x += v*dt。
 *  power = 总力度（K/C 同乘：系统形态不变，收敛速度快 p 倍，即更跟手或更松）。 */
export const springStep = (
  v: number,
  x: number,
  target: number,
  dt: number,
  power: number = DEFAULT_THROW_POWER,
): number => v + ((target - x) * SPRING_K - v * SPRING_C) * power * dt;

/** 软钳速：cap×(1-e^(-s/cap))，任意速度下单调可区分、渐近不超过 cap。
 *  抛掷指令与拖拽甩抛走同一条限速，手感一致。 */
export const softClampSpeed = (speed: number): number => {
  if (speed <= 0) return 0;
  return MAX_THROW_SPEED * (1 - Math.exp(-speed / MAX_THROW_SPEED));
};

/** 抛掷指令的力度锚点：power = 1.0 对应软钳速之前的 1200 px/s（实际初速被压到约 1021 px/s）。 */
export const THROW_SPEED_ANCHOR = 1200;

/** 抛掷指令（POST /throw 的 angle + power）→ 初速度 (vx, vy)，px/s。
 *  angle 单位度，0 = 正右、逆时针为正——屏幕 y 向下，所以 vy 取负（往上抛写 90，不是 270）。
 *  初速 = power × THROW_SPEED_ANCHOR 再过既有软上限，任意 power 都单调可区分且不超过 MAX_THROW_SPEED。
 *  两端共用本函数，保证接口抛掷的初速换算严格一致。 */
export const throwVelocity = (angleDeg: number, power: number): { vx: number; vy: number } => {
  const speed = softClampSpeed(power * THROW_SPEED_ANCHOR);
  const rad = (angleDeg * Math.PI) / 180;
  return { vx: Math.cos(rad) * speed, vy: -Math.sin(rad) * speed };
};

/** 弹弓（双击第二下按住拖）：力度 = 拉距，与手速无关。
 *  拉距只负责换成初速度，之后照旧走 throwStep / throwStepRegion，重力、反弹、摩擦、Q 弹都不变。
 *  方向 = 拉的反方向；力度不设上限——软钳速是为手速抖动设的，拉得远与拉得更远必须能区分开。
 *  刻度与 throwVelocity 同源：power = 1 对应 THROW_SPEED_ANCHOR，并乘同一个 physics.throwPower。
 *  「一倍力度」的参考拉距 = 宠物宽 × SLINGSHOT_REF_RATIO。 */
export const SLINGSHOT_REF_RATIO = 0.6;

/** 「一倍力度」的参考拉距（px），随宠物尺寸缩放——小宠物不必拖同样远才炸。 */
export const slingshotRefDist = (size: number): number => (size > 0 ? size * SLINGSHOT_REF_RATIO : 0);

/** 拉距 → 力度倍率（px / 参考拉距）：线性、单调、不夹取；0 拉距 = 0 力度。 */
export const slingshotPower = (dist: number, size: number): number => {
  const ref = slingshotRefDist(size);
  if (!(ref > 0) || !(dist > 0) || !Number.isFinite(dist)) return 0;
  return dist / ref;
};

/** 拉向量（起点 → 松手点，屏幕坐标，y 向下）→ 弹射角度（度）：弹的是拉的反方向，角度约定同 throwVelocity。 */
export const pullAngle = (pullX: number, pullY: number): number => (Math.atan2(pullY, -pullX) * 180) / Math.PI;

/** 弹弓初速：角度约定与力度锚点同 throwVelocity，但没有软上限（任意 power 都单调可区分）。 */
export const slingshotVelocity = (
  angleDeg: number,
  power: number,
  throwPower: number = DEFAULT_THROW_POWER,
): { vx: number; vy: number } => {
  const speed = THROW_SPEED_ANCHOR * Math.max(0, power) * Math.max(0, throwPower);
  // 0 力度直接给 0（而不是算出来 cos/sin 的 -0）：叶子里的速度要能当普通数字比较
  if (speed === 0) return { vx: 0, vy: 0 };
  const rad = (angleDeg * Math.PI) / 180;
  return { vx: Math.cos(rad) * speed, vy: -Math.sin(rad) * speed };
};

/** 由拖拽轨迹估算松手初速 (vx, vy)，px/s。
 *  方向取窗口首末端点的位移（抗抖）；大小 = 端点平均与窗口峰值按 PEAK_WEIGHT 加权，
 *  末段仍在加速时按 ACCEL_REF 给增益（最多 ACCEL_GAIN_MAX），再过软钳速。
 *  软钳速之后整体乘 physics.throwPower，让初速与死区判定一起线性缩放。
 *  返回 null = 温柔放下（轨迹为空 / 停留过久 / 窗口太短 / 峰值低于死区），调用方不抛。 */
export const estimateReleaseVelocity = (
  trail: DragSample[],
  now: number,
  physics: PhysicsParams = DEFAULT_PHYSICS,
): { vx: number; vy: number } | null => {
  if (trail.length === 0) return null;
  const last = trail[trail.length - 1];
  if (now - last.t > RELEASE_STALE_MS) return null;
  const win = trail.filter((s) => now - s.t <= RELEASE_WINDOW_MS);
  if (win.length < 2) return null;
  const t0 = win[0].t;
  const x0 = win[0].x;
  const y0 = win[0].y;
  const t1 = win[win.length - 1].t;
  const x1 = win[win.length - 1].x;
  const y1 = win[win.length - 1].y;
  const spanMs = t1 - t0;
  if (spanMs < MIN_SPAN_MS) return null;
  const baseVx = ((x1 - x0) / spanMs) * 1000;
  const baseVy = ((y1 - y0) / spanMs) * 1000;
  const baseSpeed = Math.hypot(baseVx, baseVy);
  if (baseSpeed < 1e-6) return null; // 窗口内几乎纯抖动：没有可靠方向，按原地放下处理
  // 分段速度（过密采样向前合并，dt 下限 SEG_MIN_DT_MS）
  const segSpeeds: { speed: number; tEnd: number }[] = [];
  let px = x0;
  let py = y0;
  let pt = t0;
  for (const s of win.slice(1)) {
    const dt = s.t - pt;
    if (dt >= SEG_MIN_DT_MS) {
      segSpeeds.push({ speed: (Math.hypot(s.x - px, s.y - py) / dt) * 1000, tEnd: s.t });
      px = s.x;
      py = s.y;
      pt = s.t;
    }
  }
  const peakSpeed = segSpeeds.length ? Math.max(...segSpeeds.map((v) => v.speed)) : baseSpeed;
  // 末段加速度：末段峰值速度相对首段的斜率，仍在加速的甩动据此放大初速
  let accel = 0;
  if (segSpeeds.length >= 2) {
    const lastSeg = segSpeeds[segSpeeds.length - 1];
    const firstSeg = segSpeeds[0];
    accel = (lastSeg.speed - firstSeg.speed) / Math.max((lastSeg.tEnd - firstSeg.tEnd) / 1000, MIN_SPAN_MS / 1000);
  }
  const speedBeforeClamp =
    ((1 - PEAK_WEIGHT) * baseSpeed + PEAK_WEIGHT * peakSpeed) *
    (1 + Math.min(Math.max(accel, 0) / ACCEL_REF, 1) * ACCEL_GAIN_MAX);
  const speed = softClampSpeed(speedBeforeClamp) * physics.throwPower;
  if (speed < DEAD_ZONE_SPEED) return null;
  return { vx: (baseVx / baseSpeed) * speed, vy: (baseVy / baseSpeed) * speed };
};

/** 抛体单步积分与边界反弹。返回值带上两个标志：bounced = 本步是否碰边或落地，
 *  atRest = 贴地且低速（或碰边后整体低速），调用方应停止循环。
 *  physics 取成品配置的物理参数，缺失时用默认值兜底。 */
export const throwStep = (
  s: ThrowState,
  dtRaw: number,
  b: ThrowBounds,
  physics: PhysicsParams = DEFAULT_PHYSICS,
): ThrowState & { bounced: boolean; atRest: boolean } => {
  const dt = Math.min(Math.max(dtRaw, 0), MAX_STEP_DT);
  let { x, y, vx, vy } = s;
  vy += physics.gravity * dt;
  x += vx * dt;
  y += vy * dt;
  let bounced = false;
  if (x < b.minX) {
    x = b.minX;
    vx = Math.abs(vx) * physics.restitution;
    bounced = true;
  } else if (x > b.maxX) {
    x = b.maxX;
    vx = -Math.abs(vx) * physics.restitution;
    bounced = true;
  }
  if (y < b.minY) {
    // ceilingBounce=false：顶部无边界，不夹不弹——宠物飞出屏幕顶部，靠重力落回（y 保持越界状态）
    if (physics.ceilingBounce) {
      y = b.minY;
      vy = Math.abs(vy) * physics.restitution;
      bounced = true;
    }
  } else if (y >= b.maxY) {
    y = b.maxY;
    vx *= Math.max(0, 1 - physics.groundFriction * dt);
    if (Math.abs(vy) < REST_VY) vy = 0;
    else vy = -Math.abs(vy) * physics.restitution;
    bounced = true;
  }
  const speed = Math.hypot(vx, vy);
  const atRest =
    (y >= b.maxY - 1 && Math.abs(vy) < 1 && Math.abs(vx) < REST_VX) || (bounced && speed < REST_VY && Math.abs(vy) < 1);
  return { x, y, vx, vy, bounced, atRest };
};

/** 多屏抛掷步进：物理与 throwStep 同一套，区别是边界取自身体中心所在屏，越界后多问一句越界侧有没有屏。
 *  越界侧有别的屏就原样放行（不夹不弹，自然跨屏飞行或落到下一块屏），什么都没有才按该边反弹。
 *  探测用完整面板而不是工作区：任务栏位于上下屏接缝时 workArea 之间会空出一条带，按工作区探测
 *  会把接缝当墙，宠物永远穿不过去。探测点取当前面板的边外第一像素，面板底即物理屏底。
 *  放行时不改位置也不记录当前屏，下一帧由身体中心重新定位——相邻两屏的 AABB 在缝隙处留有
 *  2×sideAllow 宽的重叠盲区，改成「越界即切屏」会在盲区里逐帧对跳。
 *  lockScreen ≥ 0 表示锁定该屏（confineToScreen）：边界恒取该屏、跳过邻屏探测，屏缝与空洞一样当墙；
 *  索引越界（飞行途中拔掉显示器）即退回不锁定，免得拿一块不存在的屏当边界。 */
export const throwStepRegion = (
  s: ThrowState,
  dtRaw: number,
  space: ThrowSpace,
  physics: PhysicsParams = DEFAULT_PHYSICS,
  lockScreen = -1,
): ThrowState & { screen: number; bounced: boolean; atRest: boolean } => {
  const dt = Math.min(Math.max(dtRaw, 0), MAX_STEP_DT);
  let { x, y, vx, vy } = s;
  vy += physics.gravity * dt;
  x += vx * dt;
  y += vy * dt;
  if (space.areas.length === 0) return { x, y, vx, vy, screen: -1, bounced: false, atRest: false };

  const h = (space.size * 9) / 16;
  let bounced = false;
  // 锁定屏（confineToScreen）：索引越界（飞行途中拔掉显示器导致屏数变少）即视为不锁定
  const locked = Number.isInteger(lockScreen) && lockScreen >= 0 && lockScreen < space.areas.length;
  /** 该用哪块屏的 AABB / 工作区 / 面板：锁定时恒为锁定屏，否则取身体中心所在屏 */
  const pick = (i: number): number => (locked ? lockScreen : i);

  // 横向：边界来自身体中心所在屏，放行与否看缝外同高度处有没有像素
  let cur = screenOfBox(space, x, y);
  let b = space.bounds[pick(cur)];
  let a = space.areas[pick(cur)];
  const pa = space.panels[pick(cur)] || a;
  const cy = y + h / 2;
  if (x < b.minX) {
    if (locked || indexAtPoint(space.panels, pa.x - 1, cy) < 0) {
      x = b.minX;
      vx = Math.abs(vx) * physics.restitution;
      bounced = true;
    }
  } else if (x > b.maxX) {
    if (locked || indexAtPoint(space.panels, rectRight(pa), cy) < 0) {
      x = b.maxX;
      vx = -Math.abs(vx) * physics.restitution;
      bounced = true;
    }
  }

  // 纵向：横向若被夹回，身体中心可能已换屏，重新定位
  cur = screenOfBox(space, x, y);
  b = space.bounds[pick(cur)];
  a = space.areas[pick(cur)];
  const pa2 = space.panels[pick(cur)] || a;
  const cx = x + space.size / 2;
  if (y < b.minY) {
    // ceilingBounce=false：顶部无边界，不夹不弹——宠物飞出屏幕顶部，靠重力落回
    if (physics.ceilingBounce && (locked || indexAtPoint(space.panels, cx, pa2.y - 1) < 0)) {
      y = b.minY;
      vy = Math.abs(vy) * physics.restitution;
      bounced = true;
    }
  } else if (y >= b.maxY) {
    // 下方还有一块屏（上下排布的桌面）⇒ 不当地面，继续往下掉
    if (locked || indexAtPoint(space.panels, cx, rectBottom(pa2)) < 0) {
      y = b.maxY;
      vx *= Math.max(0, 1 - physics.groundFriction * dt);
      if (Math.abs(vy) < REST_VY) vy = 0;
      else vy = -Math.abs(vy) * physics.restitution;
      bounced = true;
    }
  }

  cur = pick(screenOfBox(space, x, y));
  b = space.bounds[cur];
  const speed = Math.hypot(vx, vy);
  const atRest =
    (y >= b.maxY - 1 && Math.abs(vy) < 1 && Math.abs(vx) < REST_VX) || (bounced && speed < REST_VY && Math.abs(vy) < 1);
  return { x, y, vx, vy, screen: cur, bounced, atRest };
};

// 积分细分：弹弓没有速度上限，靠拆步保证一帧内的落地与反弹不被跳过，不是力度上限
/** 单步允许的最大位移（px）：一帧位移超过它就拆成多步积分。 */
export const SUBSTEP_PX = 8;
/** 单帧最多拆几步（兜底：极端速度下别把一帧拖成几百次积分）。 */
export const SUBSTEP_MAX = 64;

/** 一帧该积几步（整数 ≥ 1）。N = 1 是常态：普通甩抛一帧位移远小于 8px；
 *  只有弹弓拉得很远、初速几千 px/s 时才拆多步，否则一帧跨过上百 px 会跳过落地与反弹那几帧。
 *  dt 先按 MAX_STEP_DT 夹取（与 throwStep 内部同源），保证步数算的就是实际要积的时间。 */
export const throwSubsteps = (vx: number, vy: number, dt: number): number => {
  const travel = Math.hypot(vx, vy) * Math.min(Math.max(dt, 0), MAX_STEP_DT);
  if (!(travel > SUBSTEP_PX)) return 1;
  return Math.min(SUBSTEP_MAX, Math.ceil(travel / SUBSTEP_PX));
};

/** 多宠物碰撞恢复系数：能量损失约 0.5%（e = 0.995，接近完全弹性）。 */
export const PET_BOUNCE_E = 0.995;

/** 一只参与碰撞的宠物：位置（包围盒左上角，px）+ 速度（px/s）+ 宽（px，质量 ∝ size²）。 */
export interface PetCollider {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
}

/** 身体包围盒（HIT_BOX 命中框比例换算到视口像素）：碰撞相交检测的几何。
 *  box = 宠物包围盒左上角（浏览器 root 的 left/top、桌面窗口位置）；
 *  bottomPad = 舞台脚底垫高（stage 被 translateY 下移的量）。 */
export const bodyPixelBox = (o: {
  x: number;
  y: number;
  size: number;
  bottomPad: number;
}): { left: number; top: number; right: number; bottom: number } => {
  const h = (o.size * 9) / 16;
  return {
    left: o.x + (HIT_BOX.x0 / 640) * o.size,
    top: o.y + o.bottomPad + (HIT_BOX.y0 / 360) * h,
    right: o.x + (HIT_BOX.x1 / 640) * o.size,
    bottom: o.y + o.bottomPad + (HIT_BOX.y1 / 360) * h,
  };
};

/** 两矩形是否相交（碰撞检测）。 */
export const rectsOverlap = (
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
): boolean => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** 飞行中的宠物撞到另一只：近乎弹性碰撞（动量守恒 + 恢复系数 0.995），质量 ∝ size²。
 *  法向 = 两包围盒中心连线，法向速度按一维动量公式重分配，切向分量各自保留（无切向摩擦）。
 *  返回 null = 中心重合定不出法向，或两者正在分离（避免重叠帧反复弹跳抖动）。 */
export const collidePet = (
  fly: PetCollider,
  hit: PetCollider,
): { fvx: number; fvy: number; hvx: number; hvy: number } | null => {
  const hf = (fly.size * 9) / 16 / 2;
  const hh = (hit.size * 9) / 16 / 2;
  const cx = hit.x + hit.size / 2 - (fly.x + fly.size / 2);
  const cy = hit.y + hh - (fly.y + hf);
  const dist = Math.hypot(cx, cy);
  if (dist < 1e-6) return null; // 中心重合：无法定碰撞法向，跳过本帧
  const nx = cx / dist;
  const ny = cy / dist;
  // 相对速度在法向的投影（碰撞方向 = fly → hit，正 = 正在接近）
  const vrel = (fly.vx - hit.vx) * nx + (fly.vy - hit.vy) * ny;
  if (vrel <= 0) return null; // 正在分离：不再弹（避免重叠帧反复触发）
  const e = PET_BOUNCE_E;
  const m1 = fly.size * fly.size;
  const m2 = hit.size * hit.size;
  const v1n = fly.vx * nx + fly.vy * ny;
  const v2n = hit.vx * nx + hit.vy * ny;
  const v1n2 = ((m1 - e * m2) * v1n + (1 + e) * m2 * v2n) / (m1 + m2);
  const v2n2 = ((m2 - e * m1) * v2n + (1 + e) * m1 * v1n) / (m1 + m2);
  // 组合：切向分量（原速度 − 法向分量）不变 + 新法向分量
  return {
    fvx: fly.vx - v1n * nx + v1n2 * nx,
    fvy: fly.vy - v1n * ny + v1n2 * ny,
    hvx: hit.vx - v2n * nx + v2n2 * nx,
    hvy: hit.vy - v2n * ny + v2n2 * ny,
  };
};

/** 共享碰撞站场的槽位（每只宠物注册一个；浏览器半侧 PetMulti 与桌面端的碰撞 broker 共用）。 */
export interface PetCollisionSlot {
  /** 宠物宽（px，质量 ∝ size²） */
  size: number;
  /** 舞台脚底垫高（bodyPixelBox 需要） */
  bottomPad: number;
  /** 当前包围盒左上角（px）；null = 未挂载或无位置 */
  getBox: () => { x: number; y: number } | null;
  /** 当前速度（px/s）；非飞行中为 0 */
  getVel: () => { vx: number; vy: number };
  /** 被撞回调：用新初速从当前落点重新抛掷 */
  onHit: (vx: number, vy: number) => void;
}
