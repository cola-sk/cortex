/**
 * 错误信息收集器 — 将原始错误数据统一为标准格式
 */

import { generateErrorId, generateFingerprint } from '../utils/errorId.js';
import { parseStack, extractFirstStackFrame } from '../utils/stackParser.js';
import { collectContext } from './contextCollector.js';

/**
 * 错误类型枚举
 */
export const ErrorType = {
  GLOBAL: 'global',         // window.onerror 捕获的运行时错误
  UNHANDLED_REJECTION: 'unhandled_rejection', // 未捕获的 Promise rejection
  RESOURCE: 'resource',     // 静态资源加载错误
  CUSTOM: 'custom',         // 手动上报
};

/**
 * @typedef {Object} ErrorInfo
 * @property {string} id            - 错误唯一 ID
 * @property {string} fingerprint   - 错误指纹（相同错误聚合）
 * @property {string} type          - 错误类型
 * @property {string} message       - 错误消息
 * @property {string} stack         - 原始堆栈字符串
 * @property {Array}  frames        - 解析后的堆栈帧
 * @property {string} filename      - 出错文件名
 * @property {number} lineno        - 出错行号
 * @property {number} colno         - 出错列号
 * @property {Object} context       - 上下文信息
 * @property {Object} extra         - 自定义附加字段
 * @property {number} timestamp     - 错误发生时间戳
 */

/**
 * 统一收集错误信息为标准格式
 * @param {Object} options
 * @param {ErrorType} options.type    - 错误类型
 * @param {string} options.message    - 错误消息
 * @param {string} [options.stack]    - 原始堆栈
 * @param {string} [options.filename] - 文件名
 * @param {number} [options.lineno]   - 行号
 * @param {number} [options.colno]    - 列号
 * @param {Object} [options.extra]    - 自定义字段
 * @returns {ErrorInfo}
 */
export function collectError({ type, message, stack, filename, lineno, colno, extra }) {
  // 解析堆栈帧
  const frames = parseStack(stack);
  const firstFrame = extractFirstStackFrame(stack);

  // 如果没有显式传入位置信息，尝试从堆栈中提取
  if (!filename && firstFrame) {
    filename = firstFrame.file;
    lineno = firstFrame.line;
    colno = firstFrame.column;
  }

  // 生成错误指纹：基于消息 + 文件名 + 行号
  const fingerprint = generateFingerprint(message, filename, lineno);

  const context = collectContext();

  return {
    id: generateErrorId(),
    fingerprint,
    type,
    message,
    stack: stack || '',
    frames,
    filename: filename || '',
    lineno: lineno || 0,
    colno: colno || 0,
    context,
    extra: extra || {},
    timestamp: context.timestamp,
  };
}
