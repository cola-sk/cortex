/**
 * 上报模块 — 支持多种策略上报错误数据
 * - beacon: navigator.sendBeacon（页面卸载时可靠上报）
 * - fetch: fetch API（支持自定义 header / body）
 * - image: new Image().src（兼容性好，仅 GET）
 */

/**
 * 使用 navigator.sendBeacon 上报
 * @param {string} url
 * @param {Object} data
 */
function reportByBeacon(url, data) {
  try {
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    navigator.sendBeacon(url, blob);
  } catch (e) {
    // beacon 失败时降级到 fetch
    reportByFetch(url, data);
  }
}

/**
 * 使用 fetch 上报
 * @param {string} url
 * @param {Object} data
 * @param {number} [timeout]
 */
function reportByFetch(url, data, timeout = 5000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      keepalive: true,
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
  } catch (e) {
    // fetch 静默失败，避免影响主业务
  }
}

/**
 * 使用 Image 对象上报（仅 GET）
 * @param {string} url
 * @param {Object} data
 */
function reportByImage(url, data) {
  try {
    const params = new URLSearchParams();
    params.set('data', JSON.stringify(data));
    const separator = url.includes('?') ? '&' : '?';
    const img = new Image();
    img.src = `${url}${separator}${params.toString()}`;
  } catch (e) {
    // 静默失败
  }
}

/**
 * 上报单条错误数据
 * @param {Object} options
 * @param {string} options.dsn         - 上报地址
 * @param {Object} options.errorInfo   - 错误数据
 * @param {string} [options.strategy]  - 上报策略
 */
export function report({ dsn, errorInfo, strategy = 'beacon' }) {
  if (!dsn) return;

  const strategies = {
    beacon: reportByBeacon,
    fetch: reportByFetch,
    image: reportByImage,
  };

  const fn = strategies[strategy] || strategies.beacon;
  fn(dsn, { errors: [errorInfo] });
}

/**
 * 批量上报错误数据
 * @param {Object} options
 * @param {string} options.dsn
 * @param {Array} options.errors       - 错误数组
 * @param {string} [options.strategy]
 */
export function batchReport({ dsn, errors, strategy = 'beacon' }) {
  if (!dsn || !errors || errors.length === 0) return;
  report({ dsn, errorInfo: null, strategy });

  // 批量上报：合并为单一请求
  if (strategy === 'beacon') {
    try {
      const blob = new Blob([JSON.stringify({ errors })], { type: 'application/json' });
      navigator.sendBeacon(dsn, blob);
    } catch {
      reportByFetch(dsn, { errors });
    }
  } else if (strategy === 'fetch') {
    reportByFetch(dsn, { errors });
  } else {
    reportByImage(dsn, { errors });
  }
}
