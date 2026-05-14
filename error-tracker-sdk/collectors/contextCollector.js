/**
 * 上下文信息收集器 — 收集错误发生时的环境与设备信息
 */

/**
 * @typedef {Object} ContextInfo
 * @property {string} url        - 当前页面 URL
 * @property {string} userAgent  - 浏览器 UA
 * @property {string} language   - 浏览器语言
 * @property {number} screenWidth   - 屏幕宽度
 * @property {number} screenHeight  - 屏幕高度
 * @property {number} windowWidth   - 窗口宽度
 * @property {number} windowHeight  - 窗口高度
 * @property {string} referrer    - 来源页面
 * @property {number} timestamp   - 错误发生时间戳
 * @property {string} stacktrace  - 用户操作堆栈（可选）
 */

/**
 * 收集浏览器与环境上下文信息
 * @returns {ContextInfo}
 */
export function collectContext() {
  try {
    return {
      url: location.href,
      userAgent: navigator.userAgent,
      language: navigator.language,
      screenWidth: screen.width,
      screenHeight: screen.height,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      referrer: document.referrer,
      timestamp: Date.now(),
    };
  } catch {
    // 非浏览器环境兜底
    return {
      url: '',
      userAgent: '',
      language: '',
      screenWidth: 0,
      screenHeight: 0,
      windowWidth: 0,
      windowHeight: 0,
      referrer: '',
      timestamp: Date.now(),
    };
  }
}
