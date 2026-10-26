/**
 * 工具调用 → 工作状态气泡里的具体详情（「翻翻 index.ts 看看嘛」「该推上去了吧，我来」）。
 *
 * 文案是数据：加工具、加命令、改语气只加一行字符串，不碰判定代码；每句都要带具体对象（没有对象
 * 的气泡等于没说）。不负责气泡的其他字段与档位（见 ./work-status），唯一依赖是它的长度上限 TASK_TEXT_MAX。
 * 必须始终成立：气泡是上屏内容——命令只看命令名、参数一律不显示（可能带 token 或内网地址）；
 * 复合命令（`;` `|` `&&` 换行）一律不猜，返回 null 让前端回落到配置文案；目标太长就换不带名字
 * 的氛围短句（硬塞会撑破气泡）；write / edit 的超大 arguments 不解析（动辄几百 KB）。
 * @module dsh-pet/src/host/tool-detail
 */

import { TASK_TEXT_MAX } from './work-status';

/** 句子里可用的占位符：{target} 目标名、{cmd} 命令名。 */
type CopyLine = string;

/** 从解析后的参数里取「目标」（文件名 / 搜索词 / 域名…）；取不到 → null。 */
type TargetPicker = (args: Record<string, unknown>) => string | null;

/** 只描述「怎么取目标」，不含任何文案（文案全部在下面的表里）。 */
interface ToolRule {
  pick: TargetPicker;
  /**
   * 目标是不是路径：只有路径才做「太长只留文件名」的压缩。
   * 描述、搜索词、域名这类文本不该被 `/` 切开。
   */
  path?: boolean;
}

/** 文件名/图片类：每句都带 {target}。 */
const FILE_COPY: readonly CopyLine[] = ['翻翻 {target} 看看嘛', '{target} 里面写了啥呢', '我先瞅瞅 {target} 哈'];

/** 写文件。 */
const WRITE_COPY: readonly CopyLine[] = ['写点东西到 {target}', '{target} 马上写出来', '给 {target} 添点料'];

/** 改文件。 */
const EDIT_COPY: readonly CopyLine[] = ['{target} 得改改啦', '我来动动 {target} 哦', '{target} 这里要修一下'];

/** 找文件。 */
const GLOB_COPY: readonly CopyLine[] = ['{target} 都躲哪儿了呢', '找找 {target} 在不在', '{target} 藏在哪个角落呀'];

/** 搜内容。 */
const GREP_COPY: readonly CopyLine[] = ['{target} 藏哪儿了呢', '搜搜 {target} 在哪', '哪儿有 {target} 呀'];

/** 给人看文件。 */
const PRESENT_COPY: readonly CopyLine[] = ['给你看 {target} 哦', '{target} 拿来给你瞧瞧', '喏，{target} 在这儿'];

/** 学技能。 */
const SKILL_COPY: readonly CopyLine[] = ['学个新本事 {target}', '{target} 这招得记住', '把 {target} 学起来'];

/** 委派子任务。 */
const SUBAGENT_COPY: readonly CopyLine[] = ['叫人搭把手：{target}', '让帮手去看看 {target}', '{target} 交给帮手了'];

/** 一个工具的文案：3 句带 {target} 的说法 + 目标太长时的一句纯氛围兜底。 */
interface ToolCopy {
  readonly lines: readonly CopyLine[];
  /** 目标超过 TARGET_DISPLAY_MAX 时用：不出现文件名与工具名（气泡是氛围，不是信息面板） */
  readonly short: CopyLine;
}

