# Tampermonkey 脚本管理 API 分析报告

> 分析目标：是否可以通过脚本/程序方式实现对 Tampermonkey 插件的脚本新增、编辑等操作。
>
> 原始链接：<https://www.tampermonkey.net/documentation.php?locale=en\\\&q=deploying>
>
> 分析日期：2026-10-25
>
> 补充：2026-11-07 增加第 6 节，对 Chrome 商店正式包 **Tampermonkey 5.5.1（Manifest V3）** 做静态探测，核对运行时 API 与全部插件设置项。

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
| 脚本间数据共享 | 部分      | 同一脚本内跨标签：`GM_setValue` + `GM_addValueChangeListener` | 存储按脚本隔离，脚本之间互相读不到 |

---

## 5. 参考链接

| 链接                                                                        | 说明                            |
| ------------------------------------------------------------------------- | ----------------------------- |
| <https://www.tampermonkey.net/documentation.php?locale=en\\\&q=deploying> | 官方部署文档（Enterprise Deployment） |
| <https://www.tampermonkey.net/documentation.php>                          | 完整 API 文档                     |
| <https://www.tampermonkey.net/faq.php>                                    | 常见问题（含 Extension IDs）         |
| <https://clients2.google.com/service/update2/crx?response=redirect&prodversion=131.0&acceptformat=crx2,crx3&x=id%3Ddhdgffkkebhmkfjojejmpbldmpobfkfo%26uc> | 商店分发 CRX 直链（第 6 节静态探测用） |

---

## 6. 实测：5.5.1 的本地能力与插件设置项

> 前面几节基于官方文档。本节直接对 Chrome 商店分发的正式包做静态探测，回答「脚本在本地到底能做什么、能不能改插件自己的设置」。

### 6.1 探测方法

```bash
# 直接拉商店分发的 CRX（当前为 5.5.1 / Manifest V3）
curl -sSL -o tm.crx \
  "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=131.0&acceptformat=crx2,crx3&x=id%3Ddhdgffkkebhmkfjojejmpbldmpobfkfo%26uc"

unzip -q tm.crx -d tm-ext
# 关键文件：manifest.json / background.js / schema.json / _locales/en/messages.json
```

### 6.2 扩展实际权限（manifest.json）

```text
version: 5.5.1, manifest_version: 3, background: service_worker

permissions: notifications, unlimitedStorage, tabs, idle, webNavigation,
             webRequest, webRequestBlocking, storage, contextMenus,
             clipboardWrite, cookies, alarms, scripting, userScripts,
             declarativeNetRequestWithHostAccess, offscreen, chrome://favicon/
optional_permissions: downloads        # 首次 GM_download 时才申请
host_permissions: <all_urls>
```

这组权限就是脚本能力的**天花板**：可联网、可读写 Cookie、可拦截请求、可写剪贴板、可弹系统通知；**没有** `fileSystem` / `nativeMessaging` / `management` / `debugger`。

### 6.3 运行时 API 全表（从实现代码提取）

`GM_*`（同步风格）与 `GM.*`（Promise 风格）两套命名空间同时存在，实现里出现的完整列表：

```text
GM_addElement GM_addStyle GM_addValueChangeListener GM_audio GM_cookie
GM_deleteValue GM_deleteValues GM_download GM_getResourceText GM_getResourceURL
GM_getTab GM_getTabs GM_getValue GM_getValues GM_info GM_listValues GM_log
GM_notification GM_openInTab GM_registerMenuCommand GM_removeValueChangeListener
GM_saveTab GM_setClipboard GM_setValue GM_setValues GM_unregisterMenuCommand
GM_webRequest GM_xmlhttpRequest
```

