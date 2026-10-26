/**
 * 共享层出口：浏览器半侧 bundle 与桌面 shared-core 共用同一份纯逻辑。
 * 不负责配置的读取、合并与校验：成品配置由宿主半侧的 readAllConfig 给出，本层只把它拍平。
 * 宿主半侧不得 import 本目录（DSH 单文件加载约束会拆 chunk），其实现自包含、改动须与本层同步。
 * menu / chat / score-popup / tooltip 导出 DOM 样式与挂载：数据与判据仍是纯函数，渲染两端共用同一份。
 * @module dsh-pet/src/shared/index
 */
export * from './types';
export * from './constants';
export * from './pickers';
export * from './displays';
export * from './motion';
export * from './balance';
export * from './whisper';
export * from './config';
export * from './fonts';
export * from './notify';
export * from './menu';
export * from './chat';
export * from './physics';
export * from './score';
export * from './score-popup';
export * from './work-status';
export * from './state';
export * from './tooltip';