/** 工具 → 文案。没列在这里的工具走 UNKNOWN_TOOL_LINE。 */
const TOOL_COPY: Readonly<Record<string, ToolCopy>> = {
  read: { lines: FILE_COPY, short: '翻翻代码看看' },
  read_image: {
    lines: ['这 {target} 长啥样呀', '让我瞧瞧 {target} 呗', '{target} 是张什么图呢'],
    short: '看看这张图是啥',
  },
  write: { lines: WRITE_COPY, short: '写点东西进去' },
  edit: { lines: EDIT_COPY, short: '这里得改改' },
  str_replace_editor: { lines: EDIT_COPY, short: '这里得改改' },
  glob: { lines: GLOB_COPY, short: '找找东西在哪' },
  grep: { lines: GREP_COPY, short: '到处翻翻看' },
  present: { lines: PRESENT_COPY, short: '拿个东西给你看' },
  skill: { lines: SKILL_COPY, short: '学个新本事' },
  subagent: { lines: SUBAGENT_COPY, short: '叫人来搭把手' },
  subagent_fork: { lines: SUBAGENT_COPY, short: '叫人来搭把手' },
  workflow: {
    lines: ['把活排个序，开工咯', '几件事一起安排上', '按顺序一件件来'],
    short: '把活排一排',
  },
  web_search: {
    lines: ['我去查查 {target}', '{target} 得搜搜才知道', '上网问问 {target} 吧'],
    short: '上网查查',
  },
  web_fetch: {
    lines: ['去 {target} 瞅瞅有啥', '{target} 这页我翻翻', '看看 {target} 上写了啥'],
    short: '去网上看看',
  },
};

/** 未知工具：只说一句氛围话，不报工具名（`str_replace_editor` 这种名字上屏很怪）。 */
const UNKNOWN_TOOL_LINE: CopyLine = '这工具是干嘛的';

/** 兜底：没进表的命令（npm / python / node / tsc / eslint / docker…），短命令名会上屏。 */
const COMMAND_FALLBACK: readonly CopyLine[] = ['跑一下 {cmd} 咯', '{cmd} 跑起来了', '让 {cmd} 干点活'];

/** 兜底：命令名本身太长（如 Get-NetTCPConnection）时用，不带名字。 */
const COMMAND_NAME_TOO_LONG: CopyLine = '跑一个命令咯';

const CD_COPY: readonly CopyLine[] = ['先把位置挪一挪', '切到那个目录去', '挪个地方继续干活'];
const LS_COPY: readonly CopyLine[] = ['看看这儿都有啥', '这层都有什么东西', '翻翻这里有没有'];
const CAT_COPY: readonly CopyLine[] = ['把内容亮出来瞧瞧', '看看里头写了什么', '读读这份内容'];
const MKDIR_COPY: readonly CopyLine[] = ['建个新文件夹', '腾个地方出来', '新开一个目录'];
const RM_COPY: readonly CopyLine[] = ['把不要的清掉', '这份就别留了', '清理一下这些'];
const MV_COPY: readonly CopyLine[] = ['把东西挪个地儿', '换个位置放', '挪到那边去'];
const CP_COPY: readonly CopyLine[] = ['抄一份留着', '复制一份备用', '再备一份'];
const CURL_COPY: readonly CopyLine[] = ['去问问接口有没有人', '敲敲门看看通不通', '请求一下那个地址'];
const CHECKOUT_COPY: readonly CopyLine[] = ['换到那个分支瞧瞧', '切个分支看看', '换条路继续走'];

/** 命令 / 「命令 子命令」→ 3 句候选（键一律小写，别名共用同一组）。 */
const COMMAND_COPY: Readonly<Record<string, readonly CopyLine[]>> = {
  cd: CD_COPY,
  'set-location': CD_COPY,
  ls: LS_COPY,
  dir: LS_COPY,
  'get-childitem': LS_COPY,
  cat: CAT_COPY,
  'get-content': CAT_COPY,
  mkdir: MKDIR_COPY,
  'new-item': MKDIR_COPY,
  rm: RM_COPY,
  del: RM_COPY,
  'remove-item': RM_COPY,
  mv: MV_COPY,
  'move-item': MV_COPY,
  cp: CP_COPY,
  'copy-item': CP_COPY,
  curl: CURL_COPY,
  'invoke-webrequest': CURL_COPY,

  // git：没命中子命令时用这一组
  git: ['折腾折腾 git 仓库', '跟 git 打个交道', 'git 这边动一动'],
  'git status': ['看看现在改了些什么', '查查工作区干不干净', '目前是啥状况呢'],
  'git diff': ['瞅瞅这次到底改哪了', '到底动了哪些地方呀', '对比看看都改了啥'],
  'git log': ['让我康康你的提交历史', '翻翻最近都提交了啥', '看看这些天干了什么'],
  'git add': ['先把这些攒起来', '好东西先收进去', '把改动的都登记上'],
  'git commit': ['代码得保存好才行', '打个提交，记一笔', '先存一份再说'],
  'git push': ['该推上去了吧，我来', '推送一下，交给我', '该让远端知道了'],
  'git pull': ['拉一下最新的过来', '把远端的新东西拿回来', '先同步一下再说'],
  'git fetch': ['先问问远端有没有新东西', '悄悄看一眼远端', '拉个最新状态下来'],
  'git checkout': CHECKOUT_COPY,
  'git switch': CHECKOUT_COPY,
  'git branch': ['看看都有哪些分支', '理理这些分支', '新建个分支备用'],
  'git merge': ['把两边合到一起', '合并一下，别打架', '这两条线该合了'],
  'git rebase': ['把历史重新捋一捋', '重新排一下顺序', '理一理提交顺序'],
  'git stash': ['先把改动收起来', '这些先搁一边', '暂时藏起来一下'],
  'git clone': ['把整个仓库搬回来', '照着一份抄下来', '把这份拿下来瞧瞧'],
  'git reset': ['把刚才的退回去', '撤销一下这几步', '回到之前的样子'],
  'git tag': ['给这次打个标记', '贴个版本标签', '记个里程碑'],
};

