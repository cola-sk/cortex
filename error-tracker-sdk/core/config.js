/**
 * SDK 默认配置项
 * 用户可通过 new ErrorTracker({ ...options }) 覆盖
 */
const defaultConfig = {
  /** 应用唯一标识 */
  appId: '',

  /** 上报地址（支持模板变量：{url}, {message} 等） */
  dsn: '',

  /** SDK 版本 */
  version: '1.0.0',

  /** 当前应用 release 版本号（用于关联 SourceMap） */
  release: '',

  /** 环境标识：development / staging / production */
  environment: 'production',

  /** 错误采样率 0~1，1 表示 100% 上报 */
  sampleRate: 1,

  /** 请求节流间隔（毫秒），同一错误在此间隔内只上报一次 */
  throttleInterval: 5000,

  /** 单次上报的最大错误条数（批处理） */
  batchSize: 10,

  /** 批处理最大等待时间（毫秒），达到此时间立即上报 */
  batchTimeout: 3000,

  /** 上报超时时间（毫秒） */
  requestTimeout: 5000,

  /** 是否忽略白屏检测 */
  ignoreWhiteScreen: false,

  /** 自定义字段（自动附加到每条错误数据） */
  extra: {},

  /** 忽略的错误消息关键词（正则数组） */
  ignorePatterns: [],

  /** 是否自动注入监听（false 时仅返回实例，不自动监听） */
  autoInstall: true,

  /** 上报方法：beacon / fetch / image */
  reportStrategy: 'beacon',
};

export default defaultConfig;
