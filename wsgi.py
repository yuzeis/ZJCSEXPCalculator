# wsgi.py — Waitress 入口（Windows 专用）
# 放到：C:\Users\Administrator\Desktop\TEMPINT\wsgi.py
from werkzeug.middleware.proxy_fix import ProxyFix
from app import app  # 确保 app.py 中有 app = Flask(__name__)

# 让 Flask 识别反代传来的真实 IP/协议等
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1)