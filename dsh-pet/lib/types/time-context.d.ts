/**
 * 时间背景（宿主半侧，纯逻辑）：把「现在几点 + 今天是不是什么日子」翻成一段中文，由 index.ts 的
 * petSystemPrompt 追加到 system 末尾——碎碎念与对话共用同一份拼装，一处生效、两端都有。
 * 不碰 IO、不读时钟（Date 由调用方传入），零依赖；非法 Date 返回空串，调用方据此整行不加。
 * 日期与星期读 Date 的本地时间字段（桌宠说「晚上好」要跟着用户所在时区走）；农历用 ICU 自带的中国
 * 农历日历换算，不引第三方库——它的已知精度边界见 lunarPartsOf，要绝对准确只需换掉那一处实现。
 * 契约见 CONFIG.md 与 openapi.yaml。
 * @module dsh-pet/src/host/time-context
 */
/** 时段文案：一天分 9 档（划分见 SLOTS）。 */
export type TimeSlot = '凌晨' | '清晨' | '早上' | '上午' | '中午' | '下午' | '傍晚' | '晚上' | '深夜';
/**
 * 小时 → 时段。
 * @param hour - 小时数（来自 Date.getHours()，正常为 0–23）。
 * @returns 对应时段；越界或 NaN（异常输入）按「凌晨」兜底、绝不抛错——提示词路径不能因为时间格式问题失败。
 */
export declare function timeSlotOf(hour: number): TimeSlot;
/**
 * 星期几 → 工作日 / 周末（周六周日算周末；与余额低谷判定同一口径，见 balance/deepseek-common.ts）。
 * @param day - Date.getDay()（0 = 周日）。
 * @returns 「周末」（周六/周日）或「工作日」。
 */
export declare function dayKindOf(day: number): '工作日' | '周末';
/**
 * 生成注入 system 末尾的时间背景（一行）。
 * @param date - 当前时刻（生产调用方传 new Date()；测试传固定日期）。
 * @returns 形如
 *   `【当下】现在是2026年10月8日星期四 21:32，晚上，工作日，国庆节刚过完。这只是背景，不必刻意报时，也别句句都提节日。`
 *   无节日时中间那一段省略；非法 Date → 空串（调用方据此不加这一行）。
 */
export declare function timeContextOf(date: Date): string;
