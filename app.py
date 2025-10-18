
from __future__ import annotations

import logging
import socket
import time
from datetime import datetime
from pathlib import Path
from threading import RLock
from logging.handlers import TimedRotatingFileHandler

from flask import Flask, request, send_from_directory, Response
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.utils import secure_filename  # 安全文件名

# ────────────── 路径设置 ──────────────
BASE_DIR = Path(__file__).resolve().parent
LOGS_DIR = BASE_DIR / "logs"
LOGS_DIR.mkdir(exist_ok=True)

STATIC_DIR     = BASE_DIR / "static"
DATABASE_DIR   = STATIC_DIR / "database"   # ✅ CSV 目录
HISTORY_FILE   = STATIC_DIR / "history.txt"
COUNTER_FILE   = BASE_DIR / "counter.txt"
COUNTDOWN_FILE = BASE_DIR / "countdown.txt"

VISIT_LOG_FILE = LOGS_DIR / "visit_log.txt"
APP_LOG_FILE   = LOGS_DIR / "app.log"

app = Flask(__name__, static_folder="static", static_url_path="/static")

# 让 Flask/werkzeug 识别来自 Nginx 的代理头（真实 IP/Host）
# 注意：一定要在注册蓝图/路由之前应用
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_host=1)

# （可选）HTTP 压缩：存在则开启，不存在则跳过（不影响功能）
try:
    from flask_compress import Compress
    app.config.setdefault("COMPRESS_MIMETYPES", [
        "text/html", "text/css", "application/javascript", "application/json",
        "text/plain", "text/csv", "image/svg+xml"
    ])
    app.config.setdefault("COMPRESS_LEVEL", 6)
    app.config.setdefault("COMPRESS_MIN_SIZE", 100)
    Compress(app)
except Exception:
    pass

# 默认：静态文件缓存 1 天（具体策略在 after_request 统一覆盖）
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 86400  # 1 天（秒）

_lock = RLock()

# ────────────── 统一响应头 & 缓存策略 ──────────────
@app.after_request
def _set_security_and_cache_headers(resp: Response):
    # 基本安全头
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")

    # 删除不推荐或多余的响应头：Expires、Server（Server 由前置 Nginx 控制）
    resp.headers.pop("Expires", None)
    resp.headers.pop("Server", None)

    p  = request.path or ""
    ct = (resp.headers.get("Content-Type") or "").lower()

    # 1) HTML：不强缓存，方便发布更新
    if p in ("/", "/index.html") or ct.startswith("text/html"):
        resp.headers["Cache-Control"] = "no-cache"

    # 2) /static 下所有静态资源：统一 1 天 + immutable
    elif p.startswith("/static/"):
        resp.headers["Cache-Control"] = "public, max-age=86400, immutable"

    # 3) 其它接口
    elif p == "/countdown.txt":
        resp.headers["Cache-Control"] = "public, max-age=300"  # 5 分钟
    elif p == "/visit-count":
        resp.headers["Cache-Control"] = "no-cache"
    elif p == "/visit-count-today":
        resp.headers["Cache-Control"] = "public, max-age=30"

    return resp