| 类别 | API | 能力与前置条件 |
| --- | --- | --- |
| 存储 | `GM_setValue` / `getValue` / `deleteValue` / `listValues`，批量版 `GM_setValues` / `getValues` / `deleteValues` | 按脚本隔离、**跨网站共享**（不是按域名），`unlimitedStorage`；可在面板 Storage 页查看、编辑、导出 |
| 存储事件 | `GM_addValueChangeListener` / `GM_removeValueChangeListener` | 跨标签页同步，适合「设置改了其他标签立即生效」 |
| 跨标签 | `GM_getTab` / `GM_saveTab` / `GM_getTabs` | 同一脚本在多标签之间共享一个对象 |
| 网络 | `GM_xmlhttpRequest` / `GM.xmlHttpRequest` | 跨域请求，受 `@connect` 白名单约束，`<all_urls>` 已具备 |
| 请求拦截 | `GM_webRequest` | 拦截 / 阻断 / 重定向 / 改请求头；**需 Config mode = Advanced**，改头还要开「Allow headers to be modified」 |
| Cookie | `GM_cookie`（list / set / delete） | 需设置里打开「Script cookies access」（Advanced 模式下可见） |
| 下载 | `GM_download` | 单向落盘到下载目录，支持 `saveAs` / `headers` / `onprogress`；首次触发时申请 `downloads` 可选权限 |
| 剪贴板 | `GM_setClipboard` | **只写不读**（仅 `clipboardWrite`），读剪贴板无 API |
| 通知 | `GM_notification` | 系统级通知，支持按钮与点击回调 |
| 标签页 | `GM_openInTab` | 新标签 / 新窗口，可设 active、insert |
| 样式 / 节点 | `GM_addStyle`、`GM_addElement` | 注入 CSS / 创建元素，绕过页面 CSP |
| 资源 | `GM_getResourceText` / `GM_getResourceURL` | 读取 `@resource` 打包进来的文件，可转 blob URL |
| 菜单 | `GM_registerMenuCommand` / `GM_unregisterMenuCommand` | 在扩展图标菜单里加命令；**这是唯一能改变插件交互的入口** |
| 信息 | `GM_info` | 脚本元数据、TM 版本、脚本是否将更新 |
| 日志 | `GM_log` | 输出到 TM 控制台 |
| 内部 | `GM.backgroundControl`、`GM_audio` | 非公开用途，不建议依赖 |

补充：

- 具体注入哪些 API 由 `@grant` 决定；`@grant none` 时脚本跑在页面上下文，`GM_*` 全部不可用，`unsafeWindow` 也就没有意义。
- 脚本之间**无法互相读取存储**，想共享只能借页面 `window` 或自建服务。

### 6.4 插件设置项清单（从 background.js 提取到 76 项）

| 分组 | 设置项 |
| --- | --- |
| 常规 | `configMode`（Novice 0 / Beginner 50 / **Advanced 100**）、`i18n`、`logLevel`、`trash_mode`、`tags_enabled`、`tags` |
| 同步 | `sync_enabled`、`sync_type`、`cloud_url`、`cloud_user`、`cloud_pass`、`run_sync` |
| 外观 | `layout`、`layout_user_css`、`notification_showUpdate`、`favicon_service`、`appearance_badges`、`appearance_badge_color` |
| 菜单 | `context_menu_enabled`、`context_menu_scripts`、`context_menu_commands`、`action_menu_scripts_hide_disabled`、`action_menu_columns`、`action_menu_scripts_sort`、`userscript_search_mode` |
| 编辑器 | `editor_enabled`、`editor_theme`、`editor_fontSize`、`editor_keyMap`、`editor_indentUnit`、`editor_tabSize`、`editor_indentWithTabs`、`editor_tabMode`、`editor_autoSave`、`editor_easySave`、`editor_autoLint`、`editor_linter_config` 等 |
| 脚本更新 | `scriptUpdateCheckPeriod`、`scriptUpdateAutomaticInstall`、`scriptUpdateCheckDisabled`、`scriptUpdateHideNotificationAfter`、`notification_silentScriptUpdate`、`external_update_interval`、`run_script_updates` |
| 运行环境 | `sandbox_mode`、`runtime_run_in`、`runtime_content_mode`、`runtime_strict_mode`、`runtime_top_level_await` |
| 安全 / 权限 | `script_file_access`（本地文件）、`script_cookie_access`（Cookie）、`connect_mode`（跨域确认）、`external_connect`、`require_sri_mode`、`webrequest_fixCSP`、`webrequest_fixContentCSP`、`webrequest_modHeaders` |
| 页面过滤 | `page_filter_mode`、`page_whitelist`、`forbiddenPages`、`script_include_mode`、`script_blacklist_type`、`require_blacklist` |
| 其他 | `incognito_mode`、`scriptUrlDetection`、`script_templates`、`missing_host_permissions`、`reset_simple`（重启 TM）、`reset_factory`（恢复出厂） |

