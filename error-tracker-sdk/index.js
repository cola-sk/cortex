/**
 * Error Tracker SDK 入口
 *
 * 使用方式：
 *   import { ErrorTracker, createInstance } from './index.js';
 *
 *   // 方式一：构造函数
 *   const tracker = new ErrorTracker({ appId: 'my-app', dsn: '/api/errors' });
 *
 *   // 方式二：工厂函数（推荐，支持单例）
 *   const tracker = createInstance({ appId: 'my-app', dsn: '/api/errors' });
 *
 *   // 手动上报
 *   tracker.captureError(new Error('Something went wrong'));
 *   tracker.captureError('Simple string error');
 *
 *   // 设置全局字段
 *   tracker.setExtra({ userId: '123', userName: 'Alice' });
 *
 *   // 销毁
 *   tracker.destroy();
 */

import { ErrorTracker } from './core/ErrorTracker.js';
import { ErrorType } from './collectors/errorCollector.js';
import defaultConfig from './core/config.js';

/**
 * 单例模式 — 确保全局只有一个实例
 * @param {Object} options
 * @returns {ErrorTracker}
 */
let singleton = null;

export function createInstance(options = {}) {
  if (!singleton) {
    singleton = new ErrorTracker(options);
  }
  return singleton;
}

export { ErrorTracker, ErrorType, defaultConfig };
export default createInstance;
