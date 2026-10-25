# Tampermonkey 脚本管理 API 分析报告

> 分析目标：是否可以通过脚本/程序方式实现对 Tampermonkey 插件的脚本新增、编辑等操作。
>
> 原始链接：<https://www.tampermonkey.net/documentation.php?locale=en\&q=deploying>
>
> 分析日期：2026-10-25

---

## 核心结论

**Tampermonkey 官方没有提供运行时 JavaScript API 用于新增、编辑或删除用户脚本。**

官方文档中的 "Deploying" 部分描述的是**企业级部署配置机制**（通过浏览器策略和 JSON 配置文件进行集中式脚本分发），而非普通用户或脚本可调用的新增/编辑 API。

---

## 1. Tampermonkey 官方提供的 API 能力

Tampermonkey 的 `GM_*` / `TM_*` API 主要用于**已运行脚本**的功能扩展，不包含脚本生命周期管理。

| API                           | 功能            | 能否管理脚本 |
| ----------------------------- | ------------- | ------ |
| `GM_setValue` / `GM_getValue` | 脚本数据存储        | 不能     |
| `GM_xmlhttpRequest`           | 跨域网络请求        | 不能     |
| `GM_addStyle`                 | 动态添加 CSS      | 不能     |
| `GM_registerMenuCommand`      | 注册右键菜单        | 不能     |
| `GM_openInTab`                | 打开新标签页        | 不能     |
| `GM_notification`             | 桌面通知          | 不能     |
| `GM_webRequest`               | 拦截/修改 Web 请求  | 不能     |
| `GM_cookie`                   | Cookie 操作     | 不能     |
| `unsafeWindow`                | 访问页面原生 window | 不能     |

**完整 API 文档**：<https://www.tampermonkey.net/documentation.php>

---

## 2. 官方 "部署" 机制（Deploying）说明

这是官方文档中唯一涉及"批量脚本管理"的机制，但**仅适用于企业 IT 管理员通过浏览器策略配置**，不是普通用户可调用的 API。

### 2.1 机制原理

通过浏览器策略（Browser Policy）在浏览器启动时自动导入配置好的 JSON 文件，实现脚本的预安装或更新。

### 2.2 Provisioning JSON 格式

```json
{
  "version": "1",
  "scripts": [
    {
      "name": "Script Name",
      "enabled": true,
      "position": 1,
      "uuid": "4190fc63-64c8-4c68-9a7c-96f41f85729a",
      "source": "Ly8gPT1Vc2VyU2NyaXB0PT0KLy8gQG5hbWUg...",
      "requires": [
        {
          "meta": {
            "name": "jquery.min.js",
            "url": "https://code.jquery.com/jquery.min.js",
            "mimetype": "application/javascript"
          },
          "source": "Ly8ganF1ZXJ5IHN0dWIK..."
        }
      ]
    }
  ],
  "settings": {
    "configMode": 100,
    "logLevel": 80
  }
}
```

**字段说明**：

| 字段         | 类型      | 说明                    |
| ---------- | ------- | --------------------- |
| `name`     | string  | 脚本显示名称                |
| `enabled`  | boolean | 是否启用                  |
| `position` | integer | 执行优先级顺序               |
| `uuid`     | string  | 唯一标识符（关键字段，决定更新还是新建）  |
| `source`   | string  | **Base64 编码**的脚本源码    |
| `requires` | array   | 外部依赖库（含 Base64 编码的源码） |

### 2.3 浏览器策略配置

#### Firefox (policies.json)

```json
{
  "policies": {
    "3rdparty": {
      "Extensions": {
        "firefox@tampermonkey.net": {
          "jsonImport": [
            {
              "hash": "1:<sha256_hash>",
              "url": "https://example.com/tm.json",
              "haltOnError": true,
              "installAsSystemScripts": false
            }
          ]
        }
      }
    }
  }
}
```

#### Chromium (Linux 示例)

路径：`/etc/opt/chrome/policies/managed/tampermonkey.json`

```json
{
  "3rdparty": {
    "extensions": {
      "gcalenpjmijncebpfijmoaglllgpjagf": {
        "jsonImport": [
          {
            "hash": "1:<sha256_hash>",
            "url": "https://example.com/tm.json",
            "haltOnError": true,
            "installAsSystemScripts": false
          }
        ]
      }
    }
  }
}
```

#### 策略字段说明

