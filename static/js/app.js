(() => {
  'use strict';

  /* ---------------------------- Helpers & State ---------------------------- */
  const $ = (selector) => document.querySelector(selector);
  const levelExpTable = Object.create(null);
  let finishAt = null;
  let cdTimer = null;

  /* ----------------------------- DOM Elements ------------------------------ */
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

  /* --------------------------------- Init ---------------------------------- */
  (async function init() {
    try {
      await loadCsv('1.csv');
      dom.calcBtn.disabled = dom.editBtn.disabled = false;
    } catch (err) {
      alert(err.message || err);
    }

    bindEvents();
    fetchCounters();
  })();

  /* ----------------------------- Event Binding ----------------------------- */
  function bindEvents() {
    dom.form.addEventListener('submit', (e) => {
      e.preventDefault();
      calculate();
    });

    dom.editBtn.addEventListener('click', () => {
      buildTable();
      dom.overlay.style.display = 'flex';
    });

    dom.cancelBtn.addEventListener('click', () => (dom.overlay.style.display = 'none'));
    dom.addRowBtn.addEventListener('click', addRow);
    dom.saveCsvBtn.addEventListener('click', saveCsv);
  }

  /* ------------------------------ CSV Helpers ------------------------------ */
  async function loadCsv(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('CSV 加载失败');
    parseCsv(await res.text());
  }

  function parseCsv(text) {
    text
      .trim()
      .split(/\r?\n/)
      .slice(1) // Skip header
      .forEach((line) => {
        const [lv, exp] = line.split(',');
        levelExpTable[Number(lv)] = Number(exp);
      });
  }

  /* ----------------------------- Core Features ----------------------------- */
  function calculate() {
    const cur = Number(dom.cur.value);
    const curExp = Number(dom.curExp.value);
    const tgt = Number(dom.tgt.value);
    const rate = Number(dom.eph.value);

    if (!cur || !tgt || !rate) return alert('请输入完整数据');
    if (tgt <= cur) return alert('目标等级必须高于当前等级');

    let need = 0;
    for (let lv = cur; lv < tgt; lv++) {
      const exp = levelExpTable[lv];
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
    dom.remaining.textContent = `剩余经验值: ${need.toLocaleString()}`;
    dom.needSecs.textContent = `所需秒数: ${Math.round(seconds).toLocaleString()}`;

    const now = new Date();
    finishAt = new Date(now.getTime() + seconds * 1000);

    dom.now.textContent = `现在时间: ${now.toLocaleString()}`;
    dom.finish.textContent = `完成时间: ${finishAt.toLocaleString()}`;

    clearInterval(cdTimer);
    tick();
    cdTimer = setInterval(tick, 1000);
  }

  function tick() {
    const diff = finishAt - Date.now();
    if (diff <= 0) {
      dom.cd.textContent = '倒计时: 已完成!';
      return clearInterval(cdTimer);
    }

    const s = Math.ceil(diff / 1000);
    dom.cd.textContent = `倒计时: ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
  }

  /* ---------------------------- CSV Editor UI ----------------------------- */
  function buildTable() {
    dom.csvTable.innerHTML =
      '<thead><tr><th>等级</th><th>升级所需经验</th></tr></thead><tbody></tbody>';

    const tbody = dom.csvTable.querySelector('tbody');
    Object.keys(levelExpTable)
      .sort((a, b) => a - b)
      .forEach((lv) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td contenteditable>${lv}</td><td contenteditable>${levelExpTable[lv]}</td>`;
        tbody.appendChild(tr);
      });
  }

  function addRow() {
    dom.csvTable
      .querySelector('tbody')
      .insertAdjacentHTML('beforeend', '<tr><td contenteditable></td><td contenteditable></td></tr>');
  }

  function tableCsv() {
    let csv = 'Lv,EXP\n';
    dom.csvTable.querySelectorAll('tbody tr').forEach((tr) => {
      const [lv, exp] = Array.from(tr.children).map((td) => td.innerText.trim());
      if (lv && exp) csv += `${lv},${exp}\n`;
    });
    return csv;
  }

  async function saveCsv() {
    const data = tableCsv();

    try {
      const res = await fetch('/save-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: data,
      });
      if (!res.ok) throw new Error('保存失败');

      alert('保存成功');
      Object.keys(levelExpTable).forEach((k) => delete levelExpTable[k]);
      parseCsv(data);
      dom.overlay.style.display = 'none';
    } catch (err) {
      alert(err.message || err);
    }
  }

  /* ----------------------------- Visit Counter ----------------------------- */
  async function fetchCounters() {
    try {
      dom.counter.textContent = await getText('/visit-count');
      dom.todayCounter.textContent = await getText('/visit-count-today');
    } catch {
      dom.counter.textContent = '读取失败';
    }
  }

  async function getText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error();
    return res.text();
  }
})();