/**
 * 语义已由别处表达、不该进气泡的工具：
 * `todo_write` 的文案本身就是气泡正文（写它等于自己盖自己）；`ask_user_question` 与 goal 系已有
 * 专门档位（waiting / success / error）；`exit_plan_mode` 是纯内部调度。
 * 这些报出来不是重复就是噪音。
 */
const SILENT_TOOLS: ReadonlySet<string> = new Set([
  'todo_write',
  'ask_user_question',
  'create_goal',
  'get_goal',
  'update_goal',
  'exit_plan_mode',
]);

/** 取目标的方式（与文案表按工具名关联；pwsh 不在这里，它走命令表）。 */
const TOOL_RULES: Readonly<Record<string, ToolRule>> = {
  read: { pick: fileTarget, path: true },
  read_image: { pick: fileTarget, path: true },
  write: { pick: fileTarget, path: true },
  edit: { pick: fileTarget, path: true },
  str_replace_editor: { pick: fileTarget, path: true },
  glob: { pick: (args) => firstStr(args, ['pattern', 'path']) },
  grep: { pick: (args) => firstStr(args, ['pattern', 'path']) },
  web_fetch: { pick: urlHost },
  web_search: { pick: queryTarget },
  subagent: { pick: (args) => firstStr(args, ['description']) },
  subagent_fork: { pick: (args) => firstStr(args, ['description']) },
  workflow: { pick: (args) => firstStr(args, ['name', 'description']) },
  skill: { pick: (args) => firstStr(args, ['name']) },
  present: { pick: filesTarget, path: true },
};

/** 非空字符串（去首尾空白），否则 null——所有取参都先过它。 */
function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** 按候选顺序取第一个非空字符串：同名工具在不同版本里字段叫法可能不同（file_path / filePath / path）。 */
function firstStr(args: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = str(args[key]);
    if (value !== null) return value;
  }
  return null;
}

/** 文件类工具：`file_path` 是主流，`path` 是部分工具的写法。 */
function fileTarget(args: Record<string, unknown>): string | null {
  return firstStr(args, ['file_path', 'filePath', 'path']);
}

