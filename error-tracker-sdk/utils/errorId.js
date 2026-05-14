/**
 * 生成错误的唯一标识（fingerprint）
 * 基于消息 + 文件名 + 行号生成 hash，用于错误去重和聚合
 */

/**
 * 简单的字符串 hash（djb2 算法）
 */
function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return hash.toString(36);
}

/**
 * 生成错误唯一 ID（全局唯一，用于上报日志追踪）
 */
export function generateErrorId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

/**
 * 生成错误指纹（相同错误的不同实例会返回相同指纹）
 */
export function generateFingerprint(message, filename, lineno) {
  const raw = `${message}|${filename || 'unknown'}|${lineno || 0}`;
  return hashString(raw);
}
