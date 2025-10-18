(() => {
  'use strict';

  // =====================================================================================
  // 0) 类型与错误 (Types & Errors)
  // =====================================================================================

  /** 表单校验错误 */
  class ValidationError extends Error {
    /**
     * @param {string} message
     * @param {string} [field]
     */
    constructor(message, field) {
      super(message);
      this.name = 'ValidationError';
      this.field = field;
    }
  }

  /** 网络错误（包含状态码） */
  class NetworkError extends Error {
    /**
     * @param {string} message
     * @param {number} statusCode
     */
    constructor(message, statusCode) {
      super(message);
      this.name = 'NetworkError';
      this.statusCode = statusCode;
    }
  }

  // =====================================================================================
  // 1) 配置与常量 (Config)
  // =====================================================================================

  /** 通知类型（结构&数值调整：提供统一键与严重级别） */
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
      LVL_UP_NUM: 1111, // 兼容保留字段
      LVL_UP_PER: 0,    // 兼容保留字段
      LVL_UP_ADP: 15,   // 兼容保留字段
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
      TIMEOUT: 5000,
      MAX_RETRIES: 3,
      ENDPOINTS: Object.freeze({
        SAVE_CSV: '/save-csv',
        VISIT_COUNT: '/visit-count',
        VISIT_COUNT_TODAY: '/visit-count-today',
        HISTORY: 'static/history.txt',
      }),
    }),
    UI: Object.freeze({
      MAX_TOASTS: 5,
    }),
  });

  // =====================================================================================
  // 2) 工具函数 (Utilities)
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
   * - 避免 JSON.stringify 在大数组/深对象上的开销（仅用于纯参数场景）
   * @template T
   * @param {Function} fn 目标函数
   * @param {(args:any[])=>any} [keyGenerator] 自定义键生成
   * @returns {Function} 记忆化后的函数
   */
  const memoize = (fn, keyGenerator) => {
    const pCache = new Map();      // 原始/可序列化参数缓存
    const oCache = new WeakMap();  // 对象参数缓存
    const genKey = typeof keyGenerator === 'function'
      ? keyGenerator
      : (args) => (args.length === 1 ? args[0] : JSON.stringify(args));

    return function memoized(...args) {
      if (args.length === 1 && args[0] && typeof args[0] === 'object') {
        const obj = args[0];
        const cached = oCache.get(obj);
        if (cached !== undefined) return cached;
        const val = fn.apply(this, args);
        oCache.set(obj, val);
        return val;
      }
      const key = genKey(args);
      const cached = pCache.get(key);
      if (cached !== undefined) return cached;
      const val = fn.apply(this, args);
      pCache.set(key, val);
      return val;
    };
  };

  /** 防抖（保持调用方 this） */
  const debounce = (fn, delay = 300) => {
    let t = 0;
    return function debounced(...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), delay);
    };
  };

  /** 数值格式化 */
  const nf = /* @__PURE__ */ new Intl.NumberFormat();
  const fmtNum = nf.format.bind(nf);

  /**
   * 时长格式化（中文单位，带缓存）
   * @param {number} ms 毫秒
   * @returns {string} 形如“X天 X时 X分 X秒”
   */
  const _fmtDur = (ms) => {
    const { SECS_PER_DAY, SECS_PER_HOUR, SECS_PER_MIN } = CONFIG.TIME;
    if (!Number.isFinite(ms) || ms <= 0) return '0秒';
    let sec = (ms / 1000) | 0;
    const d = (sec / SECS_PER_DAY)  | 0; sec -= d * SECS_PER_DAY;
    const h = (sec / SECS_PER_HOUR) | 0; sec -= h * SECS_PER_HOUR;
    const m = (sec / SECS_PER_MIN)  | 0; sec -= m * SECS_PER_MIN;
    return `${d}天 ${h}时 ${m}分 ${sec}秒`;
  };
  const fmtDur = memoize(_fmtDur);

  /** 安全 HTML 转义（与 escapeHTML 兼容） */
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

  /** 带超时与重试的 fetch */
  const createFetchWithRetry = (maxRetries = CONFIG.API.MAX_RETRIES, timeout = CONFIG.API.TIMEOUT) => {
    return async (url, options = {}) => {
      let lastErr;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        try {
          const res = await fetch(url, { ...options, signal: controller.signal });
          clearTimeout(id);
          if (!res.ok) throw new NetworkError(`HTTP ${res.status}`, res.status);
          return res;
        } catch (e) {
          clearTimeout(id);
          lastErr = e;
          if (attempt === maxRetries) throw e;
          // 线性退避避免服务器惊群
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
      // 理论不可达：上面已在最后一次抛出
      throw lastErr;
    };
  };
  const fetchWithRetry = createFetchWithRetry();

  const fetchText = async (url, opts) => {
    const res = await fetchWithRetry(url, opts);
    return res.text();
  };

  /** 错误处理中心 */
  const ErrorHandler = {
    /**
     * 错误分类
     * @param {any} error
     * @returns {'validation'|'network'|'timeout'|'unknown'}
     */
    categorize(error) {
      if (error instanceof ValidationError) return 'validation';
      if (error instanceof NetworkError) return 'network';
      if (error && error.name === 'AbortError') return 'timeout';
      return 'unknown';
    },
    /** 指数退避重试 */
    async retryWithBackoff(operation, max = 2, base = 400) {
      let last;
      for (let i = 0; i <= max; i++) {
        try { return await operation(); }
        catch (e) {
          last = e;
          if (i === max) break;
          const ms = base * (1 << i); // 2^i
          await new Promise(r => setTimeout(r, ms));
        }
      }
      throw last;
    },
    /** 错误日志 */
    log(error, context) {
      // 避免序列化巨大对象
      console.error(`[${context}]`, error?.message || error, error);
    },
    /** 错误通知（自动选择严重级） */
    notify(error, context) {
      const kind = this.categorize(error);
      const msg = error?.message || String(error);
      const type =
        kind === 'validation' ? NOTIFICATION_TYPES.WARNING :
        kind === 'network'    ? NOTIFICATION_TYPES.ERROR   :
        kind === 'timeout'    ? NOTIFICATION_TYPES.WARNING :
                                 NOTIFICATION_TYPES.ERROR;
      notify(`${context}失败: ${msg}`, type);
    },
    /** 统一处理包装 */
    async handle(operation, context, retryable = false) {
      try {
        return retryable ? await this.retryWithBackoff(operation) : await operation();
      } catch (e) {
        this.log(e, context);
        this.notify(e, context);
        throw e;
      }
    }
  };

  /**
   * 函数执行包装（委托 ErrorHandler）
   * @param {(…args:any[])=>any} fn
   * @param {string} ctx
   * @param {boolean} [retryable=false]
   * @returns {(…args:any[])=>Promise<any>}
   */
  const withError = (fn, ctx, retryable = false) => async (...args) => {
    return ErrorHandler.handle(() => fn(...args), ctx, retryable);
  };

  // =====================================================================================
  // 3) 轻量 Store 与纯逻辑 (Store & Logic)
  // =====================================================================================

  /** 更安全的 max key 计算：避免展开迭代器带来的潜在堆压力 */
  const maxKeyOfMap = (m) => {
    let max = 0;
    for (const k of m.keys()) if (k > max) max = k;
    return max;
  };

  /** 前缀和：将 Map(level->exp) 转为数组，便于区间累加 */
  const computePrefixSum = (expMap) => {
    const maxLv = maxKeyOfMap(expMap);
    const p = new Array(maxLv + 1);
    p[0] = 0;
    for (let i = 1; i <= maxLv; i++) p[i] = p[i - 1] + (expMap.get(i - 1) ?? 0);
    return p;
  };

  /** 迷你响应式存储 */
  const createStore = (initial) => {
    const subs = new Set();
    const data = new Proxy(initial, {
      set(obj, key, val) {
        if (obj[key] === val) return true;
        obj[key] = val;
        // 订阅分发
        subs.forEach((fn) => { try { fn(key, val); } catch {} });
        return true;
      },
    });
    return { data, subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); } };
  };

  const store = createStore({
    expMap: new Map(),
    prefixSum: [],
    finishAt: 0,
    accelFinishAt: 0,
  });

  /** 用新 Map 替换并重算前缀和 */
  const replaceExpMap = (newMap) => {
    store.data.expMap = newMap;
    store.data.prefixSum = computePrefixSum(newMap);
  };

  /** 最大等级 */
  const getMaxLevel = () => maxKeyOfMap(store.data.expMap);

  /** 剩余经验（curLv->tgtLv，不含当前已拥有的经验） */
  const remainingExp = (curLv, curExp, tgtLv) => store.data.prefixSum[tgtLv] - store.data.prefixSum[curLv] - curExp;

  /** 需要秒数（eph: 每小时经验） */
  const secondsNeed  = (remain, eph) => remain / (eph / CONFIG.TIME.SECS_PER_HOUR);

  // =====================================================================================
  // 4) DOM：Toast/缓存/触摸
  // =====================================================================================

  const runtime = {
    toastHost: null,
    rafId: 0,
    lastTickSec: -1,
    extIntervalId: 0,
    elementData: new WeakMap(),
  };

  /** 将“通知类型参数”规整为 key 字符串 */
  const toTypeKey = (t) => (typeof t === 'string' ? t : (t && t.key) || 'info');

  /**
   * Toast 通知（限制最大并发、可访问性增强）
   * @param {string} msg
   * @param {{key:string}|string} [type]
   * @param {number} [duration]
   */
  const notify = (msg, type = NOTIFICATION_TYPES.INFO, duration = DURATIONS.MEDIUM) => {
    const key = toTypeKey(type);
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

  /** DOM 缓存 */
  const dom = {};
  const initDomCache = () => Object.assign(dom, {
    form:          $('#expForm'),
    csvSel:        $('#csvVersion'),
    curLv:         $('#currentLevel'),
    curExp:        $('#currentExp'),
    targetLv:      $('#targetLevel'),
    eph:           $('#expPerHour'),
    dailyBoosts:   $('#dailyBoosts'),
    stoneBoosts:   $('#stoneBoosts'),
    calcBtn:       $('#calcBtn'),
    editBtn:       $('#editBtn'),
    results:       $('#results'),
    remaining:     $('#remainingExp'),
    needSecs:      $('#neededSeconds'),
    now:           $('#nowTime'),
    finish:        $('#finishTime'),
    accTime:       $('#acceleratedTime'),
    cd:            $('#countdown'),
    accCd:         $('#acceleratedCountdown'),
    overlay:       $('#overlay'),
    csvTable:      $('#csvTable'),
    cancelBtn:     $('#cancelBtn'),
    addRowBtn:     $('#addRowBtn'),
    saveCsvBtn:    $('#saveCsvBtn'),
    counter:       $('#counter'),
    todayCounter:  $('#todayCounter'),
    extCd:         $('#externalCountdown'),
    history:       $('#historyContent'),
  });

  /** 是否触摸设备 */
  const isTouch = () => (('ontouchstart' in window) || (navigator.maxTouchPoints > 0));

  /** 注入触摸样式与处理 */
  const injectTouchAndStyle = () => {
    if (isTouch()) document.documentElement.classList.add('is-touch');
    // 防止双指滚动/缩放误触
    document.addEventListener('touchstart', (e) => {
      if (e.touches.length > 1) e.preventDefault();
    }, { passive: false });
  };

  // =====================================================================================
  // 5) 倒计时渲染（仅秒变更时更新）
  // =====================================================================================

  const renderCountdown = (now) => {
    const remain = store.data.finishAt      - now;
    const accRem = store.data.accelFinishAt - now;
    setText(dom.cd,    remain <= 0 ? '倒计时: 已完成!'     : `倒计时: ${fmtDur(remain)}`);
    setText(dom.accCd, accRem <= 0 ? '加速倒计时: 已完成!' : `加速倒计时: ${fmtDur(accRem)}`);
  };

  const stopCountdown = () => {
    if (runtime.rafId) cancelAnimationFrame(runtime.rafId);
    runtime.rafId = 0;
    runtime.lastTickSec = -1;
  };

  const startCountdown = () => {
    stopCountdown();
    const loop = () => {
      const now = Date.now();
      const sec = (now / 1000) | 0;
      if (sec !== runtime.lastTickSec) {
        renderCountdown(now);
        runtime.lastTickSec = sec;
      }
      if (store.data.finishAt - now <= 0 && store.data.accelFinishAt - now <= 0) return;
      runtime.rafId = requestAnimationFrame(loop);
    };
    loop();
  };

  // =====================================================================================
  // 6) CSV I/O 与校验
  // =====================================================================================

  const csvPath  = () => `${CONFIG.PATHS.CSV_BASE}${dom.csvSel?.value}.csv`;

  /**
   * CSV 解析（支持 BOM 移除、# 注释与可选表头）
   * @param {string} txt
   * @returns {Map<number, number>} Map(level -> exp)
   */
  const parseCsv = (txt) => {
    const map = new Map();
    const content = String(txt ?? '').replace(/^\uFEFF/, '').trim();
    if (!content) return map;

    const lines = content.split(/\r?\n/);
    let i = 0;

    // 跳过空行/注释
    while (i < lines.length) {
      const l = lines[i].trim();
      if (!l || l.startsWith('#')) { i++; continue; }
      break;
    }
    // 跳过潜在表头
    if (i < lines.length && /[a-zA-Z]/.test(lines[i])) i++;

    for (; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw || raw.startsWith('#')) continue;
      const idx = raw.indexOf(',');
      if (idx < 0) continue;

      const lvStr  = raw.slice(0, idx).trim();
      const expStr = raw.slice(idx + 1).trim();
      const lv  = Number(lvStr);
      const exp = Number(expStr);
      if (Number.isFinite(lv) && Number.isFinite(exp)) map.set(lv, exp);
    }
    return map;
  };

  /** CSV 数据合法性校验（严格递增，类型范围） */
  const validateCSVData = (map) => {
    if (!(map instanceof Map)) throw new ValidationError('CSV 数据格式不正确');
    let rows = 0; let lastLv = -Infinity;
    for (const [lv, exp] of map.entries()) {
      rows++;
      if (!Type.level(lv)) throw new ValidationError(`等级越界: ${lv}`, 'level');
      if (!Type.exp(exp))  throw new ValidationError(`经验非法: ${exp}`, 'exp');
      if (lv <= lastLv) throw new ValidationError('等级必须严格递增', 'level');
      lastLv = lv;
    }
    if (rows === 0) throw new ValidationError('CSV 为空');
  };

  /** CSV 序列化（带注入保护） */
  const stringifyCsv = (map) => {
    const rows = [...map.entries()].sort((a, b) => a[0] - b[0])
      .map(([lv, exp]) => `${sanitizeCsvCell(lv)},${sanitizeCsvCell(exp)}`);
    return ['level,exp', ...rows].join('\n');
  };

  /** 加载并替换 CSV */
  const loadCsv = async (url) => {
    const raw = await fetchText(url);
    const parsed = parseCsv(raw);
    validateCSVData(parsed);
    replaceExpMap(parsed);
  };

  /** 保存 CSV（读取表格 -> 校验 -> 上传） */
  const saveCsv = async () => {
    const table = dom.csvTable;
    const tbody = table ? $('tbody', table) : null;
    const rows = tbody ? $$('tr', tbody) : [];
    const newMap = new Map();

    for (let i = 0; i < rows.length; i++) {
      const cells = rows[i].children;
      if (!cells || cells.length < 2) {
        notify(`第 ${i + 1} 行结构非法`, NOTIFICATION_TYPES.ERROR);
        return;
      }
      const lvStr  = (cells[0].textContent || '').trim();
      const expStr = (cells[1].textContent || '').trim();
      if (!CONFIG.PATTERNS.REGEX_INT.test(expStr)) {
        notify(`第 ${i + 1} 行经验必须为非负整数`, NOTIFICATION_TYPES.ERROR);
        return;
      }
      if (!isCSVSafe(expStr)) {
        notify(`第 ${i + 1} 行疑似公式注入，已阻止保存`, NOTIFICATION_TYPES.ERROR);
        return;
      }
      const lv  = Number(lvStr);
      const exp = Number(expStr);
      if (!Type.level(lv) || !Type.exp(exp)) {
        notify(`第 ${i + 1} 行数据非法`, NOTIFICATION_TYPES.ERROR);
        return;
      }
      newMap.set(lv, exp);
    }

    try {
      validateCSVData(newMap);
    } catch (e) {
      notify(e.message, NOTIFICATION_TYPES.ERROR);
      return;
    }

    replaceExpMap(newMap);
    setHidden(dom.overlay, true);

    const body = stringifyCsv(store.data.expMap);
    await fetchWithRetry(`${CONFIG.API.ENDPOINTS.SAVE_CSV}?file=${encodeURIComponent(dom.csvSel?.value)}.csv`, {
      method: 'POST', headers: { 'Content-Type': 'text/csv' }, body,
    });
    notify('保存成功', NOTIFICATION_TYPES.SUCCESS);
  };

  const safeLoadCsv  = withError(loadCsv, '加载CSV', true);
  const safeSaveCsv  = withError(saveCsv, '保存CSV', true);

  // =====================================================================================
  // 7) 业务逻辑与渲染
  // =====================================================================================

  /**
   * 结果渲染：更新剩余经验、耗时、时间点并启动倒计时
   * @param {number} remain 剩余经验
   * @param {number} secs   需要秒数
   */
  const renderResult = (remain, secs) => {
    setHidden(dom.results, false);
    requestAnimationFrame(() => {
      setText(dom.remaining, `剩余经验值: ${fmtNum(remain)}`);
      setText(dom.needSecs,  `预计耗时: ${fmtDur(secs * 1000)}`);

      const now = Date.now();
      store.data.finishAt       = now + secs * 1000;
      setText(dom.now,          `现在时间: ${new Date(now).toLocaleString()}`);
      setText(dom.finish,       `完成时间: ${new Date(store.data.finishAt).toLocaleString()}`);

      const boosts = toNumber(dom.dailyBoosts?.value) + toNumber(dom.stoneBoosts?.value);
      const accel  = boosts * CONFIG.BUSINESS.ACCEL_SECONDS_PER_BOOST;
      store.data.accelFinishAt  = store.data.finishAt - accel * 1000;
      setText(dom.accTime,      `加速完成: ${new Date(store.data.accelFinishAt).toLocaleString()}`);

      startCountdown();
    });
  };

  /** 提交计算 */
  const onSubmit = (e) => {
    e.preventDefault();
    const curLv = toNumber(dom.curLv?.value);
    const curEx = toNumber(dom.curExp?.value);
    const tgtLv = toNumber(dom.targetLv?.value);
    const eph   = toNumber(dom.eph?.value);

    const { MIN, MAX } = CONFIG.BUSINESS.LEVEL_RANGE;

    if (!Type.level(curLv) || !Type.level(tgtLv))
      return notify(`等级必须在 ${MIN}-${MAX} 且为整数`, NOTIFICATION_TYPES.ERROR);
    if (!Type.exp(curEx))
      return notify('当前经验必须为非负数', NOTIFICATION_TYPES.ERROR);
    if (!Type.rate(eph))
      return notify('每小时经验必须为正数', NOTIFICATION_TYPES.ERROR);
    if (tgtLv <= curLv)
      return notify('目标等级必须高于当前等级', NOTIFICATION_TYPES.ERROR);

    if (!store.data.expMap.has(tgtLv - 1))
      return notify('目标等级超出数据范围', NOTIFICATION_TYPES.ERROR);

    // 校验区间内每级都有数据
    for (let lv = curLv; lv < tgtLv; lv++) {
      if (!store.data.expMap.has(lv))
        return notify(`等级 ${lv} 经验缺失`, NOTIFICATION_TYPES.ERROR);
    }

    const remain = remainingExp(curLv, curEx, tgtLv);
    if (remain <= 0) return notify('已达到目标等级或经验', NOTIFICATION_TYPES.INFO);

    const secs = secondsNeed(remain, eph);
    renderResult(remain, secs);
  };

  // =====================================================================================
  // 8) CSV 可编辑表（批量构建 + 实时校验 + 防抖）
  // =====================================================================================

  const buildEditableTable = () => {
    if (!dom.csvTable) return;

    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');
    const thLv = document.createElement('th'); thLv.textContent = '等级';
    const thExp = document.createElement('th'); thExp.textContent = '经验';
    trHead.append(thLv, thExp);
    thead.appendChild(trHead);

    const tbody = document.createElement('tbody');
    const frag  = document.createDocumentFragment();

    // 排序后构建，避免数据顺序对 UI 造成潜在不确定性
    const entries = [...store.data.expMap.entries()].sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < entries.length; i++) {
      const [lv, exp] = entries[i];
      const tr    = document.createElement('tr');
      const tdLv  = document.createElement('td'); tdLv.textContent = String(lv);
      const tdExp = document.createElement('td'); tdExp.setAttribute('contenteditable', 'true'); tdExp.textContent = String(exp);
      runtime.elementData.set(tdExp, { valid: true });
      tr.append(tdLv, tdExp);
      frag.appendChild(tr);
    }

    tbody.appendChild(frag);

    EventManager.removeAll(tbody);
    const validateCell = debounce(function (target) {
      if (!(target instanceof HTMLElement) || target.cellIndex !== 1) return;
      const s = (target.textContent || '').trim();
      const ok = CONFIG.PATTERNS.REGEX_INT.test(s) && isCSVSafe(s);
      target.classList.toggle(CSS_CLASSES.INVALID_INPUT, !ok);
      const meta = runtime.elementData.get(target) || {};
      meta.valid = ok; runtime.elementData.set(target, meta);
    }, 200);

    EventManager.add(tbody, 'input', (e) => validateCell(e.target));
    dom.csvTable.replaceChildren(thead, tbody);
  };

  const addRow = () => {
    const tbody = dom.csvTable ? $('tbody', dom.csvTable) : null;
    if (!tbody) return;
    const newLv = getMaxLevel() + 1;
    const tr    = document.createElement('tr');
    const tdLv  = document.createElement('td'); tdLv.textContent = String(newLv);
    const tdExp = document.createElement('td'); tdExp.setAttribute('contenteditable', 'true'); tdExp.textContent = '0';
    runtime.elementData.set(tdExp, { valid: true });
    tr.append(tdLv, tdExp);
    tbody.appendChild(tr);
  };

  // =====================================================================================
  // 9) 事件绑定（统一管理：AbortController）
  // =====================================================================================

  const EventManager = {
    /** @type {Map<Element, Map<string, AbortController>>} */
    _controllers: new Map(),
    add(el, type, handler, options = {}) {
      if (!el) return; // 容错空元素，避免 NPE
      let byType = this._controllers.get(el);
      if (!byType) { byType = new Map(); this._controllers.set(el, byType); }
      let controller = byType.get(type);
      if (!controller) { controller = new AbortController(); byType.set(type, controller); }
      el.addEventListener(type, handler, { ...options, signal: controller.signal });
    },
    removeAll(el) {
      const byType = this._controllers.get(el);
      if (!byType) return;
      for (const [, controller] of byType.entries()) controller.abort();
      this._controllers.delete(el);
    },
  };

  const bindEvents = () => {
    EventManager.add(dom.form, 'submit', onSubmit);

    EventManager.add(dom.csvSel, 'change', async () => {
      setDisabled(dom.calcBtn, true);
      setDisabled(dom.editBtn, true);
      try {
        await safeLoadCsv(csvPath());
        setDisabled(dom.calcBtn, false);
        setDisabled(dom.editBtn, false);
      } catch { /* 已统一处理 */ }
    });

    EventManager.add(dom.editBtn, 'click', () => {
      buildEditableTable();
      setHidden(dom.overlay, false);
      setDisabled(dom.addRowBtn, false);
      setDisabled(dom.saveCsvBtn, false);
    });

    EventManager.add(dom.cancelBtn, 'click', () => { setHidden(dom.overlay, true); });
    EventManager.add(dom.addRowBtn, 'click', addRow);

    EventManager.add(dom.saveCsvBtn, 'click', async () => {
      try { await safeSaveCsv(); } catch {}
    });
  };

  // =====================================================================================
  // 10) 其他功能（访客计数 / 历史 / 外部倒计时）
  // =====================================================================================

  const fetchCounters = async () => {
    const [all, today] = await Promise.all([
      fetchText(CONFIG.API.ENDPOINTS.VISIT_COUNT),
      fetchText(CONFIG.API.ENDPOINTS.VISIT_COUNT_TODAY),
    ]);
    setText(dom.counter, all);
    setText(dom.todayCounter, today);
  };
  const safeFetchCounters = withError(fetchCounters, '读取计数', true);

  const initExternalCountdown = async () => {
    if (!dom.extCd) return;
    let txt;
    try { txt = await fetchText('countdown.txt'); }
    catch { setText(dom.extCd, '无法加载 countdown.txt'); return; }

    setText(dom.extCd, '');

    // 新增：支持 DN/UP 与颜色，并向后兼容旧两段式格式（保持原功能）
    const parseMode = (s) => {
      const m = String(s || '').trim().toUpperCase();
      return m === 'UP' ? 'UP' : 'DN';
    };
    const parseColor = (s) => {
      const hex = String(s || '').trim().replace(/^#/, '');
      const c = hex.slice(-6);
      return /^[0-9A-Fa-f]{6}$/.test(c) ? `#${c}` : '';
    };

    const rawLines = txt.split(/\r?\n/);
    /** @type {{ el:HTMLElement, title:string, target:Date, mode:'UP'|'DN' }[]} */
    const tasks = [];

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i].trim();
      if (!line) continue;

      const parts = line.split(',');
      const title = parts[0]?.trim();
      const ds    = parts[1]?.trim();
      if (!title || !ds) continue;

      const nums = ds.split('/').map(Number);
      const y = nums[0], m = nums[1], d = nums[2], h = nums[3], mi = nums[4], s = nums[5];
      const target = new Date(y, (m | 0) - 1, d | 0, h | 0, mi | 0, s | 0);

      const mode  = parseMode(parts[2]);
      const color = parseColor(parts[3]);

      const div = document.createElement('div');
      div.className = CSS_CLASSES.COUNTDOWN_ITEM;
      if (color) div.style.color = color;
      dom.extCd.appendChild(div);

      tasks.push({ el: div, title: String(title), target, mode });
    }

    if (!tasks.length) { setText(dom.extCd, '暂无外部倒计时任务'); return; }

    const render = () => {
      const now = Date.now();
      let allDnReached = true; // 仅统计 DN 的“到达”状态以决定是否清除定时器
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        if (t.mode === 'UP') {
          // 计时：从目标时间起已经过去多久，负值当作 0
          const diff = Math.max(0, now - t.target.getTime());
          t.el.textContent = `${t.title} ${fmtDur(diff)}`;
        } else {
          // 倒计时：到目标时间还有多久
          const diff = t.target.getTime() - now;
          if (diff > 0) allDnReached = false;
          t.el.textContent = diff <= 0 ? `${t.title} 已到达！` : `${t.title} 倒计时：${fmtDur(diff)}`;
        }
      }
      if (allDnReached && runtime.extIntervalId) {
        clearInterval(runtime.extIntervalId);
        runtime.extIntervalId = 0;
      }
    };

    render();
    runtime.extIntervalId = setInterval(render, CONFIG.TIME.COUNTDOWN_INTERVAL_MS);
  };
  const safeInitExternalCountdown = withError(initExternalCountdown, '外部倒计时', false);

  const fetchHistory = async () => {
    try {
      setText(dom.history, await fetchText(CONFIG.API.ENDPOINTS.HISTORY));
    } catch {
      setText(dom.history, '无法加载历史版本信息');
    }
  };
  const safeFetchHistory = withError(fetchHistory, '读取历史', false);

  // =====================================================================================
  // 11) 初始化
  // =====================================================================================

  document.addEventListener('DOMContentLoaded', async () => {
    initDomCache();
    injectTouchAndStyle();
    try {
      await safeLoadCsv(csvPath());
      setDisabled(dom.calcBtn, false);
      setDisabled(dom.editBtn, false);
    } catch { /* 已提示 */ }
    bindEvents();
    void safeFetchCounters();
    void safeInitExternalCountdown();
    void safeFetchHistory();
  });
})();
