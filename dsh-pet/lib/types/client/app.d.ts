/** 创建 DSH 插件 factory，返回带 name / inject / apply 的模块。 */
export declare function makeFactory(): (require: (mod: string) => any) => any;
