(() => {
  'use strict';

  // =====================================================================================
  // 0) 类型与错误 (Types & Errors) - 增强错误处理
  // =====================================================================================

  /** 表单校验错误 */
  class ValidationError extends Error {
    constructor(message, field) {
      super(message);
      this.name = 'ValidationError';
      this.field = field;
      this.timestamp = Date.now();
    }
  }

  /** 网络错误（包含状态码） */
  class NetworkError extends Error {
    constructor(message, statusCode, retryable = false) {
      super(message);
      this.name = 'NetworkError';
      this.statusCode = statusCode;
      this.retryable = retryable;
      this.timestamp = Date.now();
    }
  }

  /** 并发错误 */
  class ConcurrencyError extends Error {
    constructor(message, operation) {
      super(message);
      this.name = 'ConcurrencyError';
      this.operation = operation;
      this.timestamp = Date.now();
    }
  }

  // =====================================================================================
  // 1) 配置与常量 (Config) - 增加并发控制配置
  // =====================================================================================

  const NOTIFICATION_TYPES = Object.freeze({
    INFO:    { key: 'info',    level: 0 },
    SUCCESS: { key: 'success', level: 1 },
    WARNING: { key: 'warning', level: 2 },
    ERROR:   { key: 'error',   level: 3 },
  });

  const DURATIONS = Object.freeze({
    SHORT:  2000,
    MEDIUM: 3000,
    LONG:   5000,
  });

  const CSS_CLASSES = Object.freeze({
    TOAST: 'toast',
    INVALID_INPUT: 'invalid',
    COUNTDOWN_ITEM: 'countdown-item',
    LOADING: 'loading',
    LOCKED: 'locked',
  });

  const CONFIG = Object.freeze({
    TIME: Object.freeze({
      SECS_PER_MIN: 60,
      SECS_PER_HOUR: 3600,
      SECS_PER_DAY: 86400,
      COUNTDOWN_INTERVAL_MS: 1000,
    }),
    BUSINESS: Object.freeze({
      ACCEL_SECONDS_PER_BOOST: 7200,
      LEVEL_RANGE: Object.freeze({ MIN: 1, MAX: 500 }),
      LVL_UP_NUM: 1111,
      LVL_UP_PER: 0,
      LVL_UP_ADP: 15,
    }),
    PATTERNS: Object.freeze({
      REGEX_INT: /^\d+$/,
      CSV_INJECTION_PATTERNS: [
        /^[=+\-@]/,
        /javascript:/i,
        /data:/i,
        /<script/i,
        /on\w+\s*=/i,
      ],
    }),
    PATHS: Object.freeze({
      CSV_BASE: '/static/database/',
    }),
    API: Object.freeze({
      TIMEOUT: 8000,
      MAX_RETRIES: 3,
      RETRY_DELAY_BASE: 1000,
      CONCURRENT_LIMIT: 3,
      RATE_LIMIT_WINDOW: 60000,
      RATE_LIMIT_MAX: 30,
      ENDPOINTS: Object.freeze({
        SAVE_CSV: '/save-csv',
        VISIT_COUNT: '/visit-count',
        VISIT_COUNT_TODAY: '/visit-count-today',
        HISTORY: 'static/history.txt',
      }),
    }),
    UI: Object.freeze({
      MAX_TOASTS: 5,
      DEBOUNCE_DELAY: 300,
      THROTTLE_DELAY: 100,
    }),
    CONCURRENCY: Object.freeze({
      MAX_CONCURRENT_OPERATIONS: 2,
      OPERATION_TIMEOUT: 30000,
      LOCK_TIMEOUT: 10000,
      WORKER_POOL_SIZE: Math.max(2, Math.min(8, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 4)),
    }),
  });

  // =====================================================================================
  // 2) 工具函数 (Utilities) - 增强并发控制
  // =====================================================================================

  const $  = (sel, scope = document) => scope.querySelector(sel);
  const $$ = (sel, scope = document) => Array.from(scope.querySelectorAll(sel));

  /** 数值转换（失败时返回回退值） */
  const toNumber = (v, fallback = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  /**
   * 高级记忆化（双缓存：原始值 Map + 对象 WeakMap）
   * 增加TTL支持和缓存大小限制
   */
  const memoize = (fn, options = {}) => {
    const { keyGenerator, ttl = 0, maxSize = 1000 } = options;
    const pCache = new Map();
    const oCache = new WeakMap();
    const timestamps = ttl > 0 ? new Map() : null;

    const genKey = typeof keyGenerator === 'function'
      ? keyGenerator
      : (args) => (args.length === 1 ? args[0] : JSON.stringify(args));

    const cleanup = () => {
      if (!timestamps || pCache.size <= maxSize) return;
      const now = Date.now();
      const expired = [];
      for (const [key, time] of timestamps.entries()) {
        if (now - time > ttl) expired.push(key);
      }
      expired.forEach(key => {
        pCache.delete(key);
        timestamps.delete(key);
      });
    };

    return function memoized(...args) {
      const now = Date.now();

      // 对象参数使用 WeakMap
      if (args.length === 1 && args[0] && typeof args[0] === 'object') {
        const obj = args[0];
        const cached = oCache.get(obj);
        if (cached !== undefined) return cached;
        const val = fn.apply(this, args);
        oCache.set(obj, val);
        return val;
      }

      // 原始参数使用 Map
      const key = genKey(args);

      // 检查TTL
      if (timestamps && timestamps.has(key)) {
        if (now - timestamps.get(key) > ttl) {
          pCache.delete(key);
          timestamps.delete(key);
        }
      }

      const cached = pCache.get(key);
      if (cached !== undefined) return cached;

      const val = fn.apply(this, args);
      pCache.set(key, val);
      if (timestamps) timestamps.set(key, now);

      // 定期清理
      if (pCache.size > maxSize) cleanup();

      return val;
    };
  };

  /** 增强防抖（支持立即执行和最大等待时间） */
  const debounce = (fn, delay = CONFIG.UI.DEBOUNCE_DELAY, options = {}) => {
    const { immediate = false, maxWait = 0 } = options;
    let timeoutId = 0;
    let maxTimeoutId = 0;
    let lastCallTime = 0;

    return function debounced(...args) {
      const now = Date.now();
      const timeSinceLastCall = now - lastCallTime;
      lastCallTime = now;

      const callNow = immediate && !timeoutId;

      if (timeoutId) clearTimeout(timeoutId);
      if (maxTimeoutId) clearTimeout(maxTimeoutId);

      timeoutId = setTimeout(() => {
        timeoutId = 0;
        if (!immediate) fn.apply(this, args);
      }, delay);

      if (maxWait > 0 && timeSinceLastCall >= maxWait) {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = 0;
        fn.apply(this, args);
      } else if (maxWait > 0) {
        maxTimeoutId = setTimeout(() => {
          if (timeoutId) clearTimeout(timeoutId);
          timeoutId = 0;
          fn.apply(this, args);
        }, maxWait);
      }

      if (callNow) fn.apply(this, args);
    };
  };

  /** 节流函数 */
  const throttle = (fn, delay = CONFIG.UI.THROTTLE_DELAY) => {
    let lastCall = 0;
    let timeoutId = 0;

    return function throttled(...args) {
      const now = Date.now();
      const timeSinceLastCall = now - lastCall;
      if (timeSinceLastCall >= delay) {
        lastCall = now;
        fn.apply(this, args);
      } else if (!timeoutId) {
        timeoutId = setTimeout(() => {
          lastCall = Date.now();
          timeoutId = 0;
          fn.apply(this, args);
        }, delay - timeSinceLastCall);
      }
    };
  };

  /** 数值格式化 */
  const nf = new Intl.NumberFormat();
  const fmtNum = nf.format.bind(nf);

  /** 纯函数：时长格式化（中文单位） */
  const _fmtDur = (ms) => {
    const { SECS_PER_DAY, SECS_PER_HOUR, SECS_PER_MIN } = CONFIG.TIME;
    if (!Number.isFinite(ms) || ms <= 0) return '0秒';
    let sec = (ms / 1000) | 0;
    const d = (sec / SECS_PER_DAY)  | 0; sec -= d * SECS_PER_DAY;
    const h = (sec / SECS_PER_HOUR) | 0; sec -= h * SECS_PER_HOUR;
    const m = (sec / SECS_PER_MIN)  | 0; sec -= m * SECS_PER_MIN;
    return `${d}天 ${h}时 ${m}分 ${sec}秒`;
  };
  const fmtDur = memoize(_fmtDur, { ttl: 5000, maxSize: 500 });

  /** 安全 HTML 转义 */
  const sanitizeHTML = (() => {
    const map = {
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;', '/': '&#x2F;',
    };
    const re = /[&<>"'\/]/g;
    return (str = '') => String(str).replace(re, (s) => map[s]);
  })();
  const escapeHTML = sanitizeHTML;

  /** CSV 安全校验与净化 */
  const isCSVSafe = (value) => {
    const s = String(value).trim();
    for (let i = 0; i < CONFIG.PATTERNS.CSV_INJECTION_PATTERNS.length; i++) {
      if (CONFIG.PATTERNS.CSV_INJECTION_PATTERNS[i].test(s)) return false;
    }
    return true;
  };
  const sanitizeCsvCell = (s) => (isCSVSafe(s) ? s : `'${s}`);

  /** 业务类型校验 */
  const Type = {
    level: (v) => Number.isInteger(v) && v >= CONFIG.BUSINESS.LEVEL_RANGE.MIN && v <= CONFIG.BUSINESS.LEVEL_RANGE.MAX,
    exp:   (v) => Number.isFinite(v) && v >= 0,
    rate:  (v) => Number.isFinite(v) && v > 0,
  };

  /** clamp（溢出裁剪） */
  const clamp = (x, min, max) => (x < min ? min : (x > max ? max : x));

  /** 安全 DOM 操作 */
  const setText = (el, text) => { if (el) el.textContent = String(text); };
  const setHidden = (el, hidden = true) => { if (el) el.hidden = !!hidden; };
  const setDisabled = (el, disabled = true) => { if (el) el.disabled = !!disabled; };

  // =====================================================================================
  // 3) 并发控制系统 + 多线程 Worker 线程池
  // =====================================================================================

  /** 信号量实现 */
  class Semaphore {
    constructor(permits) {
      this.permits = permits;
      this.waiting = [];
    }
    async acquire() {
      return new Promise((resolve) => {
        if (this.permits > 0) {
          this.permits--;
          resolve();
        } else {
          this.waiting.push(resolve);
        }
      });
    }
    release() {
      this.permits++;
      if (this.waiting.length > 0) {
        const resolve = this.waiting.shift();
        this.permits--;
        resolve();
      }
    }
  }

  /** 分布式锁实现（基于内存） */
  class MemoryLock {
    constructor() {
      this.locks = new Map();
      this.waiting = new Map();
    }
    async acquire(key, timeout = CONFIG.CONCURRENCY.LOCK_TIMEOUT) {
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          const waiters = this.waiting.get(key) || [];
          const index = waiters.findIndex(w => w.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(new ConcurrencyError(`锁获取超时: ${key}`, 'acquire'));
        }, timeout);

        if (!this.locks.has(key)) {
          this.locks.set(key, Date.now());
          clearTimeout(timeoutId);
          resolve(() => this.release(key));
          return;
        }

        if (!this.waiting.has(key)) this.waiting.set(key, []);
        this.waiting.get(key).push({ resolve, timeoutId });
      });
    }
    release(key) {
      if (!this.locks.has(key)) return;
      this.locks.delete(key);
      const waiters = this.waiting.get(key) || [];
      if (waiters.length > 0) {
        const { resolve, timeoutId } = waiters.shift();
        clearTimeout(timeoutId);
        this.locks.set(key, Date.now());
        resolve(() => this.release(key));
      }
      if (waiters.length === 0) this.waiting.delete(key);
    }
    isLocked(key) { return this.locks.has(key); }
  }

  /** 速率限制器 */
  class RateLimiter {
    constructor(maxRequests = CONFIG.API.RATE_LIMIT_MAX, windowMs = CONFIG.API.RATE_LIMIT_WINDOW) {
      this.maxRequests = maxRequests;
      this.windowMs = windowMs;
      this.requests = new Map();
    }
    canMakeRequest(key = 'default') {
      const now = Date.now();
      const requests = this.requests.get(key) || [];
      const validRequests = requests.filter(time => now - time < this.windowMs);
      if (validRequests.length >= this.maxRequests) return false;
      validRequests.push(now);
      this.requests.set(key, validRequests);
      return true;
    }
    getWaitTime(key = 'default') {
      const requests = this.requests.get(key) || [];
      if (requests.length === 0) return 0;
      const oldestRequest = Math.min(...requests);
      const waitTime = this.windowMs - (Date.now() - oldestRequest);
      return Math.max(0, waitTime);
    }
  }

  // ---------- Worker 线程池 ----------
  class WorkerPool {
    constructor(size) {
      this.size = size;
      this.idSeq = 1;
      this.queue = [];
      this.workers = [];
      this.busy = new Set();
      this.callbacks = new Map();
      this._init();
    }

    _createWorkerURL() {
      const workerCode = `
        self.onmessage = (e) => {
          const { id, cmd, payload } = e.data || {};
          try {
            if (cmd === 'computePrefixSum') {
              // payload: entries: Array<[lv:number, exp:number]>
              const entries = (payload && payload.entries) || [];
              if (!Array.isArray(entries)) throw new Error('Invalid entries');

              // 计算最大等级
              let maxLv = 0;
              for (let i = 0; i < entries.length; i++) {
                const lv = entries[i][0] | 0;
                if (lv > maxLv) maxLv = lv;
              }

              // 构造 expByLevel：expByLevel[i] = 升级到 i+1 所需经验（即 Map.get(i)）
              const expByLevel = new Array(maxLv).fill(0);
              for (let i = 0; i < entries.length; i++) {
                const lv = entries[i][0] | 0;
                const exp = Number(entries[i][1]) || 0;
                if (lv >= 0 && lv < maxLv + 1) {
                  // 存放在 lv 位置意味着：从 lv 到 lv+1 的经验消耗
                  expByLevel[lv] = exp;
                }
              }

              // 计算前缀和 p，长度 maxLv+1，p[0]=0, p[i] = 前 i 级总和
              const p = new Array(maxLv + 1);
              p[0] = 0;
              for (let i = 1; i <= maxLv; i++) {
                p[i] = p[i - 1] + (expByLevel[i - 1] || 0);
              }

              postMessage({ id, ok: true, result: p });
              return;
            }
            throw new Error('Unknown command: ' + cmd);
          } catch (err) {
            postMessage({ id, ok: false, error: (err && err.message) || String(err) });
          }
        };
      `;
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      return URL.createObjectURL(blob);
    }

    _init() {
      const url = this._createWorkerURL();
      for (let i = 0; i < this.size; i++) {
        const w = new Worker(url);
        w.onmessage = (e) => {
          const { id, ok, result, error } = e.data || {};
          const cb = this.callbacks.get(id);
          if (!cb) return;
          this.callbacks.delete(id);
          this.busy.delete(w);
          // 尝试取队列下一个任务
          this._dequeue();
          if (ok) cb.resolve(result);
          else cb.reject(new Error(error || 'Worker error'));
        };
        w.onerror = (err) => {
          // 将当前 worker 标记闲置并继续队列
          this.busy.delete(w);
          this._dequeue();
          console.error('Worker error:', err);
        };
        this.workers.push(w);
      }
    }

    _dequeue() {
      if (this.queue.length === 0) return;
      const idle = this.workers.find(w => !this.busy.has(w));
      if (!idle) return;

      const task = this.queue.shift();
      if (!task) return;
      this.busy.add(idle);
      idle.postMessage(task.msg);
    }

    run(cmd, payload) {
      return new Promise((resolve, reject) => {
        const id = this.idSeq++;
        const msg = { id, cmd, payload };
        this.callbacks.set(id, { resolve, reject });
        this.queue.push({ msg });
        this._dequeue();
      });
    }

    destroy() {
      this.callbacks.clear();
      this.queue.length = 0;
      for (const w of this.workers) {
        try { w.terminate(); } catch {}
      }
      this.workers.length = 0;
      this.busy.clear();
    }
  }

  // 全局并发控制实例
  const concurrencyManager = {
    semaphore: new Semaphore(CONFIG.CONCURRENCY.MAX_CONCURRENT_OPERATIONS),
    lock: new MemoryLock(),
    rateLimiter: new RateLimiter(),
    workerPool: null,

    initWorkers() {
      if (typeof Worker === 'undefined') return;
      if (!this.workerPool) {
        this.workerPool = new WorkerPool(CONFIG.CONCURRENCY.WORKER_POOL_SIZE);
      }
    },
    destroyWorkers() {
      if (this.workerPool) {
        this.workerPool.destroy();
        this.workerPool = null;
      }
    },

    async withLock(key, operation, timeout = CONFIG.CONCURRENCY.OPERATION_TIMEOUT) {
      const release = await this.lock.acquire(key, timeout);
      try {
        return await operation();
      } finally {
        release();
      }
    },

    async withSemaphore(operation) {
      await this.semaphore.acquire();
      try {
        return await operation();
      } finally {
        this.semaphore.release();
      }
    },

    async withRateLimit(operation, key = 'default') {
      if (!this.rateLimiter.canMakeRequest(key)) {
        const waitTime = this.rateLimiter.getWaitTime(key);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return this.withRateLimit(operation, key);
      }
      return operation();
    }
  };

  /** 带超时、重试和并发控制的 fetch */
  const createFetchWithRetry = (maxRetries = CONFIG.API.MAX_RETRIES, timeout = CONFIG.API.TIMEOUT) => {
    return async (url, options = {}) => {
      return concurrencyManager.withSemaphore(async () => {
        return concurrencyManager.withRateLimit(async () => {
          let lastErr;
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), timeout);
            try {
              const res = await fetch(url, { ...options, signal: controller.signal });
              clearTimeout(id);
              if (!res.ok) {
                const retryable = res.status >= 500 || res.status === 429;
                throw new NetworkError(`HTTP ${res.status}`, res.status, retryable);
              }
              return res;
            } catch (e) {
              clearTimeout(id);
              lastErr = e;
              const isRetryable = e instanceof NetworkError ? e.retryable :
                                  e && (e.name === 'AbortError' || e.name === 'TypeError');
              if (attempt === maxRetries || !isRetryable) throw e;
              // 指数退避
              const baseDelay = CONFIG.API.RETRY_DELAY_BASE;
              const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000;
              await new Promise(r => setTimeout(r, delay));
            }
          }
          throw lastErr;
        }, url);
      });
    };
  };

  const fetchWithRetry = createFetchWithRetry();
  const fetchText = async (url, opts) => {
    const res = await fetchWithRetry(url, opts);
    return res.text();
  };

  // =====================================================================================
  // 4) 错误处理中心 - 增强版
  // =====================================================================================

  const ErrorHandler = {
    errorLog: new Map(), // 错误统计

    categorize(error) {
      if (error instanceof ValidationError) return 'validation';
      if (error instanceof NetworkError) return 'network';
      if (error instanceof ConcurrencyError) return 'concurrency';
      if (error && error.name === 'AbortError') return 'timeout';
      return 'unknown';
    },

    async retryWithBackoff(operation, max = 2, base = 400) {
      let last;
      for (let i = 0; i <= max; i++) {
        try {
          return await operation();
        } catch (e) {
          last = e;
          if (i === max || !this.shouldRetry(e)) break;
          const jitter = Math.random() * 0.1 * base;
          const ms = base * Math.pow(2, i) + jitter;
          await new Promise(r => setTimeout(r, ms));
        }
      }
      throw last;
    },

    shouldRetry(error) {
      const category = this.categorize(error);
      return category === 'network' || category === 'timeout';
    },

    log(error, context) {
      const key = `${context}-${this.categorize(error)}`;
      const count = this.errorLog.get(key) || 0;
      this.errorLog.set(key, count + 1);
      console.error(`[${context}] (${count + 1}次)`, error?.message || error, {
        error,
        timestamp: new Date().toISOString(),
        stack: error?.stack
      });
    },

    notify(error, context) {
      const kind = this.categorize(error);
      const msg = error?.message || String(error);
      const type = {
        validation: NOTIFICATION_TYPES.WARNING,
        network: NOTIFICATION_TYPES.ERROR,
        timeout: NOTIFICATION_TYPES.WARNING,
        concurrency: NOTIFICATION_TYPES.WARNING,
        unknown: NOTIFICATION_TYPES.ERROR,
      }[kind];
      notify(`${context}失败: ${msg}`, type);
    },

    async handle(operation, context, retryable = false) {
      try {
        return retryable ?
          await this.retryWithBackoff(operation) :
          await operation();
      } catch (e) {
        this.log(e, context);
        this.notify(e, context);
        throw e;
      }
    },

    getErrorStats() {
      return Object.fromEntries(this.errorLog);
    }
  };

  const withError = (fn, ctx, retryable = false) => async (...args) => {
    return ErrorHandler.handle(() => fn(...args), ctx, retryable);
  };

  // =====================================================================================
  // 5) 轻量 Store 与纯逻辑 (Store & Logic) - 线程安全版
  // =====================================================================================

  const maxKeyOfMap = (m) => {
    let max = 0;
    for (const k of m.keys()) if (k > max) max = k;
    return max;
  };

  const computePrefixSumSync = (expMap) => {
    const maxLv = maxKeyOfMap(expMap);
    const p = new Array(maxLv + 1);
    p[0] = 0;
    for (let i = 1; i <= maxLv; i++) p[i] = p[i - 1] + (expMap.get(i - 1) ?? 0);
    return p;
  };

  /** 线程安全的响应式存储 */
  const createStore = (initial) => {
    const subs = new Set();
    let updating = false;

    const data = new Proxy(initial, {
      set(obj, key, val) {
        if (obj[key] === val) return true;
        if (updating) return true; // 防止更新期间的递归调用
        updating = true;
        try {
          obj[key] = val;
          Promise.resolve().then(() => {
            subs.forEach((fn) => {
              try { fn(key, val); } catch (e) {
                console.warn('Store subscription error:', e);
              }
            });
          });
        } finally {
          updating = false;
        }
        return true;
      },
    });

    return {
      data,
      subscribe: (fn) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
      getSubscriberCount: () => subs.size
    };
  };

  const store = createStore({
    expMap: new Map(),
    prefixSum: [],
    finishAt: 0,
    accelFinishAt: 0,
    isLoading: false,
    lastUpdate: 0,
  });

  const getMaxLevel = () => maxKeyOfMap(store.data.expMap);
  const remainingExp = (curLv, curExp, tgtLv) => store.data.prefixSum[tgtLv] - store.data.prefixSum[curLv] - curExp;
  const secondsNeed = (remain, eph) => remain / (eph / CONFIG.TIME.SECS_PER_HOUR);

  // =====================================================================================
  // 6) DOM：Toast/缓存/触摸 - 优化版
  // =====================================================================================

  const runtime = {
    toastHost: null,
    rafId: 0,
    lastTickSec: -1,
    extIntervalId: 0,
    elementData: new WeakMap(),
    observers: new Map(),
    touchHandlers: new WeakMap(),
  };

  const toTypeKey = (t) => (typeof t === 'string' ? t : (t && t.key) || 'info');

  /** 增强 Toast 通知（支持去重和批量处理） */
  const notify = (() => {
    const recentToasts = new Map();
    const DEDUP_WINDOW = 3000;

    return (msg, type = NOTIFICATION_TYPES.INFO, duration = DURATIONS.MEDIUM) => {
      const key = toTypeKey(type);
      const now = Date.now();
      const dedupKey = `${key}-${msg}`;
      if (recentToasts.has(dedupKey)) {
        const lastTime = recentToasts.get(dedupKey);
        if (now - lastTime < DEDUP_WINDOW) return;
      }
      recentToasts.set(dedupKey, now);
      for (const [k, time] of recentToasts.entries()) {
        if (now - time > DEDUP_WINDOW) recentToasts.delete(k);
      }
      if (!runtime.toastHost) {
        const host = document.createElement('div');
        host.id = 'toastHost';
        host.setAttribute('aria-live', 'polite');
        host.setAttribute('role', 'status');
        document.body.appendChild(host);
        runtime.toastHost = host;
      }
      const host = runtime.toastHost;
      while (host.children.length >= CONFIG.UI.MAX_TOASTS) {
        host.firstElementChild?.remove();
      }
      const div = document.createElement('div');
      div.textContent = msg;
      div.className = `${CSS_CLASSES.TOAST} ${CSS_CLASSES.TOAST}-${key}`;
      host.appendChild(div);
      setTimeout(() => div.remove(), duration);
    };
  })();

  /** 优化的 DOM 缓存 */
  const dom = {};
  const initDomCache = () => {
    const selectors = {
      form: '#expForm',
      csvSel: '#csvVersion',
      curLv: '#currentLevel',
      curExp: '#currentExp',
      targetLv: '#targetLevel',
      eph: '#expPerHour',
      dailyBoosts: '#dailyBoosts',
      stoneBoosts: '#stoneBoosts',
      calcBtn: '#calcBtn',
      editBtn: '#editBtn',
      results: '#results',
      remaining: '#remainingExp',
      needSecs: '#neededSeconds',
      now: '#nowTime',
      finish: '#finishTime',
      accTime: '#acceleratedTime',
      cd: '#countdown',
      accCd: '#acceleratedCountdown',
      overlay: '#overlay',
      csvTable: '#csvTable',
      cancelBtn: '#cancelBtn',
      addRowBtn: '#addRowBtn',
      saveCsvBtn: '#saveCsvBtn',
      counter: '#counter',
      todayCounter: '#todayCounter',
      extCd: '#externalCountdown',
      history: '#historyContent',
    };
    Object.entries(selectors).forEach(([key, selector]) => {
      dom[key] = $(selector);
      if (!dom[key]) console.warn(`Element not found: ${selector}`);
    });
  };

  /** 触摸设备检测和处理 */
  const TouchHandler = {
    isTouch: () => (('ontouchstart' in window) || (navigator.maxTouchPoints > 0)),
    init() {
      if (this.isTouch()) {
        document.documentElement.classList.add('is-touch');
        this.setupTouchEvents();
      }
    },
    setupTouchEvents() {
      document.addEventListener('touchstart', (e) => {
        if (e.touches.length > 1) e.preventDefault();
      }, { passive: false });
      document.addEventListener('touchstart', (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.classList.contains('btn')) {
          e.target.classList.add('touch-active');
        }
      }, { passive: true });
      document.addEventListener('touchend', (e) => {
        if (e.target.classList && e.target.classList.contains('touch-active')) {
          setTimeout(() => e.target.classList.remove('touch-active'), 150);
        }
      }, { passive: true });
    }
  };

  // =====================================================================================
  // 7) 倒计时渲染（仅秒变更时更新） - 性能优化版
  // =====================================================================================

  const CountdownRenderer = {
    isActive: false,
    lastRenderTime: 0,
    RENDER_INTERVAL: 1000,

    render(now = Date.now()) {
      if (now - this.lastRenderTime < this.RENDER_INTERVAL) return;
      this.lastRenderTime = now;
      const remain = store.data.finishAt - now;
      const accRem = store.data.accelFinishAt - now;
      setText(dom.cd, remain <= 0 ? '倒计时: 已完成!' : `倒计时: ${fmtDur(remain)}`);
      setText(dom.accCd, accRem <= 0 ? '加速倒计时: 已完成!' : `加速倒计时: ${fmtDur(accRem)}`);
    },

    stop() {
      if (runtime.rafId) {
        cancelAnimationFrame(runtime.rafId);
        runtime.rafId = 0;
      }
      runtime.lastTickSec = -1;
      this.isActive = false;
    },

    start() {
      if (this.isActive) return;
      this.stop();
      this.isActive = true;
      const loop = () => {
        if (!this.isActive) return;
        const now = Date.now();
        const sec = (now / 1000) | 0;
        if (sec !== runtime.lastTickSec) {
          this.render(now);
          runtime.lastTickSec = sec;
        }
        if (store.data.finishAt - now <= 0 && store.data.accelFinishAt - now <= 0) {
          this.isActive = false;
          return;
        }
        runtime.rafId = requestAnimationFrame(loop);
      };
      loop();
    }
  };

  // =====================================================================================
  // 8) CSV I/O 与校验 - 增强版
  // =====================================================================================

  const CSVManager = {
    cache: new Map(),
    CACHE_TTL: 300000, // 5分钟缓存

    getPath: () => `${CONFIG.PATHS.CSV_BASE}${dom.csvSel?.value}.csv`,

    parse(txt) {
      const map = new Map();
      const content = String(txt ?? '').replace(/^\uFEFF/, '').trim();
      if (!content) return map;

      const lines = content.split(/\r?\n/);
      let i = 0;
      const errors = [];

      while (i < lines.length) {
        const l = lines[i].trim();
        if (!l || l.startsWith('#')) { i++; continue; }
        break;
      }

      if (i < lines.length) {
        const firstLine = lines[i].toLowerCase();
        if (firstLine.includes('level') || firstLine.includes('exp') || firstLine.includes('等级')) {
          i++;
        }
      }

      for (; i < lines.length; i++) {
        const raw = lines[i].trim();
        if (!raw || raw.startsWith('#')) continue;
        try {
          const parts = raw.split(',').map(s => s.trim());
          if (parts.length < 2) continue;
          const lv = Number(parts[0]);
          const exp = Number(parts[1]);
          if (Number.isFinite(lv) && Number.isFinite(exp)) {
            map.set(lv, exp);
          } else {
            errors.push(`第${i + 1}行: 数据格式错误`);
          }
        } catch (e) {
          errors.push(`第${i + 1}行: 解析失败 - ${e.message}`);
        }
      }

      if (errors.length > 0 && errors.length < 10) {
        console.warn('CSV解析警告:', errors);
      }
      return map;
    },

    validate(map) {
      if (!(map instanceof Map)) throw new ValidationError('CSV 数据格式不正确');
      let rows = 0;
      let lastLv = -Infinity;
      const issues = [];
      const entries = [...map.entries()].sort((a, b) => a[0] - b[0]);
      for (const [lv, exp] of entries) {
        rows++;
        if (!Type.level(lv)) {
          issues.push(`等级越界: ${lv}`);
          continue;
        }
        if (!Type.exp(exp)) {
          issues.push(`经验非法: ${exp}`);
          continue;
        }
        if (lv <= lastLv) {
          issues.push(`等级${lv}不是严格递增`);
        }
        lastLv = lv;
      }
      if (rows === 0) throw new ValidationError('CSV 为空');
      if (issues.length > rows * 0.1) {
        throw new ValidationError(`数据质量问题过多: ${issues.slice(0, 5).join(', ')}${issues.length > 5 ? '...' : ''}`);
      }
      if (issues.length > 0) console.warn('CSV数据警告:', issues);
      return true;
    },

    stringify(map) {
      const entries = [...map.entries()]
        .sort((a, b) => a[0] - b[0])
        .filter(([lv, exp]) => Type.level(lv) && Type.exp(exp));
      const rows = entries.map(([lv, exp]) =>
        `${sanitizeCsvCell(String(lv))},${sanitizeCsvCell(String(exp))}`
      );
      return ['level,exp', ...rows].join('\n');
    },

    async load(url) {
      const cacheKey = url;
      const now = Date.now();

      if (this.cache.has(cacheKey)) {
        const { data, timestamp } = this.cache.get(cacheKey);
        if (now - timestamp < this.CACHE_TTL) {
          await replaceExpMap(new Map(data));
          return;
        }
      }

      const raw = await fetchText(url);
      const parsed = this.parse(raw);
      this.validate(parsed);

      this.cache.set(cacheKey, {
        data: [...parsed.entries()],
        timestamp: now
      });

      await replaceExpMap(parsed);
    },

    async save() {
      const lockKey = 'csv-save';
      return concurrencyManager.withLock(lockKey, async () => {
        const table = dom.csvTable;
        const tbody = table ? $('tbody', table) : null;
        const rows = tbody ? $$('tr', tbody) : []; // 修复：获取全部行

        const newMap = new Map();
        const errors = [];

        for (let i = 0; i < rows.length; i++) {
          try {
            const cells = rows[i].children;
            if (!cells || cells.length < 2) {
              errors.push(`第 ${i + 1} 行结构非法`);
              continue;
            }
            const lvStr = (cells[0].textContent || '').trim();
            const expStr = (cells[1].textContent || '').trim();

            if (!CONFIG.PATTERNS.REGEX_INT.test(expStr)) {
              errors.push(`第 ${i + 1} 行经验必须为非负整数`);
              continue;
            }
            if (!isCSVSafe(expStr)) {
              errors.push(`第 ${i + 1} 行疑似公式注入，已阻止保存`);
              return;
            }
            const lv = Number(lvStr);
            const exp = Number(expStr);
            if (!Type.level(lv) || !Type.exp(exp)) {
              errors.push(`第 ${i + 1} 行数据非法`);
              continue;
            }
            newMap.set(lv, exp);
          } catch (e) {
            errors.push(`第 ${i + 1} 行处理失败: ${e.message}`);
          }
        }

        if (errors.length > 0) {
          notify(`数据验证失败: ${errors[0]}`, NOTIFICATION_TYPES.ERROR);
          return;
        }

        try {
          this.validate(newMap);
        } catch (e) {
          notify(e.message, NOTIFICATION_TYPES.ERROR);
          return;
        }

        await replaceExpMap(newMap);
        setHidden(dom.overlay, true);

        const body = this.stringify(store.data.expMap);
        const filename = encodeURIComponent(`${dom.csvSel?.value}.csv`);

        await fetchWithRetry(`${CONFIG.API.ENDPOINTS.SAVE_CSV}?file=${filename}`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/csv; charset=utf-8' },
          body,
        });

        this.cache.clear();
        notify('保存成功', NOTIFICATION_TYPES.SUCCESS);
      });
    },

    clearCache() {
      this.cache.clear();
    }
  };

  // =====================================================================================
  // 9) 业务逻辑与渲染 - 优化版
  // =====================================================================================

  const BusinessLogic = {
    renderResult: debounce(function(remain, secs) {
      if (!dom.results) return;
      setHidden(dom.results, false);

      const now = Date.now();
      store.data.finishAt = now + secs * 1000;

      const boosts = toNumber(dom.dailyBoosts?.value) + toNumber(dom.stoneBoosts?.value);
      const accel = boosts * CONFIG.BUSINESS.ACCEL_SECONDS_PER_BOOST;
      store.data.accelFinishAt = store.data.finishAt - accel * 1000;

      const updates = [
        [dom.remaining, `剩余经验值: ${fmtNum(remain)}`],
        [dom.needSecs, `预计耗时: ${fmtDur(secs * 1000)}`],
        [dom.now, `现在时间: ${new Date(now).toLocaleString()}`],
        [dom.finish, `完成时间: ${new Date(store.data.finishAt).toLocaleString()}`],
        [dom.accTime, `加速完成: ${new Date(store.data.accelFinishAt).toLocaleString()}`],
      ];
      updates.forEach(([el, text]) => setText(el, text));

      CountdownRenderer.start();
    }, 100),

    validateForm() {
      const values = {
        curLv: toNumber(dom.curLv?.value),
        curExp: toNumber(dom.curExp?.value),
        tgtLv: toNumber(dom.targetLv?.value),
        eph: toNumber(dom.eph?.value),
      };

      const { MIN, MAX } = CONFIG.BUSINESS.LEVEL_RANGE;
      const errors = [];

      if (!Type.level(values.curLv)) {
        errors.push({ field: 'curLv', message: `当前等级必须在 ${MIN}-${MAX}` });
      }
      if (!Type.level(values.tgtLv)) {
        errors.push({ field: 'tgtLv', message: `目标等级必须在 ${MIN}-${MAX}` });
      }
      if (!Type.exp(values.curExp)) {
        errors.push({ field: 'curExp', message: '当前经验必须为非负数' });
      }
      if (!Type.rate(values.eph)) {
        errors.push({ field: 'eph', message: '每小时经验必须为正数' });
      }
      if (values.tgtLv <= values.curLv) {
        errors.push({ field: 'tgtLv', message: '目标等级必须高于当前等级' });
      }

      if (errors.length === 0) {
        if (!store.data.expMap.has(values.tgtLv - 1)) {
          errors.push({ field: 'tgtLv', message: '目标等级超出数据范围' });
        }
        for (let lv = values.curLv; lv < values.tgtLv; lv++) {
          if (!store.data.expMap.has(lv)) {
            errors.push({ field: 'tgtLv', message: `等级 ${lv} 经验缺失` });
            break;
          }
        }
      }
      return { values, errors };
    },

    async onSubmit(e) {
      e.preventDefault();

      if (store.data.isLoading) {
        notify('数据加载中，请稍候...', NOTIFICATION_TYPES.INFO);
        return;
      }

      const { values, errors } = this.validateForm();

      if (errors.length > 0) {
        const firstError = errors[0];
        notify(firstError.message, NOTIFICATION_TYPES.ERROR);
        const errorField = dom[firstError.field];
        if (errorField && typeof errorField.focus === 'function') {
          errorField.focus();
        }
        return;
      }

      const { curLv, curExp, tgtLv, eph } = values;
      const remain = remainingExp(curLv, curExp, tgtLv);

      if (remain <= 0) {
        notify('已达到目标等级或经验', NOTIFICATION_TYPES.INFO);
        return;
      }

      const secs = secondsNeed(remain, eph);
      this.renderResult(remain, secs);
    }
  };

  // =====================================================================================
  // 10) CSV 可编辑表（批量构建 + 实时校验 + 防抖） - 增强版
  // =====================================================================================

  const TableEditor = {
    validationCache: new WeakMap(),

    build() {
      if (!dom.csvTable) return;
      const thead = this.createHeader();
      const tbody = this.createBody();
      dom.csvTable.replaceChildren(thead, tbody);
      this.attachEventListeners(tbody);
    },

    createHeader() {
      const thead = document.createElement('thead');
      const tr = document.createElement('tr');
      ['等级', '经验'].forEach(text => {
        const th = document.createElement('th');
        th.textContent = text;
        tr.appendChild(th);
      });
      thead.appendChild(tr);
      return thead;
    },

    createBody() {
      const tbody = document.createElement('tbody');
      const fragment = document.createDocumentFragment();
      const entries = [...store.data.expMap.entries()].sort((a, b) => a[0] - b[0]);
      entries.forEach(([lv, exp]) => {
        const tr = this.createRow(lv, exp);
        fragment.appendChild(tr);
      });
      tbody.appendChild(fragment);
      return tbody;
    },

    createRow(lv, exp) {
      const tr = document.createElement('tr');
      const tdLv = document.createElement('td');
      tdLv.textContent = String(lv);
      const tdExp = document.createElement('td');
      tdExp.setAttribute('contenteditable', 'true');
      tdExp.textContent = String(exp);
      this.validationCache.set(tdExp, { valid: true, lastValue: String(exp) });
      tr.append(tdLv, tdExp);
      return tr;
    },

    validateCell: throttle(function(target) {
      if (!(target instanceof HTMLElement) || target.cellIndex !== 1) return;
      const currentValue = (target.textContent || '').trim();
      const cache = this.validationCache.get(target);
      if (cache && cache.lastValue === currentValue) return;

      const isValid = CONFIG.PATTERNS.REGEX_INT.test(currentValue) &&
                      isCSVSafe(currentValue) &&
                      Type.exp(Number(currentValue));

      target.classList.toggle(CSS_CLASSES.INVALID_INPUT, !isValid);
      this.validationCache.set(target, {
        valid: isValid,
        lastValue: currentValue,
        timestamp: Date.now()
      });

      if (!isValid) {
        target.style.backgroundColor = '#ffebee';
        target.setAttribute('title', '请输入有效的数值');
      } else {
        target.style.backgroundColor = '';
        target.removeAttribute('title');
      }
    }, CONFIG.UI.THROTTLE_DELAY),

    attachEventListeners(tbody) {
      EventManager.removeAll(tbody);
      EventManager.add(tbody, 'input', (e) => { this.validateCell(e.target); });
      EventManager.add(tbody, 'paste', (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text');
        const cleaned = text.replace(/[^\d]/g, '');
        if (cleaned && CONFIG.PATTERNS.REGEX_INT.test(cleaned)) {
          document.execCommand('insertText', false, cleaned);
        }
      });
      EventManager.add(tbody, 'keydown', (e) => {
        if (e.target.getAttribute('contenteditable') === 'true') {
          this.handleKeyboardNavigation(e);
        }
      });
    },

    handleKeyboardNavigation(e) {
      const cell = e.target;
      const row = cell.parentNode;
      const tbody = row.parentNode;

      let targetCell = null;
      switch (e.key) {
        case 'ArrowUp':
          targetCell = row.previousElementSibling?.children[1];
          break;
        case 'ArrowDown':
        case 'Enter':
          targetCell = row.nextElementSibling?.children[1];
          break;
        case 'Tab':
          if (!e.shiftKey) targetCell = row.nextElementSibling?.children[1];
          break;
      }
      if (targetCell) {
        e.preventDefault();
        targetCell.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(targetCell);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    },

    addRow() {
      const tbody = dom.csvTable ? $('tbody', dom.csvTable) : null;
      if (!tbody) return;
      const newLv = getMaxLevel() + 1;
      const tr = this.createRow(newLv, 0);
      tbody.appendChild(tr);
      const expCell = tr.children[1];
      if (expCell) {
        expCell.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(expCell);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  };

  // =====================================================================================
  // 11) 事件绑定（统一管理：AbortController） - 增强版
  // =====================================================================================

  const EventManager = {
    _controllers: new Map(),
    _globalController: new AbortController(),

    add(el, type, handler, options = {}) {
      if (!el) return;
      let byType = this._controllers.get(el);
      if (!byType) {
        byType = new Map();
        this._controllers.set(el, byType);
      }
      let controller = byType.get(type);
      if (!controller) {
        controller = new AbortController();
        byType.set(type, controller);
      }
      const wrappedHandler = (e) => {
        try {
          handler(e);
        } catch (error) {
          console.error(`Event handler error (${type}):`, error);
          ErrorHandler.notify(error, '事件处理');
        }
      };
      el.addEventListener(type, wrappedHandler, {
        ...options,
        signal: controller.signal
      });
    },

    removeAll(el) {
      const byType = this._controllers.get(el);
      if (!byType) return;
      for (const controller of byType.values()) {
        controller.abort();
      }
      this._controllers.delete(el);
    },

    removeAllGlobal() {
      this._globalController.abort();
      this._controllers.clear();
      this._globalController = new AbortController();
    }
  };

  const bindEvents = () => {
    EventManager.add(dom.form, 'submit', (e) => BusinessLogic.onSubmit(e));

    EventManager.add(dom.csvSel, 'change', async () => {
      setDisabled(dom.calcBtn, true);
      setDisabled(dom.editBtn, true);
      try {
        await withError(() => CSVManager.load(CSVManager.getPath()), 'CSV加载', true)();
        setDisabled(dom.calcBtn, false);
        setDisabled(dom.editBtn, false);
      } catch (e) { /* 已在 withError 内处理 */ }
    });

    EventManager.add(dom.editBtn, 'click', () => {
      TableEditor.build();
      setHidden(dom.overlay, false);
      setDisabled(dom.addRowBtn, false);
      setDisabled(dom.saveCsvBtn, false);
    });

    EventManager.add(dom.cancelBtn, 'click', () => { setHidden(dom.overlay, true); });

    EventManager.add(dom.addRowBtn, 'click', () => TableEditor.addRow());

    EventManager.add(dom.saveCsvBtn, 'click', async () => {
      setDisabled(dom.saveCsvBtn, true);
      try {
        await withError(() => CSVManager.save(), 'CSV保存', false)();
      } finally {
        setDisabled(dom.saveCsvBtn, false);
      }
    });

    ['curLv', 'curExp', 'targetLv', 'eph'].forEach(field => {
      const element = dom[field];
      if (element) {
        EventManager.add(element, 'input', debounce((e) => {
          const value = e.target.value;
          const isValid = field.includes('Lv') ?
            Type.level(Number(value)) :
            field === 'curExp' ? Type.exp(Number(value)) : Type.rate(Number(value));
          e.target.classList.toggle(CSS_CLASSES.INVALID_INPUT, !isValid);
        }, 200));
      }
    });
  };

  // =====================================================================================
  // 12) 其他功能（访客计数 / 历史 / 外部倒计时） - 优化版
  // =====================================================================================

  const UtilityFeatures = {
    async fetchCounters() {
      const [all, today] = await Promise.allSettled([
        fetchText(CONFIG.API.ENDPOINTS.VISIT_COUNT),
        fetchText(CONFIG.API.ENDPOINTS.VISIT_COUNT_TODAY),
      ]);
      setText(dom.counter, all.status === 'fulfilled' ? all.value : '获取失败');
      setText(dom.todayCounter, today.status === 'fulfilled' ? today.value : '获取失败');
    },

    async initExternalCountdown() {
      if (!dom.extCd) return;
      try {
        const txt = await fetchText('countdown.txt');
        this.renderExternalCountdown(txt);
      } catch (e) {
        setText(dom.extCd, '无法加载 countdown.txt');
        console.warn('External countdown load failed:', e);
      }
    },

    renderExternalCountdown(txt) {
      setText(dom.extCd, '');
      const parseMode = (s) => String(s || '').trim().toUpperCase() === 'UP' ? 'UP' : 'DN';
      const parseColor = (s) => {
        const hex = String(s || '').trim().replace(/^#/, '').slice(-6);
        return /^[0-9A-Fa-f]{6}$/.test(hex) ? `#${hex}` : '';
      };

      const rawLines = txt.split(/\r?\n/);
      const tasks = [];

      for (const line of rawLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(',');
        const title = parts[0]?.trim();
        const ds = parts[1]?.trim();
        if (!title || !ds) continue;
        const nums = ds.split('/').map(Number);
        if (nums.length < 6 || nums.some(n => !Number.isFinite(n))) continue;

        const [y, m, d, h = 0, mi = 0, s = 0] = nums;
        const target = new Date(y, m - 1, d, h, mi, s);
        if (isNaN(target.getTime())) continue;

        const mode = parseMode(parts[2]);
        const color = parseColor(parts[3]);

        const div = document.createElement('div');
        div.className = CSS_CLASSES.COUNTDOWN_ITEM;
        if (color) div.style.color = color;
        dom.extCd.appendChild(div);

        tasks.push({ el: div, title: String(title), target, mode });
      }

      if (tasks.length === 0) {
        setText(dom.extCd, '暂无外部倒计时任务');
        return;
      }
      this.startExternalCountdownLoop(tasks);
    },

    startExternalCountdownLoop(tasks) {
      const render = () => {
        const now = Date.now();
        let allDnReached = true;
        for (const task of tasks) {
          if (task.mode === 'UP') {
            const diff = Math.max(0, now - task.target.getTime());
            task.el.textContent = `${task.title} ${fmtDur(diff)}`;
          } else {
            const diff = task.target.getTime() - now;
            if (diff > 0) allDnReached = false;
            task.el.textContent = diff <= 0 ?
              `${task.title} 已到达！` :
              `${task.title} 倒计时：${fmtDur(diff)}`;
          }
        }
        if (allDnReached && runtime.extIntervalId) {
          clearInterval(runtime.extIntervalId);
          runtime.extIntervalId = 0;
        }
      };
      render();
      if (runtime.extIntervalId) clearInterval(runtime.extIntervalId);
      runtime.extIntervalId = setInterval(render, CONFIG.TIME.COUNTDOWN_INTERVAL_MS);
    },

    async fetchHistory() {
      try {
        const content = await fetchText(CONFIG.API.ENDPOINTS.HISTORY);
        setText(dom.history, content);
      } catch (e) {
        setText(dom.history, '无法加载历史版本信息');
        console.warn('History fetch failed:', e);
      }
    }
  };

  // =====================================================================================
  // 13) 性能监控和优化
  // =====================================================================================

  const PerformanceMonitor = {
    metrics: {
      pageLoadTime: 0,
      domReadyTime: 0,
      csvLoadTime: 0,
      calculationTime: 0,
      renderTime: 0
    },
    startTiming: performance.now(),
    mark(name) { this.metrics[name] = performance.now() - this.startTiming; },
    report() {
      console.group('Performance Metrics');
      Object.entries(this.metrics).forEach(([key, value]) => {
        console.log(`${key}: ${value.toFixed(2)}ms`);
      });
      console.groupEnd();
    },
    checkMemory() {
      if ('memory' in performance) {
        const mem = performance.memory;
        console.log('Memory Usage:', {
          used: `${(mem.usedJSHeapSize / 1024 / 1024).toFixed(2)}MB`,
          total: `${(mem.totalJSHeapSize / 1024 / 1024).toFixed(2)}MB`,
          limit: `${(mem.jsHeapSizeLimit / 1024 / 1024).toFixed(2)}MB`
        });
      }
    }
  };

  // =====================================================================================
  // 14) 应用初始化 - 增强版（引入 WorkerPool）
  // =====================================================================================

  const App = {
    initialized: false,
    initPromise: null,

    async init() {
      if (this.initialized) return;
      if (this.initPromise) return this.initPromise;
      this.initPromise = this._doInit();
      return this.initPromise;
    },

    async _doInit() {
      try {
        console.log('应用初始化开始...');
        PerformanceMonitor.mark('domReadyTime');

        initDomCache();
        TouchHandler.init();

        // 初始化线程池（如可用）
        concurrencyManager.initWorkers();

        const loadTasks = [
          this.loadInitialData(),
          UtilityFeatures.fetchCounters(),
          UtilityFeatures.initExternalCountdown(),
          UtilityFeatures.fetchHistory()
        ];
        await Promise.allSettled(loadTasks);
        PerformanceMonitor.mark('csvLoadTime');

        bindEvents();
        this.setupGlobalErrorHandling();
        this.startBackgroundTasks();

        this.initialized = true;
        PerformanceMonitor.mark('pageLoadTime');
        PerformanceMonitor.report();

        console.log('应用初始化完成');
        notify('应用加载完成', NOTIFICATION_TYPES.SUCCESS, DURATIONS.SHORT);

      } catch (error) {
        console.error('应用初始化失败:', error);
        ErrorHandler.notify(error, '应用初始化');
        throw error;
      }
    },

    async loadInitialData() {
      try {
        await CSVManager.load(CSVManager.getPath());
        setDisabled(dom.calcBtn, false);
        setDisabled(dom.editBtn, false);
      } catch (error) {
        console.warn('初始CSV加载失败，使用空数据:', error);
        await replaceExpMap(new Map());
      }
    },

    setupGlobalErrorHandling() {
      window.addEventListener('error', (e) => {
        console.error('Global error:', e.error);
        ErrorHandler.notify(e.error, '全局错误');
      });
      window.addEventListener('unhandledrejection', (e) => {
        console.error('Unhandled promise rejection:', e.reason);
        ErrorHandler.notify(e.reason, 'Promise错误');
      });
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          CountdownRenderer.stop();
        } else {
          if (store.data.finishAt > Date.now()) {
            CountdownRenderer.start();
          }
        }
      });
    },

    startBackgroundTasks() {
      setInterval(() => {
        CSVManager.clearCache();
        if (typeof gc === 'function') {
          try { gc(); } catch {}
        }
      }, 300000);

      if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        setInterval(() => { PerformanceMonitor.checkMemory(); }, 60000);
      }

      setInterval(() => {
        UtilityFeatures.fetchCounters().catch(() => {});
      }, 600000);
    },

    cleanup() {
      console.log('应用清理开始...');
      CountdownRenderer.stop();
      if (runtime.extIntervalId) {
        clearInterval(runtime.extIntervalId);
        runtime.extIntervalId = 0;
      }
      EventManager.removeAllGlobal();
      CSVManager.clearCache();
      concurrencyManager.destroyWorkers(); // 终止线程池
      this.initialized = false;
      this.initPromise = null;
      console.log('应用清理完成');
    }
  };

  // =====================================================================================
  // 15) 线程友好的 replaceExpMap（使用 WorkerPool 计算前缀和）
  // =====================================================================================

  async function replaceExpMap(newMap) {
    return concurrencyManager.withLock('expMap', async () => {
      store.data.isLoading = true;
      try {
        let prefixSum;
        const workerUsable = !!concurrencyManager.workerPool && typeof Worker !== 'undefined';
        if (workerUsable && newMap && newMap.size > 0) {
          // 传入排序后的 entries，减少 worker 端排序开销
          const entries = [...newMap.entries()].sort((a, b) => a[0] - b[0]);
          try {
            prefixSum = await concurrencyManager.workerPool.run('computePrefixSum', { entries });
          } catch (e) {
            console.warn('Worker 计算失败，回退到同步计算:', e);
            prefixSum = computePrefixSumSync(newMap);
          }
        } else {
          prefixSum = computePrefixSumSync(newMap);
        }

        store.data.expMap = newMap;
        store.data.prefixSum = prefixSum;
        store.data.lastUpdate = Date.now();
      } finally {
        store.data.isLoading = false;
      }
    });
  }

  // =====================================================================================
  // 16) 应用启动 + 对外导出（移除开发工具模块）
  // =====================================================================================

  window.addEventListener('beforeunload', () => { App.cleanup(); });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => App.init());
  } else {
    App.init();
  }

  if (typeof window !== 'undefined') {
    window.ExpCalculatorApp = {
      // 核心模块（保留对外能力，不包含 dev 调试工具）
      store,
      CSVManager,
      BusinessLogic,
      CountdownRenderer,
      // 工具函数
      utils: { fmtNum, fmtDur, sanitizeHTML, memoize, debounce, throttle },
      // 系统信息
      getStats: () => ({
        storeSubscribers: store.getSubscriberCount(),
        errorStats: ErrorHandler.getErrorStats(),
        performance: PerformanceMonitor.metrics,
        isInitialized: App.initialized
      })
      // 已移除: dev 调试接口（simulateError / reportPerformance / clearAllCaches / checkMemory）
    };
  }
})();
