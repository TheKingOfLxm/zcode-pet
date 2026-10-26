export declare const PET_DISPLAY_SET: ReadonlySet<string>;
/** id 禁用的字符（Windows 文件名保留符 + 控制字符，防配置值逃逸文件路径）。
 *  同时被 thumb 路由的 petId 校验复用：那里同样是「标识符不得当路径片段」。 */
export declare const ID_FORBIDDEN: RegExp;
/**
 * 读磁盘上的用户层原对象（JSONC 容忍，与读取路径共用同一份解析器）。
 * 写路径必须用它：PUT /config 的透传保留要把用户手改的高级字段原样带回，而用户层可能是带 // 注释
 * 的 config.jsonc 原文；若用严格 JSON.parse，解析抛错被吞 → existing 变 undefined → 白名单重建
 * → 高级字段全部丢失。文件不存在 / 损坏 → undefined。
 */
export declare function readUserConfig(paths: ConfigPaths): Record<string, unknown> | undefined;
/**
 * 用户层存在但解析不了（真损坏：连 JSONC 剥注释都救不回来）。
 * 用途：PUT /config 的损坏预检——保存是白名单重建，existing 读不出来会让原有内容被整份静默丢掉，
 * 所以先不写盘、回 409 让设置页弹窗确认。文件不存在 → false。
 */
export declare function userConfigUnparsable(paths: ConfigPaths): boolean;
/** 配置路径集（宿主组装好后传入，单一事实来源） */
export interface ConfigPaths {
    /** 包内 assets/config.jsonc（内置默认，绝对正确） */
    defaultFile: string;
    /** ~/.dsh/dsh-pet/main-config.jsonc（用户主配置，可编辑层；JSONC——允许注释） */
    userFile: string;
    /** 旧路径 ~/.dsh/dsh-pet/main-config.json：读取回落 + 启动时迁移（见 migrateUserConfig） */
    legacyUserFile?: string;
    /** ~/.dsh/dsh-pet/pet（文件宠物目录） */
    petDir: string;
}
/**
 * 老用户一次性迁移：main-config.json → main-config.jsonc（重命名，内容一字不动）。
 * 为什么改扩展名：用户层从「同步」起就是带 // 注释的 JSONC 原文，挂在 .json 名下名不副实。
 * 新文件已存在 → 什么都不做（绝不用旧文件覆盖新文件）；重命名失败静默放过，读取侧有回落。
 */
export declare function migrateUserConfig(paths: ConfigPaths, log?: (message: string) => void): boolean;
/**
 * 按条目 key（= 文件名前缀 = 素材根）定位文件宠物的实际文件与磁盘原对象。
 * 写路径（POST /pet-display）改文件宠物的 display 时，既要写回它自己的配置文件，也要拿该文件的
 * existing 做透传保留，否则手改的 whisperPrompt / animations / memes 会被白名单重建抹掉。
 * 扩展名不写死（.json 或 .jsonc），写错就会新建一个空配置；前缀不存在 → undefined。
 */
export declare function readPetConfigEntry(paths: ConfigPaths, entry: string): {
    path: string;
    raw: Record<string, unknown> | undefined;
} | undefined;
/**
 * 唯一读取函数：内置默认 + 用户主配置 + 文件宠物逐字段合并后的成品聚合。
 * 每个条目都是原文件结构且字段已填满，消费端直接读；每次调用重新读文件，改配置即刻生效。
 */
export declare function readAllConfig(paths: ConfigPaths): Record<string, Record<string, unknown>>;
/** 拍平全部条目的 pets 为单列表（host 消费端用：桌面宠物列表 / 命令 / 当前桌宠解析） */
export declare function flattenPetList(merged: Record<string, Record<string, unknown>>): Record<string, unknown>[];
/** 在完成品聚合里按实例 id 定位宠物及其所属条目（host 内部消费索引）：
 *  条目 key 即素材根（assetRoot）；条目级字段（whisperPrompt/chatMemoryRounds/animations）随条目取
 *  （唯一例外：whisperPrompt 可被实例覆盖——调用方要生效值请走 ./persona 的 petPersona，别直接读 conf）。 */
export declare function findPetInstance(merged: Record<string, Record<string, unknown>>, petId: string): {
    entry: string;
    conf: Record<string, unknown>;
    pet: Record<string, unknown>;
} | undefined;
/**
 * 保存用户层（PUT /config）：接受 pets + 全局开关 + physics / font / 两个模型 / 对话参数。
 * 非白名单顶层字段（whisperPrompt、eventsRefreshSec、memes 等）从 existing 原样透传保留——
 * 用户手动编辑的精调配置不会被设置页保存抹掉；白名单字段也只在请求体真的传了时才算白名单。
 * 非法 → 返回 null（宿主回 400）。与读取分离：文件宠物永不回写。
 */
export declare function saveUserConfig(raw: unknown, existing?: Record<string, unknown>): {
    pets: unknown[];
    [key: string]: unknown;
} | null;
/**
 * 同步用户层（POST /config，设置页「同步」）：把内置默认配置原文写入用户主配置文件。
 * 复制原文而不是删除用户层：既等价于恢复默认（合并结果 = 内置默认），又让用户拿到一份含全部
 * 注释、开箱可编辑的完整配置。读取侧统一走 stripJsonc，带注释写入照样能读。
 * 注意：文件一旦生成即成为显式覆盖层，插件升级改了内置默认后，文件里的旧值仍会继续生效。
 * 默认文件缺失 / 目录不可写 → 直接抛（宿主回 500），绝不静默留下半个配置文件。
 */
export declare function syncUserConfigFromDefault(paths: ConfigPaths): void;
/**
 * 对话记忆截取：取尾部 rounds 轮（1 轮 = 1 问 1 答 → 2 条）。
 * 不能写 messages.slice(-rounds * 2)：rounds = 0 时 -0 === 0，slice(-0) 返回整个数组，
 * 「关掉历史」反而变成「带全部历史」。这里显式分支：0 → 空列表，> 0 → 截尾部。
 */
export declare function sliceMemoryRounds<T>(messages: T[], rounds: number): T[];
