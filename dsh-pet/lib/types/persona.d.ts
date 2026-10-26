/**
 * 某宠物最终生效的人设正文（不含名字与时间）：实例 whisperPrompt → 条目 whisperPrompt → 空串。
 *
 * 语义是替换而不是拼接：两段人设同时生效会让模型收到两个身份。
 * 实例级的值合并器已过滤过，这里仍 trim 判空——petPersona 也是导出函数，不能假设调用方走了合并器。
 */
export declare function petPersona(conf: Record<string, unknown>, pet: Record<string, unknown>): string;
/** composeSystemPrompt 的入参 */
export interface SystemPromptParts {
    /** 已回落到生效值的人设正文（petPersona 的结果；空串 = 没有人设，只有名字 + 时间） */
    prompt: string;
    /** 显示名（pets[].name；缺失/空按 id 处理） */
    name: string;
    /** 宠物 id（name 为空时的兜底；两者都空 = 整段名字声明省略） */
    id: string;
    /** 生成这一刻（生产传 new Date()，测试传固定日期） */
    now: Date;
}
/**
 * 拼出最终 system 提示词：人设正文 + 名字声明 + 时间背景。
 *
 * 边界：prompt 为空时不留前导换行；name 与 id 都取不到时整段名字声明省略；
 * now 非法（NaN）时 timeContextOf 返回空串，时间背景整行不加（宁缺，也不把 NaN 拼进提示词）。
 */
export declare function composeSystemPrompt(parts: SystemPromptParts): string;