| 字段                       | 必填 | 默认值     | 说明                                 |
| ------------------------ | -- | ------- | ---------------------------------- |
| `hash`                   | 是  | -       | 完整性校验，格式为 `1:<sha256>`             |
| `url`                    | 是  | -       | JSON 配置文件地址（生产环境需 HTTPS）           |
| `haltOnError`            | 否  | `false` | 出错时是否阻止 Tampermonkey 启动            |
| `installAsSystemScripts` | 否  | `true`  | `true` 为系统脚本（用户不可编辑），`false` 为普通脚本 |

### 2.4 关键限制

| 限制项         | 说明                                     |
| ----------- | -------------------------------------- |
| **版本要求**    | Tampermonkey 5.5+                      |
| **UUID 机制** | 相同 UUID 会更新脚本，不同 UUID 会创建新脚本           |
| **删除行为**    | 从 JSON 中移除脚本**不会**自动删除浏览器中的脚本，需手动清理    |
| **用户权限**    | `installAsSystemScripts: true` 时用户无法编辑 |
| **生产环境**    | URL 必须使用 HTTPS + 有效证书                  |

---

## 3. 替代方案（非官方）

如果需要在运行时动态管理脚本，官方未提供 API，但可考虑以下非官方/间接方式：

### 3.1 打开 Tampermonkey 编辑页面

可以通过 `GM_openInTab` 或 `window.open` 打开 Tampermonkey 的脚本编辑/安装页面：

```javascript
// 打开 Tampermonkey 仪表板
window.open('chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/options.html#nav=dashboard', '_blank');

// 注意：扩展 ID 因浏览器和 Tampermonkey 版本而异
```

### 3.2 通过 userscript 安装链接

Tampermonkey 支持通过 `.user.js` 链接触发安装提示：

```javascript
// 点击或通过 JS 导航到 .user.js URL 会触发 Tampermonkey 安装提示
window.location.href = 'https://example.com/my-script.user.js';
```

**限制**：这只能触发"安装新脚本"，无法编辑已有脚本。

### 3.3 通过浏览器扩展消息传递

如果同时开发浏览器扩展，可通过 `chrome.runtime.sendMessage` 与 Tampermonkey 通信，但这需要 Tampermonkey 暴露相应接口（目前未公开）。

### 3.4 直接操作 Tampermonkey 存储（不推荐）

Tampermonkey 使用浏览器扩展存储（如 IndexedDB/chrome.storage）保存脚本数据。理论上可通过浏览器扩展 API 访问，但：

- 存储格式未公开文档化
- 可能随版本变更而损坏
- 属于逆向工程，不推荐在生产环境使用

---

## 4. 总结对比表

| 需求      | 官方支持    | 方式                 | 限制              |
| ------- | ------- | ------------------ | --------------- |
| 运行时新增脚本 | 部分      | 导航到 `.user.js` URL | 只能触发安装弹窗，无法静默安装 |
| 运行时编辑脚本 | **不支持** | -                  | 无官方 API         |
| 运行时删除脚本 | **不支持** | -                  | 无官方 API         |
| 批量预部署脚本 | 支持      | 浏览器策略 + JSON       | 仅企业/IT 管理员可用    |
| 静默安装脚本  | **不支持** | -                  | 浏览器安全策略禁止       |
| 脚本间数据共享 | 支持      | `GM_setValue` + 监听 | 同一域名下可行         |

---

## 5. 参考链接

| 链接                                                                      | 说明                            |
| ----------------------------------------------------------------------- | ----------------------------- |
| <https://www.tampermonkey.net/documentation.php?locale=en\&q=deploying> | 官方部署文档（Enterprise Deployment） |
| <https://www.tampermonkey.net/documentation.php>                        | 完整 API 文档                     |
| <https://www.tampermonkey.net/faq.php>                                  | 常见问题（含 Extension IDs）         |

---

## 6. 建议

如果需要在运行时动态管理脚本，建议考虑以下架构调整：

1. **单脚本 + 动态加载**：编写一个主脚本，通过 `GM_xmlhttpRequest` 从远程服务器获取配置和模块代码，使用 `eval` 或 `new Function` 动态执行（注意安全风险）。
2. **使用独立扩展**：如果需要在运行时完全控制脚本生命周期，建议直接开发独立的浏览器扩展，而非依赖 Tampermonkey。
3. **浏览器策略部署**：如果是企业/组织内部需求，使用官方文档中的浏览器策略方式进行集中管理。