另外 `schema.json` 只有一个 `jsonImport` 字段，证实**设置可导出 / 导入 JSON**，格式与第 2 节的部署配置一致（`hash` / `url` / `haltOnError` / `installAsSystemScripts`）。

### 6.5 能力边界

| 需求 | 能否做到 | 说明 |
| --- | --- | --- |
| 读写脚本自己的配置 | ✅ | `GM_setValue` 系列，跨站持久 |
| 改插件设置（配置模式、编辑器、同步…） | ❌ | 无任何 API；只能人手动点 UI |
| 改 / 删其他脚本的存储 | ❌ | 存储按脚本隔离 |
| 新增 / 编辑 / 删除脚本 | ❌ | 见第 1、2 节结论 |
| 读写任意本地文件 | ❌ | 只能 `GM_download` 单向写出；读文件需 `file://` + 用户开「允许访问文件网址」+ 开本地文件访问 |
| 调用系统命令 / 启动 App / 原生消息 | ❌ | 无 `nativeMessaging` |
| 使用 `chrome.*` 扩展 API | ❌ | MV3 `userScripts` 世界隔离，拿不到 `chrome.storage` / `chrome.tabs` |
| 跨域请求 | ✅ | `GM_xmlhttpRequest`，受 `@connect` 与 `connect_mode` 约束 |
| 拦截 / 改写网络请求 | ⚠️ | `GM_webRequest`，需 Advanced 配置模式 |
| 读写 Cookie | ⚠️ | `GM_cookie`，需打开 Script cookies access |
| 桌面通知 / 剪贴板写入 | ✅ | `GM_notification` / `GM_setClipboard` |
| 多标签共享状态 | ✅ | `GM_getTab` / `GM_saveTab` / `GM_getTabs` + value change 监听 |

### 6.6 对本仓库脚本的启示

1. **全局字体与颜色脚本**（`global-font-helper.user.js`）已经用到最关键的组合：`GM_setValue` 做跨站持久化 + `GM_registerMenuCommand` 做切换，方向正确。
2. 还能白捡的能力：`GM_download`（一键导出当前配置 JSON）、`GM_notification`（切换后系统提示）、`GM_addValueChangeListener`（多标签同时开时配置实时同步）。
3. `GM_setValue` 是**跨站共用**的，若要做「每个网站不同字体」，得自己在 value 里按 `location.host` 分组存储。
4. 需要请求拦截、Cookie 之类的「半隐藏」能力时，先提示用户在设置里把 Config mode 切到 Advanced，否则调了也没效果。

---

## 7. 建议

如果需要在运行时动态管理脚本，建议考虑以下架构调整：

1. **单脚本 + 动态加载**：编写一个主脚本，通过 `GM_xmlhttpRequest` 从远程服务器获取配置和模块代码，使用 `eval` 或 `new Function` 动态执行（注意安全风险）。
2. **使用独立扩展**：如果需要在运行时完全控制脚本生命周期，建议直接开发独立的浏览器扩展，而非依赖 Tampermonkey。
3. **浏览器策略部署**：如果是企业/组织内部需求，使用官方文档中的浏览器策略方式进行集中管理。