/** 网页：给主机名就够（完整 URL 又长又带查询串，气泡放不下也没必要）。 */
function urlHost(args: Record<string, unknown>): string | null {
  const raw = str(args.url);
  if (raw === null) return null;
  try {
    const host = new URL(raw).host;
    return host === '' ? null : host;
  } catch {
    // 不是合法 URL（缺协议等）：退化成「去掉协议后取第一段」，绝不抛
    const rest = raw.replace(/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//, '');
    const head = rest.split(/[/?#]/)[0] ?? '';
    return head === '' ? null : head;
  }
}

/** 网络搜索：`queries` 可能是数组（主流）或单数字符串，两种都认。 */
function queryTarget(args: Record<string, unknown>): string | null {
  const queries = args.queries;
  if (Array.isArray(queries)) {
    for (const item of queries) {
      const value = str(item);
      if (value !== null) return value;
    }
    return null;
  }
  return firstStr(args, ['queries', 'query']);
}

/** 展示文件：`files` 是 `[{ path, description }]`，取第一个的 path（没有就取 description）。 */
function filesTarget(args: Record<string, unknown>): string | null {
  const files = args.files;
  if (!Array.isArray(files)) return null;
  for (const item of files) {
    if (item === null || typeof item !== 'object') continue;
    const picked = firstStr(item as Record<string, unknown>, ['path', 'description']);
    if (picked !== null) return picked;
  }
  return null;
}

/**
 * 命令名长什么样：ASCII 字母开头、至少两个字符、只含字母数字与 `_ . -`。
 * 纯数字（`18016`）、中文串（`监听`）、符号（`==`）、开关（`-v`）、单字母变量（`x`）全部落选——
 * 它们几乎只会是字符串字面量或参数，而不是命令本身。
 */
const COMMAND_LIKE = /^[A-Za-z][A-Za-z\d_.-]+$/;

/** 子命令长什么样：单词形态（`status` / `log` / `push`），不接受开关与路径。 */
const SUBCOMMAND_LIKE = /^[A-Za-z][A-Za-z\d-]*$/;

/** 复合命令：`;` `|` `&&` `||` 换行一律不猜（引号内的竖线也会被判成复合，宁保守）。 */
const COMPOUND_COMMAND = /[;|]|&&|\|\||\r?\n/;

/**
 * 取命令名时要剥掉的边角字符（运算符、括号、重定向、引号、变量前缀…）。
 * 例：`(Get-NetTCPConnection` → `Get-NetTCPConnection`；`$env:FOO` → `env:FOO`（随后判定落选）。
 */
const EDGE_CHARS = new Set('&.([{!@$^+:=,;|"\'`)]}>#');

/** 剥掉词首词尾的边角字符。 */
function trimEdges(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && EDGE_CHARS.has(token.charAt(start))) start += 1;
  while (end > start && EDGE_CHARS.has(token.charAt(end - 1))) end -= 1;
  return token.slice(start, end);
}

/**
 * 把命令行切成「词」：引号内的整体算一个词（`"C:\Program Files\node.exe"` 不会被空格劈开），
 * 引号本身丢弃，`;` / `|` 当分隔符。
 *
 * 这不是通用 shell 解析器，只为「找命令名」服务，所以只处理引号与分隔符，不解释变量、转义与管道。
 */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch) || ch === ';' || ch === '|') {
      if (current !== '') tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current !== '') tokens.push(current);
  return tokens.map(trimEdges).filter((token) => token !== '');
}

/** arguments 的解析上限（UTF-16 码元数）：超过就不解析（write / edit 会带上整个文件内容）。 */
const MAX_ARGS_CHARS = 64 * 1024;

/** 气泡里目标的展示上限（码点）：超过就只留文件名。 */
const TARGET_MAX = 22;

/**
 * 目标上屏的长度上限（码点）：超过就整句换成该工具的氛围兜底。
 * 比 TARGET_MAX 小是有意的——路径压缩后仍超过这个数的（长文件名、长 grep 正则、长 query）
 * 硬塞进句子会撑破气泡（真实案例：`grep` 的 pattern 是 `WORK_STATE_GAP_MS|busyFlip|…`）。
 */
const TARGET_DISPLAY_MAX = 20;

/** 解析 tool/call 的 arguments（JSON 字符串；个别版本可能直接给对象）→ 参数对象；失败或超大 → null。 */
function parseArgs(raw: unknown): Record<string, unknown> | null {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_ARGS_CHARS) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 按码点截断（与 ./work-status 的 currentTaskFromTodo 同口径：超长留 TASK_TEXT_MAX 个 + 省略号）。 */
function clip(text: string): string {
  const points = Array.from(text);
  return points.length > TASK_TEXT_MAX ? `${points.slice(0, TASK_TEXT_MAX).join('')}…` : text;
}

/** 随机取一句（同一句连着出现很假，这里按调用随机）。 */
function pickLine(lines: readonly CopyLine[]): CopyLine {
  return lines[Math.floor(Math.random() * lines.length)] ?? lines[0] ?? '';
}

