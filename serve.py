#!/usr/bin/env python3
"""
一键启动本地 HTTP 服务器，用于本地测试 Tampermonkey 脚本安装

用法：
    python3 serve.py
    # 浏览器会自动打开 http://localhost:8080
    # 若 8080 被占用，会自动换到 8081 / 8082 ...
"""

import http.server
import socketserver
import os
import sys
import webbrowser

DIRECTORY = os.path.dirname(os.path.abspath(__file__))
PREFERRED_PORT = 8080


class MyHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    # 关键：直接改写类型推断，避免重复发送 Content-Type 头
    def guess_type(self, path):
        if path.endswith('.user.js'):
            return 'application/javascript'
        return super().guess_type(path)

    def end_headers(self):
        # 本地调试不要缓存，改完脚本刷新即生效
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()

    def log_message(self, fmt, *args):
        # 只打印脚本相关请求，别把 favicon 之类刷满屏
        if '.user.js' in (args[0] if args else ''):
            sys.stderr.write("  → %s\n" % (args[0] if args else ''))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True      # 端口复用，避免重启时报 Address already in use
    daemon_threads = True


def start_server():
    last_err = None
    for port in range(PREFERRED_PORT, PREFERRED_PORT + 10):
        try:
            return Server(("127.0.0.1", port), MyHandler), port
        except OSError as e:
            last_err = e
            continue
    raise SystemExit("❌ 8080-8089 全部被占用，无法启动：%s" % last_err)


if __name__ == '__main__':
    httpd, port = start_server()
    install_url = "http://localhost:%d/yuanbao-helper.user.js" % port
    home_url = "http://localhost:%d/index.html" % port

    print("""
✅ 本地服务器已启动
📁 服务目录: {d}

   安装页:   {h}
   脚本地址: {u}

⚠️  这个终端窗口不能关，关掉服务器就停了
⏹️  按 Ctrl+C 停止
""".format(d=DIRECTORY, h=home_url, u=install_url), flush=True)

    try:
        webbrowser.open(home_url)
    except Exception:
        pass

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n服务器已停止", flush=True)
    finally:
        httpd.server_close()
