/** 日志级别（与 DSH 的 `ctx.logger` 四档一致）。 */
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';
/** 与 DSH 的 `ctx.logger` 使用面一致的最小接口（各方法都可缺省）。 */
export interface LoggerLike {
    info?(message: string): void;
    warn?(message: string): void;
    error?(message: string): void;
    debug?(message: string): void;
}
/** 文件日志出口：在 LoggerLike 之上多一个落盘句柄与身份标记。 */
export interface FileLogger extends Required<LoggerLike> {
    /** 日志文件路径（宿主据此判断能否复用，避免两个 logger 写同一个文件） */
    readonly file: string;
    /** 身份标记：`isFileLogger` 用它识别「这个 logger 已经是文件出口」 */
    readonly isFileLogger: true;
    /**
     * 把缓冲区写盘（并做大小检查）。可安全重复调用；并发调用共享同一次写入。
     * 调用方在进程退出前应 await 它。
     */
    flush(): Promise<void>;
    /** 停掉定时器并补一次 flush（不 await；需要确保落盘请先 `await flush()`） */
    dispose(): void;
}
/** 判断一个对象是否已是本模块创建的文件 logger（standalone/app 会把它挂在 ctx.logger 上）。 */
export declare function isFileLogger(value: unknown): value is FileLogger;
/** createFileLogger 的选项；全部可选，缺省值见下方常量。 */
export interface FileLoggerOptions {
    /** 日志文件绝对路径（父目录不存在会自动创建） */
    file: string;
    /** 原始终端/宿主 logger：日志同时转发给它，node 版终端里照旧可见 */
    base?: LoggerLike;
    /** 单文件上限，默认 1 MiB */
    maxBytes?: number;
    /** 超过上限后保留的尾部大小，默认 512 KiB */
    keepBytes?: number;
    /** 定时 flush 间隔，默认 1000ms */
    flushIntervalMs?: number;
    /** 攒够多少条立即 flush，默认 64 */
    flushThreshold?: number;
    /** 内存里最多缓冲多少条（超出丢最旧），默认 1000 */
    maxPending?: number;
    /** debug 级别是否落盘，默认关（`DSH_PET_LOG_DEBUG=1` 打开） */
    debugEnabled?: boolean;
    /** 时间源（测试注入用） */
    now?: () => Date;
}
/** 单文件上限：1 MiB。 */
export declare const LOG_MAX_BYTES: number;
/** 截断后保留的尾部：512 KiB。 */
export declare const LOG_KEEP_BYTES: number;
/** 定时 flush 间隔。 */
export declare const LOG_FLUSH_MS = 1000;
/** 攒够多少条立即 flush。 */
export declare const LOG_FLUSH_LINES = 64;
/** 内存缓冲上限。 */
export declare const LOG_MAX_PENDING = 1000;
/**
 * 落盘前的脱敏：令牌等价登录态，不能因为「顺手记一行日志」就写进文件。
 * 只处理已知会出现在日志里的几种形态，宁可误伤（把值打码）也不漏。
 */
export declare function redactSensitive(text: string): string;
/** 截断时保留尾部 `keepBytes` 字节；取尾部会切断多字节字符，调用方只用于拼日志文本，可接受。 */
export declare function tailForTrim(content: Buffer, keepBytes: number): Buffer;
/** 一行日志的最终形态：`<ISO 时间> [级别] 正文`（正文里的换行保留，便于堆栈可读）。 */
export declare function formatLogLine(level: LogLevel, message: string, now: Date): string;
/** 创建一个文件日志出口：日志同时转发给 `base`，落盘按批量与大小上限处理。 */
export declare function createFileLogger(options: FileLoggerOptions): FileLogger;
/**
 * 无人值守路径上的便捷封装（debug 级别由环境变量控制）。
 * `src/app/main.ts` 这类没有 `ctx.logger` 的进程用它（见 app 主进程的 console 包装）。
 */
export declare function createPlainFileLogger(file: string, base?: LoggerLike): FileLogger;
/** 由宿主（apply / standalone / app）在拿到统一 logger 后调用；传 null 复位（测试用）。 */
export declare function setDefaultLogger(logger: LoggerLike | null): void;
/** 写一条模块级日志；没有统一 logger 时退回 console（debug 仍受环境变量控制）。 */
export declare function defaultLog(level: LogLevel, message: string): void;