/** 填占位符（`{target}` / `{cmd}` / `{tool}`）；未知占位符原样保留。 */
function fill(line: CopyLine, vars: Readonly<Record<string, string>>): string {
  let out = line;
  for (const [key, value] of Object.entries(vars)) out = out.split(`{${key}}`).join(value);
  return out;
}

/**
 * 目标压短：短路径原样，长路径只留文件名。
 * 统一成 `/` 是为了跨平台文案一致（Windows 的 `\` 在气泡里更占宽度也更难读）。
 */
function compactTarget(raw: string, pathLike: boolean): string {
  if (!pathLike) return raw;
  const text = raw.replace(/\\/g, '/').replace(/\/+$/, '');
  if (Array.from(text).length <= TARGET_MAX) return text;
  const parts = text.split('/').filter((part) => part !== '');
  return parts.length > 0 ? (parts[parts.length - 1] as string) : text;
}

/**
 * `pwsh` 的文案：按命令名（必要时加子命令）查表，查不到走兜底。
 *
 * 复合命令 → null，让前端回落配置文案（无法判断真正在做什么）；`git log` 这类命中「命令 + 子命令」
 * 用子命令文案，只命中命令（`git`、`cd`）用通用文案，都没命中（`npm`、`python`、`node`…）走兜底——
 * 兜底带命令名，至少知道在跑什么。
 */
function pwshDetail(args: Record<string, unknown> | null): string | null {
  const command = args === null ? null : str(args.command);
  if (command === null) return null;
  if (COMPOUND_COMMAND.test(command)) return null;
  const tokens = tokenizeCommand(command);
  const nameAt = tokens.findIndex((token) => COMMAND_LIKE.test(token));
  if (nameAt < 0) return null;
  const rawCmd = tokens[nameAt] as string;
  const lookup = rawCmd.toLowerCase();
  // 子命令：命令名后面第一个「像子命令」的词（跳过开关与参数值）
  const subAt = tokens.findIndex((token, index) => index > nameAt && SUBCOMMAND_LIKE.test(token));
  const sub = subAt < 0 ? null : (tokens[subAt] as string).toLowerCase();
  const lines = (sub === null ? undefined : COMMAND_COPY[`${lookup} ${sub}`]) ?? COMMAND_COPY[lookup];
  if (lines !== undefined) return clip(pickLine(lines));
  // 命令名本身太长（Get-NetTCPConnection 这种）→ 退回不带名字的兜底
  if (Array.from(rawCmd).length > TARGET_DISPLAY_MAX) return clip(COMMAND_NAME_TOO_LONG);
  return clip(fill(pickLine(COMMAND_FALLBACK), { cmd: rawCmd }));
}

/**
 * `tool/call` 事件 → 气泡详情；跳过、无法解析、无信息量 → null。
 *
 * 返回值可以直接写进 `sections.workStatus.data.task`（长度 ≤ TASK_TEXT_MAX + 1）。
 */
export function toolDetailFromEvent(
  event: { data?: { name?: unknown; arguments?: unknown } } | null | undefined,
): string | null {
  const name = str(event?.data?.name);
  if (name === null) return null;
  if (SILENT_TOOLS.has(name)) return null;
  const args = parseArgs(event?.data?.arguments);
  // pwsh 走命令表（它没有「文件目标」，目标就是命令本身）
  if (name === 'pwsh') return pwshDetail(args);
  const entry = TOOL_COPY[name] as ToolCopy | undefined;
  // 未知工具：不猜参数，也不报工具名
  if (entry === undefined) return clip(UNKNOWN_TOOL_LINE);
  const rule = TOOL_RULES[name] as ToolRule | undefined;
  const line = pickLine(entry.lines);
  // workflow 这类整句不带对象的，直接给（不需要目标）
  if (!line.includes('{target}')) return clip(line);
  const target = args === null || rule === undefined ? null : rule.pick(args);
  // 拿不到目标 → null，不覆盖气泡里已有的文案（todo 文案比半句话有信息量）
  if (target === null) return null;
  const shown = compactTarget(target, rule?.path === true);
  // 目标太长 → 换一句不带名字的氛围兜底（硬塞会撑破气泡，见 TARGET_DISPLAY_MAX 的说明）
  if (Array.from(shown).length > TARGET_DISPLAY_MAX) return clip(entry.short);
  return clip(fill(line, { target: shown }));
}
