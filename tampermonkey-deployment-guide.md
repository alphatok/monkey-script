# Tampermonkey 脚本安装与部署教程

> 整理日期：2026-10-25
>
> 原始链接：https://www.tampermonkey.net/documentation.php?locale=en&q=deploying

---

## Index

- [方案一：.user.js 链接安装](#方案一userjs-链接安装step-by-step)
  - [基本原理](#31-基本原理)
  - [Step 1：准备 .user.js 文件](#32-step-1准备一个-userjs-文件)
  - [Step 2：提供 .meta.js 文件（可选）](#33-step-2提供-metajs-文件可选用于自动更新)
  - [Step 3：部署到 Web 服务器](#34-step-3部署到-web-服务器)
  - [Step 4：触发安装](#35-step-4触发安装)
  - [注意事项](#36-注意事项与限制)
- [方案二：浏览器策略 JSON 部署](#方案二浏览器策略-json-部署step-by-step)
  - [适用场景](#41-适用场景)
  - [整体流程](#42-整体流程)
  - [Step 1：准备脚本并编码](#43-step-1准备脚本并编码)
  - [Step 2：创建 Provisioning JSON](#44-step-2创建-provisioning-json-文件)
  - [Step 3：托管并计算 Hash](#45-step-3托管-json-文件并计算-hash)
  - [Step 4：配置浏览器策略](#46-step-4配置浏览器策略)
    - [Firefox](#461-firefox-配置)
    - [Chrome/Chromium Linux](#462-chrome--edge--chromium-配置linux)
    - [Chrome Windows](#463-chrome--edgewindows-注册表)
    - [Google Workspace](#464-google-workspace--chrome-enterprise云端管理)
  - [Step 5：验证部署](#47-step-5验证部署)
  - [更新脚本流程](#48-更新脚本流程)
  - [注意事项](#49-关键注意事项)
- [方案对比](#方案对比)
- [参考链接](#参考链接)

---

## 方案一：.user.js 链接安装（Step by Step）

这是 Tampermonkey **原生支持**的脚本安装方式。当浏览器访问以 `.user.js` 结尾的 URL 时，Tampermonkey 会自动弹窗提示安装。

### 3.1 基本原理

```
浏览器访问 https://example.com/my-script.user.js
        ↓
Tampermonkey 拦截请求（根据 Content-Type 或 .user.js 后缀）
        ↓
弹出安装确认窗口
        ↓
用户点击"安装"后脚本生效
```

### 3.2 Step 1：准备一个 .user.js 文件

文件必须以 `.user.js` 结尾，且包含标准的 UserScript Header：

```javascript
// ==UserScript==
// @name         My Awesome Script
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  这是一个示例脚本
// @author       You
// @match        https://example.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @updateURL    https://example.com/my-script.meta.js
// @downloadURL  https://example.com/my-script.user.js
// ==/UserScript==

(function() {
    'use strict';
    console.log('脚本已运行！');
})();
```

**关键 Header 说明**：

| Header | 作用 |
|--------|------|
| `@name` | 脚本显示名称（必填） |
| `@version` | 版本号，用于更新检测 |
| `@match` | 脚本在哪些页面生效 |
| `@grant` | 声明需要使用的 API |
| `@updateURL` | 指向 `.meta.js` 文件，用于检查更新 |
| `@downloadURL` | 脚本实际下载地址 |

### 3.3 Step 2：提供 .meta.js 文件（可选，用于自动更新）

`.meta.js` 文件只包含 UserScript Header，不含代码本体：

```javascript
// ==UserScript==
// @name         My Awesome Script
// @version      1.0.1
// @namespace    http://tampermonkey.net/
// @match        https://example.com/*
// @updateURL    https://example.com/my-script.meta.js
// @downloadURL  https://example.com/my-script.user.js
// ==/UserScript==
```

Tampermonkey 会定期检查 `@updateURL` 中的版本号变化，发现新版本后提示用户更新。

### 3.4 Step 3：部署到 Web 服务器

确保服务器返回正确的 Content-Type：

| 文件类型 | Content-Type |
|----------|-------------|
| `.user.js` | `text/javascript` 或 `application/javascript` |
| `.meta.js` | `text/javascript` |

**Nginx 配置示例**：

```nginx
location ~* \.user\.js$ {
    add_header Content-Type application/javascript;
    # 允许跨域（如果从其他域名安装）
    add_header Access-Control-Allow-Origin *;
}
```

### 3.5 Step 4：触发安装

#### 方式 A：用户直接访问链接

用户直接点击或在地址栏输入：
```
https://example.com/my-script.user.js
```

#### 方式 B：通过现有脚本引导安装

```javascript
// 在已运行的 Tampermonkey 脚本中
const installUrl = 'https://example.com/my-script.user.js';

// 方法 1：直接跳转（当前页）
window.location.href = installUrl;

// 方法 2：新开标签页
GM_openInTab(installUrl, { active: true });

// 方法 3：创建按钮让用户点击
const btn = document.createElement('button');
btn.textContent = '安装新脚本';
btn.onclick = () => window.open(installUrl, '_blank');
document.body.appendChild(btn);
```

#### 方式 C：通过 Web 页面引导

在 HTML 页面中放置安装链接：

```html
<a href="https://example.com/my-script.user.js"
   onclick="return confirm('确定要安装此脚本吗？')">
   安装 Tampermonkey 脚本
</a>
```

### 3.6 注意事项与限制

| 限制项 | 说明 |
|--------|------|
| **无法静默安装** | 浏览器安全策略禁止，必须用户手动确认 |
| **无法编辑已有脚本** | 只能触发安装新脚本，不能修改已有脚本内容 |
| **同一脚本更新** | 需保持 `@name` 和 `@namespace` 一致，Tampermonkey 会识别为同一脚本 |
| **HTTPS 推荐** | 生产环境建议使用 HTTPS，避免混合内容拦截 |
| **CORS** | 如果从其他域名触发安装，确保目标 URL 允许跨域 |

---

## 方案二：浏览器策略 JSON 部署（Step by Step）

这是 Tampermonkey **官方支持的企业级部署方案**，通过浏览器原生策略机制在浏览器启动时自动导入脚本配置。适合 IT 管理员在组织内部批量部署。

### 4.1 适用场景

- 企业/学校内统一预装脚本
- 需要锁定脚本防止用户修改
- 批量更新/分发内部工具脚本

### 4.2 整体流程

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  准备脚本源码 │ → │ 生成 JSON 配置 │ → │ 配置浏览器策略 │
│  Base64 编码 │    │  计算 SHA256  │    │  Tampermonkey │
│              │    │   完整性哈希   │    │   自动导入    │
└──────────────┘    └──────────────┘    └──────────────┘
```

### 4.3 Step 1：准备脚本并编码

#### 1.1 准备你的 .user.js 文件

```javascript
// ==UserScript==
// @name     Internal Tool
// @version  1.0.0
// @match    https://internal.company.com/*
// @grant    none
// ==/UserScript==

console.log('内部工具脚本已加载');
```

#### 1.2 将脚本源码转为 Base64

**Linux/macOS 命令行**：
```bash
# 编码脚本文件
base64 -i my-script.user.js -o encoded.txt

# 或者直接输出
base64 my-script.user.js
```

**Python**：
```python
import base64

with open('my-script.user.js', 'rb') as f:
    encoded = base64.b64encode(f.read()).decode('utf-8')
    print(encoded)
```

**Node.js**：
```javascript
const fs = require('fs');
const source = fs.readFileSync('my-script.user.js', 'utf8');
const encoded = Buffer.from(source).toString('base64');
console.log(encoded);
```

### 4.4 Step 2：创建 Provisioning JSON 文件

创建一个名为 `tm-provisioning.json` 的文件：

```json
{
  "version": "1",
  "scripts": [
    {
      "name": "Internal Tool",
      "enabled": true,
      "position": 1,
      "uuid": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "source": "Ly8gPT1Vc2VyU2NyaXB0PT0KLy8gQG5hbWUg...",
      "requires": []
    }
  ],
  "settings": {
    "configMode": 100,
    "logLevel": 80
  }
}
```

**UUID 生成**（必须唯一且固定）：
```bash
# macOS/Linux
uuidgen

# 或 Python
python3 -c "import uuid; print(uuid.uuid4())"
```

> **重要**：同一 UUID 的脚本会被更新，不同 UUID 会创建新脚本。更新脚本时必须保持 UUID 不变。

### 4.5 Step 3：托管 JSON 文件并计算 Hash

#### 3.1 托管 JSON 文件

将 `tm-provisioning.json` 部署到 Web 服务器，确保可通过 URL 访问：
```
https://your-server.com/tampermonkey/tm-provisioning.json
```

**开发测试可用本地服务器**：
```bash
# Python 简易 HTTP 服务器
python3 -m http.server 12121

# 然后访问 http://localhost:12121/tm-provisioning.json
```

#### 3.2 计算 SHA256 Hash

Tampermonkey 要求使用 `1:<sha256>` 格式的完整性校验。

**Linux/macOS**：
```bash
sha256sum tm-provisioning.json
# 输出: abc123...def456  tm-provisioning.json

# 转换为 Tampermonkey 格式
HASH=$(sha256sum tm-provisioning.json | awk '{print $1}')
echo "1:$HASH"
```

**快捷方法**（让 Tampermonkey 帮你算）：
1. 先配置一个假的 hash（如 `1:abcd`）
2. 打开浏览器，查看 Tampermonkey 的错误日志
3. 日志会显示 `expected 1:abcd !== calculated 1:<真实hash>`
4. 复制 `calculated` 的值填入配置

### 4.6 Step 4：配置浏览器策略

#### 4.6.1 Firefox 配置

**Step A：找到 Firefox 安装目录**

| 操作系统 | policies.json 路径 |
|----------|-------------------|
| Windows | `C:\Program Files\Mozilla Firefox\distribution\policies.json` |
| macOS | `/Applications/Firefox.app/Contents/Resources/distribution/policies.json` |
| Linux | `/etc/firefox/policies/policies.json` |

> macOS 注意：需要右键 Firefox.app → "显示包内容" 进入 Contents/Resources

**Step B：创建 policies.json**

```json
{
  "policies": {
    "Extensions": {
      "Install": [
        "https://addons.mozilla.org/firefox/downloads/latest/tampermonkey/addon-13345290-latest.xpi"
      ]
    },
    "3rdparty": {
      "Extensions": {
        "firefox@tampermonkey.net": {
          "jsonImport": [
            {
              "hash": "1:66849534c66c5bd384f39f7fb5c7c5bdbc8611bfedab082762cb943f853637d0",
              "url": "https://your-server.com/tampermonkey/tm-provisioning.json",
              "haltOnError": false,
              "installAsSystemScripts": false
            }
          ]
        }
      }
    }
  }
}
```

**Firefox 扩展 ID 对照**：

| 版本 | Extension ID |
|------|-------------|
| Stable | `firefox@tampermonkey.net` |
| Beta | `firefoxbeta@tampermonkey.net` |

**Step C：重启 Firefox**

完全关闭 Firefox 后重新打开，Tampermonkey 会在启动时读取策略并导入脚本。

#### 4.6.2 Chrome / Edge / Chromium 配置（Linux）

**Step A：创建策略目录**

```bash
sudo mkdir -p /etc/opt/chrome/policies/managed/
```

> 对于 Edge：`/etc/opt/edge/policies/managed/`
> 对于 Chromium：`/etc/chromium/policies/managed/`

**Step B：创建策略文件**

```bash
sudo tee /etc/opt/chrome/policies/managed/tampermonkey.json << 'EOF'
{
  "ExtensionInstallForcelist": [
    "gcalenpjmijncebpfijmoaglllgpjagf"
  ],
  "3rdparty": {
    "extensions": {
      "gcalenpjmijncebpfijmoaglllgpjagf": {
        "jsonImport": [
          {
            "hash": "1:66849534c66c5bd384f39f7fb5c7c5bdbc8611bfedab082762cb943f853637d0",
            "url": "https://your-server.com/tampermonkey/tm-provisioning.json",
            "haltOnError": false,
            "installAsSystemScripts": false
          }
        ]
      }
    }
  }
}
EOF
```

**Chromium 扩展 ID**：`gcalenpjmijncebpfijmoaglllgpjagf`

**Step C：重启 Chrome**

```bash
# 完全关闭 Chrome 后重新打开
# 或者通过地址栏访问 chrome://policy 查看策略是否生效
```

#### 4.6.3 Chrome / Edge（Windows 注册表）

**Step A：创建 .reg 文件**

```reg
Windows Registry Editor Version 5.00

; 强制安装 Tampermonkey
[HKEY_LOCAL_MACHINE\Software\Policies\Google\Chrome\ExtensionInstallForcelist]
"1"="gcalenpjmijncebpfijmoaglllgpjagf"

; 3rd-party 扩展策略
[HKEY_LOCAL_MACHINE\Software\Policies\Google\Chrome\3rdparty\extensions\gcalenpjmijncebpfijmoaglllgpjagf\jsonImport\1]
"hash"="1:66849534c66c5bd384f39f7fb5c7c5bdbc8611bfedab082762cb943f853637d0"
"url"="https://your-server.com/tampermonkey/tm-provisioning.json"
"haltOnError"=dword:00000000
"installAsSystemScripts"=dword:00000000
```

**Step B：导入注册表**

双击 `.reg` 文件导入，或通过命令行：
```cmd
regedit.exe /s tampermonkey-policy.reg
```

**Step C：重启 Chrome**

访问 `chrome://policy` 查看策略是否已加载。

#### 4.6.4 Google Workspace / Chrome Enterprise（云端管理）

**Step A：进入 Admin Console**

https://admin.google.com → 设备 → Chrome → 应用和扩展程序

**Step B：添加 Tampermonkey 扩展**

1. 点击"添加" → "从 Chrome 网上应用店添加"
2. 搜索并选择 Tampermonkey
3. 设置安装政策为"强制安装"

**Step C：配置扩展策略**

在 Tampermonkey 的"政策配置"区域，输入 JSON（**注意 `Value` 包装器**）：

```json
{
  "jsonImport": {
    "Value": [
      {
        "hash": "1:66849534c66c5bd384f39f7fb5c7c5bdbc8611bfedab082762cb943f853637d0",
        "url": "https://your-server.com/tampermonkey/tm-provisioning.json",
        "haltOnError": false,
        "installAsSystemScripts": false
      }
    ]
  }
}
```

> **关键区别**：Google Admin Console 需要 `"Value": [...]` 包装器，本地 JSON 文件不需要。

### 4.7 Step 5：验证部署

#### 检查策略是否生效

| 浏览器 | 检查地址 |
|--------|----------|
| Chrome | `chrome://policy` |
| Edge | `edge://policy` |
| Firefox | `about:policies` |

#### 检查 Tampermonkey 日志

1. 打开 Tampermonkey 仪表板
2. 查看脚本列表，确认新脚本是否出现
3. 如有错误，检查浏览器开发者工具 → Console 中的 Tampermonkey 日志

### 4.8 更新脚本流程

```
1. 修改 .user.js 源码
        ↓
2. 重新生成 Base64 编码
        ↓
3. 更新 tm-provisioning.json（保持 UUID 不变，可改 version）
        ↓
4. 重新计算 SHA256 hash
        ↓
5. 更新浏览器策略中的 hash 值
        ↓
6. 重启浏览器（Chrome 策略通常会自动刷新，Firefox 需重启）
```

### 4.9 关键注意事项

| 事项 | 说明 |
|------|------|
| **版本要求** | Tampermonkey 5.5+ |
| **UUID 必须固定** | 更新脚本时不要修改 UUID，否则会被视为新脚本 |
| **删除脚本** | 从 JSON 中移除不会自动删除浏览器中的脚本，需手动清理 |
| **installAsSystemScripts** | `true` 时脚本只读（用户不可编辑），`false` 时用户可编辑 |
| **HTTPS 要求** | 生产环境必须使用 HTTPS + 有效证书 |
| **Hash 必须匹配** | hash 错误会导致导入失败，可通过 Tampermonkey 错误日志获取正确 hash |

---

## 方案对比

| 维度 | .user.js 链接安装 | 浏览器策略 JSON 部署 |
|------|-------------------|---------------------|
| **适用对象** | 个人用户、开发者 | 企业 IT 管理员 |
| **用户交互** | 需要手动确认安装 | 完全静默，自动部署 |
| **能否更新** | 通过 `@updateURL` 自动检测 | 更新 JSON 配置后重启生效 |
| **能否编辑** | 用户可自由编辑 | 取决于 `installAsSystemScripts` |
| **部署难度** | 简单（上传文件即可） | 复杂（需配置浏览器策略） |
| **批量部署** | 不方便 | 方便（通过策略统一分发） |
| **运行时动态添加** | 部分可行（引导用户点击） | 不可行（需重启浏览器） |
| **官方支持** | 原生支持 | 官方企业部署方案 |

---

## 参考链接

| 链接 | 说明 |
|------|------|
| https://www.tampermonkey.net/documentation.php?locale=en&q=deploying | 官方部署文档（Enterprise Deployment） |
| https://www.tampermonkey.net/documentation.php | 完整 API 文档 |
| https://www.tampermonkey.net/faq.php | 常见问题（含 Extension IDs） |
