/**
 * 解析 error.stack 字符串，提取结构化调用栈
 * 支持 Chrome / Firefox / Safari 的堆栈格式
 */

// Chrome: at functionName (file:line:col)
const CHROME_RE = /^\s*at\s+([^\(]+)\s+\((.+?):(\d+):(\d+)\)$/;
// Firefox: functionName@file:line
const FF_RE = /^\s*(.*)@(.*):(\d+)$/;

/**
 * 单帧解析结果
 * @typedef {Object} StackFrame
 * @property {string} func   - 函数名
 * @property {string} file   - 文件路径
 * @property {number} line   - 行号
 * @property {number} column - 列号
 */

/**
 * 解析单行堆栈
 * @param {string} line
 * @returns {StackFrame | null}
 */
function parseLine(line) {
  // 尝试 Chrome 格式
  const chromeMatch = line.match(CHROME_RE);
  if (chromeMatch) {
    return {
      func: chromeMatch[1].trim(),
      file: chromeMatch[2],
      line: parseInt(chromeMatch[3], 10),
      column: parseInt(chromeMatch[4], 10),
    };
  }

  // 尝试 Firefox 格式
  const ffMatch = line.match(FF_RE);
  if (ffMatch) {
    return {
      func: ffMatch[1].trim(),
      file: ffMatch[2],
      line: parseInt(ffMatch[3], 10),
      column: 0,
    };
  }

  return null;
}

/**
 * 解析完整堆栈字符串
 * @param {string} stack - Error.stack 原始字符串
 * @returns {StackFrame[]}
 */
export function parseStack(stack) {
  if (!stack || typeof stack !== 'string') {
    return [];
  }

  const lines = stack.split('\n');
  const frames = [];

  // 第一行通常是 "ErrorType: message"，跳过
  for (let i = 1; i < lines.length; i++) {
    const frame = parseLine(lines[i]);
    if (frame) {
      frames.push(frame);
    }
  }

  return frames;
}

/**
 * 从原始堆栈中提取第一个有意义的源码位置
 * @param {string} stack
 * @returns {{file: string, line: number, column: number} | null}
 */
export function extractFirstStackFrame(stack) {
  const frames = parseStack(stack);
  // 过滤掉 SDK 自身文件和 VM/webpack 内部文件
  const filtered = frames.filter(
    (f) =>
      !f.file.includes('error-tracker-sdk') &&
      !f.file.startsWith('webpack://') &&
      f.file !== 'eval' &&
      f.file !== '<anonymous>' &&
      f.file !== '[native code]'
  );
  return filtered[0] || null;
}
