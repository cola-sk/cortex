/**
 * 节流工具 — 在指定时间间隔内，同一 key 只执行一次
 */

/**
 * 基础节流函数
 * @param {Function} fn - 需要节流的函数
 * @param {number} interval - 节流间隔（毫秒）
 * @returns {Function}
 */
export function throttle(fn, interval) {
  let lastTime = 0;
  let timer = null;

  return function (...args) {
    const now = Date.now();
    const remaining = interval - (now - lastTime);

    if (remaining <= 0) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      lastTime = now;
      fn.apply(this, args);
    } else if (!timer) {
      // 等待剩余时间后执行
      timer = setTimeout(() => {
        lastTime = Date.now();
        timer = null;
        fn.apply(this, args);
      }, remaining);
    }
  };
}

/**
 * 基于 key 的节流（不同 key 独立计时）
 * 适用于错误上报场景 — 每个错误指纹独立节流
 * @param {Function} fn - 回调函数
 * @param {number} interval - 节流间隔
 * @returns {Function} (key: string, ...args) => void
 */
export function keyedThrottle(fn, interval) {
  const timers = new Map();

  return function (key, ...args) {
    if (timers.has(key)) {
      return; // 仍在节流期内，跳过
    }

    fn(key, ...args);

    timers.set(key, setTimeout(() => {
      timers.delete(key);
    }, interval));
  };
}
