/**
 * React 集成 — 提供 ErrorBoundary 组件，捕获子组件树中的渲染错误
 *
 * 使用方式：
 *   import { ErrorBoundary } from './integrations/react.js';
 *   import tracker from './index.js';
 *
 *   function App() {
 *     return (
 *       <ErrorBoundary tracker={tracker}>
 *         <YourComponent />
 *       </ErrorBoundary>
 *     );
 *   }
 */

import React from 'react';
import { ErrorType } from '../collectors/errorCollector.js';

/**
 * React ErrorBoundary 组件
 * 捕获子组件树中的渲染错误、生命周期错误和构造函数错误
 *
 * @param {Object} props
 * @param {ErrorTracker} props.tracker - SDK 实例
 * @param {React.ReactNode} props.children - 子组件
 * @param {React.ReactNode} [props.fallback] - 错误时展示的降级 UI
 */
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    const { tracker, onCatch } = this.props;

    // 上报到 SDK
    if (tracker) {
      tracker.captureError(error, {
        reactComponentStack: errorInfo.componentStack,
        reactErrorBoundary: true,
      });
    }

    // 用户自定义回调
    if (typeof onCatch === 'function') {
      onCatch(error, errorInfo);
    }
  }

  render() {
    if (this.state.hasError) {
      // 优先使用用户自定义 fallback，否则使用默认 UI
      if (this.props.fallback) {
        return typeof this.props.fallback === 'function'
          ? this.props.fallback({ error: this.state.error })
          : this.props.fallback;
      }
      return (
        <div style={{
          padding: 16,
          backgroundColor: '#fff3f3',
          border: '1px solid #fcc',
          borderRadius: 4,
          color: '#c0392b',
          fontFamily: 'monospace',
          fontSize: 14,
        }}>
          <strong>Something went wrong.</strong>
          <details style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
            {this.state.error && this.state.error.toString()}
          </details>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * 全局 React 错误处理 — 通过 ReactDOM 的错误边界机制
 * 适用于 React 18+ createRoot
 *
 * @param {Object} root - ReactDOM.createRoot 返回的 root
 * @param {ErrorTracker} tracker - SDK 实例
 * @param {React.ReactNode} appElement - 应用根元素
 */
export function wrapWithErrorBoundary(root, tracker, appElement) {
  root.render(
    React.createElement(ErrorBoundary, { tracker }, appElement)
  );
}
