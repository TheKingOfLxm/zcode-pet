/**
 * 表情包池（宿主半侧）：把配置的 memes 映射（名称 → 描述）解析成可用的候选池，碎碎念与对话共用。
 *
 * 不负责目录链的推导（host/index.ts 的 memeDirsFor 决定顺序与优先级），也不碰图片字节。
 * 必须始终成立：池的顺序 = 配置里写的顺序，且只有磁盘上真实存在的图才算命中——池说「能选」，
 * /pic/memes 就必须「取得到」，否则气泡图裂。文件缺失的条目静默剔除（用户删图后不必同步改
 * 配置），配置没写的图不参与（无从得知它的描述）。纯函数 + 目录参数，便于测试。
 * 契约见 CONFIG.md 与 API.md。
 * @module dsh-pet/src/host/memes
 */
/** 池中一张图：name = 配置键（= 文件名去扩展名），desc = 给模型看的描述。 */
export interface MemeEntry {
    name: string;
    desc: string;
}
/**
 * 从配置的 memes 映射解析出候选池。
 * @param memes - 配置的 memes 值（未配置 / 类型非法 → 空池）。
 * @param dirs - 表情包目录链（顺序即优先级；空链 → 空池）。
 * @returns 按配置里写的顺序排列的候选池（链上都没有该图、或描述为空 → 剔除）。
 */
export declare function readMemePool(memes: unknown, dirs: readonly string[]): MemeEntry[];
/** 抽一张图（均匀随机）；空池返回 undefined。 */
export declare function pickMeme(pool: MemeEntry[], random?: () => number): MemeEntry | undefined;
/** 模型选图校验：只在池内命中时才认（防幻觉出池外名称），命中返回该条目。 */
export declare function matchMeme(pool: MemeEntry[], name: string): MemeEntry | undefined;
/**
 * 从模型回复里取配图（对话选图的解析半侧；纯函数，无 LLM 依赖）。
 *
 * 命中池内 → 采纳该图并把标记从正文剥离（标记不得留在用户可见文本里）；未命中（模型幻觉名称）、
 * 空池、只回标记不回正文 → 一律视为没选，正文原样保留（解析失败绝不吞掉回复）。
 */
export declare function extractChatImage(text: string, pool: MemeEntry[]): {
    text: string;
    image?: string;
};
/** 表情包清单 → 给模型看的候选列表（一行一张：名称 + 描述）。 */
export declare function memeCatalog(pool: MemeEntry[]): string;
/**
 * 按「对话配图张数上限」（配置 chatImageLimit）截断候选池。
 *
 * `limit <= 0` 或非有限数 → 原样返回（0 = 不限制）；`limit > 0` → 取池内前 limit 张，池序就是
 * 配置书写顺序，想让哪几张优先被发出去往前写即可；小数向下取整。
 * 只作用于对话选图：整张清单每条对话消息都要附，token 随张数线性增长，截断后单条消息的配图
 * 开销立刻可控；碎碎念只带抽中的那一张，不经过这里。
 */
export declare function limitPool(pool: MemeEntry[], limit: number): MemeEntry[];
