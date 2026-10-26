/**
 * 设置面板导航图标补丁：把「桌宠配置」那一行的兜底齿轮换成指定图标。
 * DSH 的导航图标按分区 id 硬编码白名单，且私有、外部拿不到引用，只能在 DOM 层做。
 * 只打 `data-*` 标记并用 `::before` + mask 画字形，不动 DOM 结构，否则 React 会对被替换的节点 removeChild 崩。
 * 认行只能靠标题文本：投影到 DOM 的只有 label，而 account 行条件出现、位置会漂，不能用 `:nth-child`。
 * 降级：缺 document / MutationObserver、渲不出 SVG 时不装，认不出那一行时什么都不做，只告警。
 * @module dsh-pet/src/client/nav-icon
 */

/** 注入的样式表去重标记（与宠物页面 / 设置页同一套 `data-plugin-css` 约定）。 */
const STYLE_TAG = 'dsh-pet/nav-icon.css';

/** 打在目标行 `<button>` 上的标记属性：React 从不 diff 它，重渲染 / 切语言都不会掉。 */
const MARK = 'data-dsh-pet-nav';

/** 设置面板根节点：shell 用 `createPortal` 挂到 body 上。 */
const PANEL_SELECTOR = '[data-shortcut-modal="settings"]';

/**
 * 类名来自 CSS Modules，哈希前缀会随 DSH 构建变，只匹配 `navList` / `navCell` / `navLabel` 这些名字部分。
 */
const LIST_SELECTOR = '[class*="navList"]';
const CELL_SELECTOR = '[class*="navCell"]';
const LABEL_SELECTOR = '[class*="navLabel"]';

/** 换图标的目标：一行导航的标题与该行要画上的字形。 */
export interface SectionNavIcon {
  /** 目标行标题，与注册 `settings.section` 时的 label 同源；每次现取。 */
  label: () => string;
  /** 把图标渲成内联 SVG 源码；由调用方注入，本模块因此不依赖 react / react-dom。 */
  renderSvg: () => string;
}

/**
 * 把内联 SVG 源码转成可作 CSS mask 的 data URI。
 * 需要补 `xmlns`（data URI 按独立图像文档解析，缺了不渲染）并把 `currentColor` 定成不透明黑（mask 只看 alpha）。
 * @param svg - 内联 SVG 源码。
 * @returns `url("data:image/svg+xml,...")`；源码为空时返回空串。
 */
export function svgMaskUri(svg: string): string {
  const source = svg.trim();
  if (source === '') return '';
  const namespaced = /<svg[^>]*\sxmlns=/i.test(source)
    ? source
    : source.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return 'url("data:image/svg+xml,' + encodeURIComponent(namespaced.split('currentColor').join('#000')) + '")';
}

/** 换字形用的 CSS：盖住齿轮，用 `::before` + mask 画上我们的图标。 */
function cssFor(glyph: string): string {
  return [
    '/* 「桌宠配置」行的导航图标：见 dsh-pet/src/client/nav-icon.ts 的模块注释 */',
    '[' + MARK + '] [class*="navIcon"]{display:none}',
    '[' +
      MARK +
      ']::before{content:"";flex:none;width:16px;height:16px;background-color:currentColor;' +
      '-webkit-mask:' +
      glyph +
      ' center/16px 16px no-repeat;mask:' +
      glyph +
      ' center/16px 16px no-repeat}',
  ].join('\n');
}

/** 注入样式表（只注入一次）。 */
function injectCss(doc: Document, glyph: string): void {
  if (doc.querySelector('style[data-plugin-css="' + STYLE_TAG + '"]') !== null) return;
  const tag = doc.createElement('style');
  tag.dataset.plugin = 'dsh-pet';
  tag.dataset.pluginCss = STYLE_TAG;
  tag.textContent = cssFor(glyph);
  doc.head.appendChild(tag);
}

/** 异常 → 单行文案（告警用）。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把设置面板导航里目标分区的兜底齿轮换成指定图标。
 * @param target - 目标行标题与字形渲染器。
 * @returns 断开观察者的清理函数；已注入的样式与标记留在原地，不影响正确性。
 */
export function installSectionNavIcon(target: SectionNavIcon): () => void {
  const doc = typeof document === 'undefined' ? undefined : document;
  const Observer = typeof MutationObserver === 'undefined' ? undefined : MutationObserver;
  if (doc === undefined || Observer === undefined || doc.body === null) {
    console.warn('[dsh-pet] 设置页导航图标不可用：缺少 document / body / MutationObserver（齿轮照旧）');
    return () => {};
  }

  let glyph: string;
  try {
    glyph = svgMaskUri(target.renderSvg());
  } catch (error) {
    console.warn('[dsh-pet] 设置页导航图标不可用：图标渲染失败（齿轮照旧）：' + describe(error));
    return () => {};
  }
  if (glyph === '') {
    console.warn('[dsh-pet] 设置页导航图标不可用：图标渲成了空 SVG（齿轮照旧）');
    return () => {};
  }
  injectCss(doc, glyph);

  // 认不出那一行是预期内的（比如 DSH 改了标题来源），只记一次不刷屏。
  let warned = false;

  /** 给面板里标题匹配的那一行打标记（幂等；已打过的不再读标题）。 */
  const markPanel = (panel: Element): void => {
    try {
      const wanted = target.label();
      if (wanted === '') return;
      const list = panel.querySelector(LIST_SELECTOR);
      if (list === null) return;
      for (const cell of list.querySelectorAll(CELL_SELECTOR)) {
        if (cell.getAttribute(MARK) !== null) continue;
        if (cell.querySelector(LABEL_SELECTOR)?.textContent === wanted) cell.setAttribute(MARK, '');
      }
    } catch (error) {
      if (!warned) {
        warned = true;
        console.warn('[dsh-pet] 设置页导航图标补丁异常，本次跳过（齿轮照旧）：' + describe(error));
      }
    }
  };

  // 两段式观察：body 只盯直接子节点，命中面板后改盯面板子树——聊天区 DOM 抖动频繁，全文档扫太贵。
  let watched: Element | undefined;
  let panelObserver: MutationObserver | undefined;

  const sync = (): void => {
    const panel = doc.querySelector(PANEL_SELECTOR);
    if (panel === null) {
      panelObserver?.disconnect();
      panelObserver = undefined;
      watched = undefined;
      return;
    }
    markPanel(panel);
    if (panel === watched) return;
    panelObserver?.disconnect();
    watched = panel;
    panelObserver = new Observer(() => {
      markPanel(panel);
    });
    panelObserver.observe(panel, { childList: true, subtree: true });
  };

  // 插件可能在面板已打开时装配（刷新 / 热更新），所以先同步扫一遍。
  sync();
  const bodyObserver = new Observer(sync);
  bodyObserver.observe(doc.body, { childList: true });

  return () => {
    bodyObserver.disconnect();
    panelObserver?.disconnect();
  };
}
