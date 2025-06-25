from __future__ import annotations

from flask import Flask, send_from_directory, request
from pathlib import Path
from threading import RLock
from datetime import datetime
import socket

# ────────────── 路径 & 应用初始化 ──────────────
BASE_DIR = Path(__file__).resolve().parent
CSV_FILE      = BASE_DIR / '1.csv'
COUNTER_FILE  = BASE_DIR / 'counter.txt'
LOG_FILE      = BASE_DIR / 'visit_log.txt'

app  = Flask(__name__, static_folder='static', static_url_path='/static')
_lock = RLock()                    # 可重入锁，允许嵌套调用

# ────────────── 文件保障 ──────────────
def _ensure(path: Path, default: str = '') -> None:
    """若文件不存在则创建并写入默认内容。"""
    if not path.exists():
        path.write_text(default, encoding='utf-8')

_ensure(CSV_FILE,     'Lv,EXP\n98,10000\n')
_ensure(COUNTER_FILE, '0')
_ensure(LOG_FILE)

# ────────────── 通用工具 ──────────────
def _today() -> str:
    return datetime.now().strftime('%Y-%m-%d')

def _atomic_update(path: Path, update_fn) -> None:
    """在全局锁保护下按需读取-修改-写回文件内容。"""
    with _lock:
        content   = path.read_text(encoding='utf-8') if path.exists() else ''
        new_text  = update_fn(content)
        path.write_text(new_text, encoding='utf-8')

# ────────────── 访问计数逻辑 ──────────────
def _log_today_visit() -> None:
    """将今日访问量 +1，记录在 visit_log.txt。"""
    def updater(text: str) -> str:
        lines   = text.splitlines()
        today   = _today()
        updated = False

        for i, line in enumerate(lines):
            if line.startswith(today):
                _, cnt   = line.split(',')
                lines[i] = f'{today},{int(cnt) + 1}'
                updated  = True
                break
        if not updated:
            lines.append(f'{today},1')
        return '\n'.join(lines) + '\n'

    _atomic_update(LOG_FILE, updater)

def _today_count() -> int:
    """读取今日访问量。"""
    if not LOG_FILE.exists():
        return 0
    for line in LOG_FILE.read_text(encoding='utf-8').splitlines():
        if line.startswith(_today()):
            return int(line.split(',')[1])
    return 0

# ────────────── 路由 ──────────────
@app.route('/')
def index():
    return send_from_directory(str(BASE_DIR), 'index.html')

@app.route('/1.csv')
def serve_csv():
    return send_from_directory(str(BASE_DIR), '1.csv')

@app.route('/save-csv', methods=['POST'])
def save_csv():
    try:
        CSV_FILE.write_text(request.get_data(as_text=True), encoding='utf-8')
        return 'OK', 200
    except Exception as exc:        # pragma: no cover
        return str(exc), 500

@app.route('/visit-count')
def visit_count():
    def updater(text: str) -> str:
        return str(int(text.strip() or '0') + 1)

    try:
        _atomic_update(COUNTER_FILE, updater)
        _log_today_visit()
        return COUNTER_FILE.read_text(encoding='utf-8').strip(), 200
    except Exception as exc:        # pragma: no cover
        return f'访问计数失败: {exc}', 500

@app.route('/visit-count-today')
def visit_count_today():
    try:
        return str(_today_count()), 200
    except Exception as exc:        # pragma: no cover
        return f'读取今日访问失败: {exc}', 500

# ────────────── 启动信息 ──────────────
if __name__ == '__main__':
    PORT        = 8080
    PUBLIC_URL  = 'http://m9.ctymc.cn:20822'
    local_ip    = socket.gethostbyname(socket.gethostname())

    print(f"""
====================  经验计算器 服务  ====================
  本机访问  -> http://127.0.0.1:{PORT}
  局域网访问 -> http://{local_ip}:{PORT}
  公网访问  -> {PUBLIC_URL}
========================================================
""")
    app.run(host='0.0.0.0', port=PORT, threaded=True)
