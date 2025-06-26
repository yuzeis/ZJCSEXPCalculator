(() => {
  'use strict';

  /* ------------------------------ Helpers ------------------------------ */
  const $ = (sel) => document.querySelector(sel);
  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const fmt = (n) => n.toLocaleString();
  const fetchText = async (url, options) => {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(res.statusText || 'Network error');
    return res.text();
  };

  /* ------------------------------ State ------------------------------- */
  const state = {
    levelExp: Object.create(null),
    finishAt: 0,
    cdTimer: 0,
  };

  /* ------------------------------ DOM --------------------------------- */
  const dom = {
    form: $('#expForm'),
    cur: $('#currentLevel'),
    curExp: $('#currentExp'),
    tgt: $('#targetLevel'),
    eph: $('#expPerHour'),
    calcBtn: $('#calcBtn'),
    editBtn: $('#editBtn'),
    results: $('#results'),
    remaining: $('#remainingExp'),
    needSecs: $('#neededSeconds'),
    now: $('#nowTime'),
    finish: $('#finishTime'),
    cd: $('#countdown'),
    overlay: $('#overlay'),
    csvTable: $('#csvTable'),
    cancelBtn: $('#cancelBtn'),
    addRowBtn: $('#addRowBtn'),
    saveCsvBtn: $('#saveCsvBtn'),
    counter: $('#counter'),
    todayCounter: $('#todayCounter'),
  };

  /* ------------------------------- Init ------------------------------- */
  (async function init() {
    try {
      await loadCsv('1.csv');
      dom.calcBtn.disabled = dom.editBtn.disabled = false;
    } catch (err) {
      alert(err.message);
    }

    bindEvents();
    void fetchCounters();
  })();

  /* --------------------------- Event Binding -------------------------- */
  function bindEvents() {
    dom.form.addEventListener('submit', (e) => {
      e.preventDefault();
      calculate();
    });

    dom.editBtn.addEventListener('click', () => {
      buildTable();
      dom.overlay.style.display = 'flex';
    });

    dom.cancelBtn.addEventListener('click', () => {
      dom.overlay.style.display = 'none';
    });

    dom.addRowBtn.addEventListener('click', addRow);
    dom.saveCsvBtn.addEventListener('click', saveCsv);
  }

  /* ---------------------------- CSV Helpers --------------------------- */
  async function loadCsv(url) {
    const text = await fetchText(url);
    parseCsv(text);
  }

  function parseCsv(text) {
    Object.assign(
      state.levelExp,
      ...text
        .trim()
        .split(/\r?\n/)
        .slice(1)
        .map((line) => {
          const [lv, exp] = line.split(',');
          return { [lv]: +exp };
        }),
    );
  }

  /* ------------------------ CSV Editor (UI) --------------------------- */
  function buildTable() {
    const frag = document.createDocumentFragment();

    Object.entries(state.levelExp)
      .sort(([a], [b]) => a - b)
      .forEach(([lv, exp]) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td contenteditable>${lv}</td><td contenteditable>${exp}</td>`;
        frag.appendChild(tr);
      });

    dom.csvTable.innerHTML =
      '<thead><tr><th>等级</th><th>升级所需经验</th></tr></thead><tbody></tbody>';
    dom.csvTable.querySelector('tbody').appendChild(frag);
  }

  const addRow = () =>
    dom.csvTable
      .querySelector('tbody')
      .insertAdjacentHTML('beforeend', '<tr><td contenteditable></td><td contenteditable></td></tr>');

  function tableCsv() {
    const rows = Array.from(dom.csvTable.querySelectorAll('tbody tr'))
      .map((tr) => Array.from(tr.children).map((td) => td.innerText.trim()))
      .filter(([lv, exp]) => lv && exp);
    return 'Lv,EXP\n' + rows.map((r) => r.join(',')).join('\n') + '\n';
  }

  async function saveCsv() {
    try {
      const csv = tableCsv();
      await fetchText('/save-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: csv,
      });
      alert('保存成功');
      Object.keys(state.levelExp).forEach((k) => delete state.levelExp[k]);
      parseCsv(csv);
      dom.overlay.style.display = 'none';
    } catch (e) {
      alert(e.message);
    }
  }

  /* -------------------------- Core Features --------------------------- */
  function calculate() {
    const cur = toNum(dom.cur.value);
    const curExp = toNum(dom.curExp.value);
    const tgt = toNum(dom.tgt.value);
    const rate = toNum(dom.eph.value);

    if (!cur || !tgt || !rate) return alert('请输入完整数据');
    if (tgt <= cur) return alert('目标等级必须高于当前等级');

    let need = 0;
    for (let lv = cur; lv < tgt; lv++) {
      const exp = state.levelExp[lv];
      if (exp == null) return alert(`等级 ${lv} 经验缺失`);
      need += exp;
    }

    need -= curExp;
    if (need <= 0) return alert('已达到目标');

    const seconds = need / (rate / 3600);
    showResult(need, seconds);
  }

  function showResult(need, seconds) {
    dom.results.hidden = false;
    dom.remaining.textContent = `剩余经验值: ${fmt(need)}`;
    dom.needSecs.textContent = `所需秒数: ${fmt(Math.round(seconds))}`;

    const now = Date.now();
    state.finishAt = now + seconds * 1000;
    dom.now.textContent = `现在时间: ${new Date(now).toLocaleString()}`;
    dom.finish.textContent = `完成时间: ${new Date(state.finishAt).toLocaleString()}`;

    clearInterval(state.cdTimer);
    tick();
    state.cdTimer = setInterval(tick, 1000);
  }

  function tick() {
    const diff = state.finishAt - Date.now();
    if (diff <= 0) {
      dom.cd.textContent = '倒计时: 已完成!';
      return clearInterval(state.cdTimer);
    }
    const s = Math.ceil(diff / 1000);
    dom.cd.textContent = `倒计时: ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
  }

  /* ------------------------- Visit Counters --------------------------- */
  async function fetchCounters() {
    try {
      [dom.counter.textContent, dom.todayCounter.textContent] = await Promise.all([
        fetchText('/visit-count'),
        fetchText('/visit-count-today'),
      ]);
    } catch {
      dom.counter.textContent = '读取失败';
    }
  }
})();
