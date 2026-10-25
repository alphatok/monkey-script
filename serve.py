#!/usr/bin/env python3
"""
一键启动本地 HTTP 服务器，用于本地测试 Tampermonkey 脚本安装

用法：
    python3 serve.py
    # 然后浏览器打开 http://localhost:8080
"""

import http.server
import socketserver
import os
import webbrowser

PORT = 8080
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class MyHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        # 让 .user.js 文件返回正确的 Content-Type
        if self.path.endswith('.user.js'):
            self.send_header('Content-Type', 'application/javascript')
        super().end_headers()

if __name__ == '__main__':
    with socketserver.TCPServer(("", PORT), MyHandler) as httpd:
        url = f"http://localhost:{PORT}"
        print(f"\n✅ 本地服务器已启动: {url}")
        print(f"📁 服务目录: {DIRECTORY}")
        print("⏹️  按 Ctrl+C 停止\n")

        # 自动打开浏览器
        webbrowser.open(url)

        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n服务器已停止")