# ────────────── 日志 ──────────────
def _init_logging() -> logging.Logger:
    logger = logging.getLogger("exp-calculator")
    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    if logger.handlers:
        return logger
    logger.setLevel(logging.INFO)
    formatter = logging.Formatter(
        "[%(levelname)s] %(asctime)s [%(threadName)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    )
    fh = TimedRotatingFileHandler(APP_LOG_FILE, when="midnight", backupCount=7, encoding="utf-8")
    fh.setFormatter(formatter)
    logger.addHandler(fh)
    ch = logging.StreamHandler()
    ch.setFormatter(formatter)
    logger.addHandler(ch)
    logger.propagate = False
    return logger

logger = _init_logging()

# ────────────── 文件保障 ──────────────
def _ensure(path: Path, default: str = "") -> None:
    if not path.exists():
        if path.suffix:
            path.write_text(default, encoding="utf-8")
        else:
            path.mkdir(parents=True, exist_ok=True)
        logger.info(f"Created missing: {path.relative_to(BASE_DIR)}")

_ensure(STATIC_DIR)
_ensure(DATABASE_DIR)  # 确保 /static/database 存在
_ensure(HISTORY_FILE, "## 历史版本\n\n- 1.0.1 (2025-07-15) 修复计时器显示异常\n")
_ensure(COUNTER_FILE, "0")
_ensure(COUNTDOWN_FILE, "拥抱未来,2099/12/31/08/00/00\n")
_ensure(VISIT_LOG_FILE)
_ensure(APP_LOG_FILE)

# ────────────── 工具函数 ──────────────
def _today() -> str:
    return datetime.now().strftime("%Y-%m-%d")

def _atomic_update(path: Path, update_fn):
    with _lock:
        content = path.read_text(encoding="utf-8") if path.exists() else ""
        path.write_text(update_fn(content), encoding="utf-8")

# ────────────── 访问计数 ──────────────
def _extract_real_ip() -> str:
    """优先从代理头里拿真实客户端 IP，兜底 remote_addr"""
    xff = request.headers.get("X-Forwarded-For", "")
    real_ip = xff.split(",")[0].strip() if xff else request.headers.get("X-Real-IP")
    return real_ip or (request.remote_addr or "unknown")

_last_visit: dict[str, float] = {}
THROTTLE_SEC = 3

@app.before_request
def _log_ip_visit() -> None:
    # 保留日志，但记录真实客户端 IP（即使 ProxyFix 未生效也能正确）
    ip = _extract_real_ip()
    now = time.time()
    if now - _last_visit.get(ip, 0) >= THROTTLE_SEC:
        logger.info(f"Visit from {ip}")
        _last_visit[ip] = now

# ────────────── 路由 ──────────────
@app.route("/")
def index():
    # HTML 不缓存
    return send_from_directory(str(BASE_DIR), "index.html", max_age=0)

# ✅ CSV 静态路由：/static/database/<csv文件> （多文件）
@app.route("/static/database/<path:filename>")
def serve_csv(filename):
    # conditional=True 支持 304 协商；Cache-Control 由 after_request 统一设置为 1 天
    return send_from_directory(str(DATABASE_DIR), filename, conditional=True)

@app.route("/countdown.txt")
def serve_countdown():
    # 短缓存 5 分钟（after_request 也会覆盖）
    return send_from_directory(str(BASE_DIR), "countdown.txt", conditional=True, max_age=300)

@app.route("/save-csv", methods=["POST"])
def save_csv():
    """
    保存 CSV 到 /static/database/ 目录。
    用法：POST /save-csv?file=Gold.csv   （body 为 CSV 文本）
    """
    try:
        data = request.get_data(as_text=True) or ""
        raw_name = (request.args.get("file") or "default.csv").strip()
        # 更安全：清理文件名，禁止目录穿越；统一 .csv 后缀
        filename = secure_filename(raw_name)
        if not filename.lower().endswith(".csv"):
            filename += ".csv"
        target_file = DATABASE_DIR / filename
        target_file.write_text(data, encoding="utf-8")
        logger.info(f"CSV {filename} saved by {_extract_real_ip()}")
        resp = Response("OK", mimetype="text/plain")
        resp.headers["Cache-Control"] = "no-cache"
        return resp, 200
    except Exception as exc:
        logger.error(f"Failed to save CSV: {exc}")
        return str(exc), 500

@app.route("/visit-count")
def visit_count():
    def updater(text: str) -> str:
        return str(int(text.strip() or "0") + 1)
    try:
        _atomic_update(COUNTER_FILE, updater)
        _log_today_visit()
        # 记录真实 IP 的来访
        logger.info(f"Visit count incremented (total): {COUNTER_FILE.read_text(encoding='utf-8').strip()}")
        resp = Response(COUNTER_FILE.read_text(encoding="utf-8").strip(), mimetype="text/plain")
        resp.headers["Cache-Control"] = "no-cache"
        return resp, 200
    except Exception as exc:
        logger.error(f"访问计数失败: {exc}")
        return f"访问计数失败: {exc}", 500

@app.route("/visit-count-today")
def visit_count_today():
    try:
        today_cnt = str(_today_count())
        logger.info(f"今日访问量读取: {today_cnt}")
        resp = Response(today_cnt, mimetype="text/plain")
        resp.headers["Cache-Control"] = "public, max-age=30"
        return resp, 200
    except Exception as exc:
        logger.error(f"读取今日访问失败: {exc}")
        return f"读取今日访问失败: {exc}", 500

# ────────────── 今日计数工具 ──────────────
def _log_today_visit() -> None:
    def updater(text: str) -> str:
        lines = text.splitlines()
        today = _today()
        for i, line in enumerate(lines):
            if line.startswith(today):
                date, cnt = line.split(",")
                lines[i] = f"{date},{int(cnt) + 1}"
                break
        else:
            lines.append(f"{today},1")
        return "\n".join(lines) + "\n"
    _atomic_update(VISIT_LOG_FILE, updater)

def _today_count() -> int:
    if not VISIT_LOG_FILE.exists():
        return 0
    for line in VISIT_LOG_FILE.read_text(encoding="utf-8").splitlines():
        if line.startswith(_today()):
            return int(line.split(",")[1])
    return 0

# ────────────── 启动（Waitress，信任代理头） ──────────────
def _get_local_ip() -> str:
    try:
        return socket.gethostbyname(socket.gethostname())
    except Exception:
        return "127.0.0.1"

if __name__ == "__main__":
    from waitress import serve

    PORT = 8080
    PUBLIC_URL = "http://m9.ctymc.cn:20822"
    local_ip = _get_local_ip()

    logger.info(
        f"Server starting → 本机: http://127.0.0.1:{PORT}, 局域网: http://{local_ip}:{PORT}, 公网: {PUBLIC_URL}"
    )
    print(f"""
====================  经验计算器 服务  ====================
  本机访问  -> http://127.0.0.1:{PORT}
  局域网访问 -> http://{local_ip}:{PORT}
  公网访问  -> {PUBLIC_URL}
========================================================
""".strip())

    # Waitress 2.x 默认不信任代理头，这里显式允许
    serve(
        app,
        host="127.0.0.1",  # 仅本机监听，交给 Nginx 反代；若要直连测试可用 "0.0.0.0"
        port=PORT,
        trusted_proxy_headers={
            "x-forwarded-for",
            "x-forwarded-proto",
            "x-forwarded-host",
            "x-real-ip",
        },
    )
