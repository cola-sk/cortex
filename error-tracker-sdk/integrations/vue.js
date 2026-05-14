/**
 * Vue 集成 — 接管 Vue 应用的错误处理器
 *
 * 使用方式：
 *   import { installVueErrorHandler } from './integrations/vue.js';
 *
 *   const tracker = createInstance({ appId: 'my-app', dsn: '/api/errors' });
 *   installVueErrorHandler(app, tracker);
 *
 * 或者作为 Vue 插件：
 *   import { ErrorTrackerPlugin } from './integrations/vue.js';
 *   app.use(ErrorTrackerPlugin, tracker);
 */

import { ErrorType } from '../collectors/errorCollector.js';

/**
 * 安装 Vue 错误处理器
 * @param {import('vue').App} app - Vue 应用实例
 * @param {ErrorTracker} tracker - SDK 实例
 */
export function installVueErrorHandler(app, tracker) {
  app.config.errorHandler = (err, instance, info) => {
    tracker.captureError(err, {
      vueComponent: instance ? instance.$.type.__name || instance.$.type.name : 'unknown',
      vueInfo: info, // 如 "render", "setup", "v-on handler" 等
    });
  };
}

/**
 * 安装 Vue warn 处理器（可选）
 * @param {import('vue').App} app - Vue 应用实例
 * @param {ErrorTracker} tracker - SDK 实例
 */
export function installVueWarnHandler(app, tracker) {
  app.config.warnHandler = (msg, instance, trace) => {
    // warn 级别作为自定义事件上报
    tracker.captureError(
      new Error(`[Vue warn] ${msg}`),
      {
        vueComponent: instance ? instance.$.type.__name || instance.$.type.name : 'unknown',
        vueTrace: trace,
        level: 'warn',
      }
    );
  };
}

/**
 * Vue 插件形式 — app.use(ErrorTrackerPlugin, tracker)
 */
export const ErrorTrackerPlugin = {
  install(app, tracker) {
    if (!tracker) {
      console.warn('[ErrorTracker] Vue plugin: tracker instance is required');
      return;
    }
    installVueErrorHandler(app, tracker);
    installVueWarnHandler(app, tracker);
  },
};
