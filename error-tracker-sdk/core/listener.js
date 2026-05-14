/**
 * 事件监听管理 — 统一绑定 / 解绑全局错误监听
 * 支持 window.onerror、unhandledrejection、资源加载错误
 */

import { ErrorType } from '../collectors/errorCollector.js';

/**
 * 创建全局错误监听
 * @param {Object} options
 * @param {Function} options.onError - 回调，接收 { type, ...errorData }
 * @returns {Object} 包含 dispose 方法的对象
 */
export function createListeners({ onError }) {
  const handlers = [];

  // ========== 1. window.onerror — 运行时错误 ==========
  const originalOnError = window.onerror;
  const globalErrorHandler = function (message, source, lineno, colno, error) {
    // 如果原始 onerror 已处理（返回 true），则跳过
    if (originalOnError && originalOnError(message, source, lineno, colno, error)) {
      return true;
    }

    onError({
      type: ErrorType.GLOBAL,
      message: String(message),
      filename: source || '',
      lineno: lineno || 0,
      colno: colno || 0,
      stack: error ? error.stack : undefined,
    });
    return false;
  };
  window.onerror = globalErrorHandler;
  handlers.push(() => { window.onerror = originalOnError; });

  // ========== 2. unhandledrejection — 未捕获的 Promise 拒绝 ==========
  const rejectionHandler = (event) => {
    const reason = event.reason;
    onError({
      type: ErrorType.UNHANDLED_REJECTION,
      message: reason != null
        ? (reason.message || String(reason))
        : 'Unhandled promise rejection',
      stack: reason && reason.stack ? reason.stack : undefined,
    });
    // 阻止浏览器默认的错误打印（可选）
    // event.preventDefault();
  };
  window.addEventListener('unhandledrejection', rejectionHandler);
  handlers.push(() => {
    window.removeEventListener('unhandledrejection', rejectionHandler);
  });

  // ========== 3. 资源加载错误（捕获冒泡） ==========
  const resourceErrorHandler = (event) => {
    const target = event.target;
    // 仅关心特定资源类型
    if (target && target.tagName) {
      const tagName = target.tagName.toLowerCase();
      if (['script', 'link', 'img', 'iframe', 'source'].includes(tagName)) {
        onError({
          type: ErrorType.RESOURCE,
          message: `Resource loading failed: ${tagName}`,
          filename: target.src || target.href || '',
          lineno: 0,
          colno: 0,
          extra: { tagName, src: target.src || target.href },
        });
      }
    }
  };
  document.addEventListener('error', resourceErrorHandler, true); // 捕获阶段
  handlers.push(() => {
    document.removeEventListener('error', resourceErrorHandler, true);
  });

  /**
   * 移除所有监听
   */
  function dispose() {
    handlers.forEach((h) => h());
  }

  return { dispose };
}
