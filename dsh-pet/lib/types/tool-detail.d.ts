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
/**
 * `tool/call` 事件 → 气泡详情；跳过、无法解析、无信息量 → null。
 *
 * 返回值可以直接写进 `sections.workStatus.data.task`（长度 ≤ TASK_TEXT_MAX + 1）。
 */
export declare function toolDetailFromEvent(event: {
    data?: {
        name?: unknown;
        arguments?: unknown;
    };
} | null | undefined): string | null;
