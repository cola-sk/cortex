/**
 * ErrorTracker 主类 — SDK 核心
 * 职责：配置管理、错误收集、节流去重、批处理上报
 */

import defaultConfig from './config.js';
import { createListeners } from './listener.js';
import { collectError, ErrorType } from '../collectors/errorCollector.js';
import { batchReport } from '../reporter/index.js';
import { keyedThrottle } from '../utils/throttle.js';

export class ErrorTracker {
  /**
   * @param {Object} options - 用户配置
   */
  constructor(options = {}) {
    // 合并配置
    this.config = { ...defaultConfig, ...options };
    this._buffer = [];           // 错误缓冲队列
    this._timer = null;          // 批处理定时器
    this._listener = null;       // 监听器句柄
    this._destroyed = false;
    this._extra = { ...this.config.extra }; // 全局自定义字段

    // 注册错误处理器（带 key 节流）
    const throttledHandler = keyedThrottle(
      this._onError.bind(this),
      this.config.throttleInterval
    );

    // 安装全局监听
    if (this.config.autoInstall) {
      this._listener = createListeners({
        onError: (raw) => throttledHandler(raw),
      });
    }
  }

  /**
   * 内部错误处理：过滤 → 采样 → 收集 → 缓冲上报
   * @param {Object} raw - 原始错误数据
   */
  _onError(raw) {
    if (this._destroyed) return;

    const { message, type } = raw;

    // 1. 检查忽略模式
    if (this._shouldIgnore(message)) {
      return;
    }

    // 2. 采样过滤
    if (Math.random() > this.config.sampleRate) {
      return;
    }

    // 3. 收集为标准格式
    const errorInfo = collectError({
      ...raw,
      extra: {
        appId: this.config.appId,
        version: this.config.version,
        release: this.config.release,
        environment: this.config.environment,
        ...this._extra,
        ...(raw.extra || {}),
      },
    });

    // 4. 加入缓冲队列
    this._buffer.push(errorInfo);

    // 5. 达到批次大小立即上报
    if (this._buffer.length >= this.config.batchSize) {
      this._flush();
      return;
    }

    // 6. 设置定时器延迟上报
    if (!this._timer) {
      this._timer = setTimeout(() => this._flush(), this.config.batchTimeout);
    }
  }

  /**
   * 检查是否应该忽略该错误
   * @param {string} message
   * @returns {boolean}
   */
  _shouldIgnore(message) {
    if (!this.config.ignorePatterns || this.config.ignorePatterns.length === 0) {
      return false;
    }
    return this.config.ignorePatterns.some((pattern) => {
      const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
      return re.test(message);
    });
  }

  /**
   * 上报缓冲队列中的所有错误
   */
  _flush() {
    if (this._buffer.length === 0) return;

    const errors = this._buffer.splice(0);
    batchReport({
      dsn: this.config.dsn,
      errors,
      strategy: this.config.reportStrategy,
    });

    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  // ======================== 公开 API ========================

  /**
   * 手动上报一个错误
   * @param {Error|string} error - Error 对象或错误消息字符串
   * @param {Object} [extra] - 自定义附加字段
   */
  captureError(error, extra) {
    if (this._destroyed) return;

    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    this._onError({
      type: ErrorType.CUSTOM,
      message,
      stack,
      extra,
    });
  }

  /**
   * 设置全局自定义字段（附加到每条错误数据）
   * @param {Object} extra
   */
  setExtra(extra) {
    Object.assign(this._extra, extra);
  }

  /**
   * 主动触发出清缓冲区
   */
  flush() {
    this._flush();
  }

  /**
   * 销毁实例：移除监听 + 上报剩余数据 + 清理定时器
   */
  destroy() {
    this._destroyed = true;
    this.flush();

    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }

    if (this._listener) {
      this._listener.dispose();
      this._listener = null;
    }
  }
}
