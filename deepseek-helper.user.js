// ==UserScript==
// @name         DeepSeek 助手 - DeepSeek Helper
// @namespace    http://tampermonkey.net/
// @version      1.4.1
// @description  DeepSeek 聊天页面增强：布局密度（默认/紧凑/宽松，侧栏与消息区一起变）、聊天区加宽、会话一键静默删除、多关键词批量删除、双击复制
// @author       You
// @match        https://chat.deepseek.com/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/alphatok/monkey-script/main/deepseek-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/alphatok/monkey-script/main/deepseek-helper.user.js
// ==/UserScript==

(function () {
    'use strict';

    const DEBUG = true;
    const log = (...args) => DEBUG && console.log('[DeepSeek助手]', ...args);

    // 实测接口：POST /api/v0/chat_session/delete  body: {chat_session_ids: [id]}
    // 只需 authorization: Bearer <localStorage.userToken.value>，其余 x-client-* 头可省略
    const DELETE_API = '/api/v0/chat_session/delete';

    // 会话行就是 <a href="/a/chat/s/<uuid>">
    const ROW_SELECTOR = 'a[href*="/a/chat/s/"]';
    // 兜底属性（万一改版）
    const ID_ATTRS = ['data-session-id', 'data-chat-session-id', 'data-conversation-id'];
    const ID_SELECTOR = ID_ATTRS.map((a) => '[' + a + ']').join(', ');

    const batchState = { running: false, stop: false };

    // ========== 通用工具 ==========
    function randInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    async function sleepCancellable(ms) {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            if (batchState.stop) return;
            await new Promise((r) => setTimeout(r, Math.min(200, end - Date.now())));
        }
    }

    function showToast(msg) {
        const toast = document.createElement('div');
        toast.textContent = msg;
        toast.style.cssText = `
            position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
            background: rgba(0,0,0,0.78); color: #fff; padding: 8px 16px;
            border-radius: 6px; font-size: 14px; z-index: 999999;
            pointer-events: none; transition: opacity 0.3s;
        `;
        document.body.appendChild(toast);
        setTimeout(() => { toast.style.opacity = '0'; }, 1200);
        setTimeout(() => toast.remove(), 1600);
    }

    function getToken() {
        const pick = (raw) => {
            if (!raw) return null;
            if (raw.charAt(0) === '{') {
                try {
                    const j = JSON.parse(raw);
                    if (j && j.value) return j.value;
                } catch (e) { /* ignore */ }
                return null;
            }
            return raw.length > 20 ? raw : null;
        };

        try {
            const direct = pick(localStorage.getItem('userToken'));
            if (direct) return direct;

            // 兜底：扫其它带 token 的键（换登录方式时键名可能不同）
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (!/token/i.test(k)) continue;
                const v = pick(localStorage.getItem(k));
                if (v) return v;
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    // ========== 会话行识别 ==========
    function isSidebarRow(el) {
        if (el.closest('[class*="chat-message"], [class*="message-list"], [class*="markdown"]')) return false;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;     // 已隐藏的行自动排除
        if (rect.width > 420 || rect.height > 120) return false;
        return rect.left < window.innerWidth / 2;
    }

    function collectRows() {
        const set = new Set();

        document.querySelectorAll(ROW_SELECTOR).forEach((el) => {
            if (isSidebarRow(el)) set.add(el);
        });

        // 兜底：带会话 id 属性的元素（结构改版时仍有救）
        document.querySelectorAll(ID_SELECTOR).forEach((el) => {
            if (el.querySelector(ID_SELECTOR)) return;
            if (el.closest(ROW_SELECTOR)) return;
            if (isSidebarRow(el)) set.add(el);
        });

        return [...set];
    }

    function getSessionId(row) {
        // 1) 链接里的 uuid —— 实测最可靠
        const href = row.getAttribute && row.getAttribute('href');
        if (href) {
            const m = href.match(/\/a\/chat\/s\/([A-Za-z0-9_-]{8,})/);
            if (m) return m[1];
        }
        const link = row.querySelector && row.querySelector(ROW_SELECTOR);
        if (link) {
            const m = String(link.getAttribute('href') || '').match(/\/a\/chat\/s\/([A-Za-z0-9_-]{8,})/);
            if (m) return m[1];
        }
        // 2) 属性兜底
        for (const a of ID_ATTRS) {
            const v = row.getAttribute && row.getAttribute(a);
            if (v && /^[A-Za-z0-9_-]{8,}$/.test(v)) return v;
        }
        for (const a of ID_ATTRS) {
            const el = row.querySelector && row.querySelector('[' + a + ']');
            const v = el && el.getAttribute(a);
            if (v && /^[A-Za-z0-9_-]{8,}$/.test(v)) return v;
        }
        // 3) 当前打开的会话
        if (row.matches && row.matches('[aria-current="page"], [class*="active"], [class*="selected"]')) {
            const m = location.pathname.match(/\/s\/([A-Za-z0-9_-]{8,})/);
            if (m) return m[1];
        }
        return null;
    }

    // ========== 删除 ==========
    async function deleteSessions(ids) {
        const token = getToken();
        if (!token) {
            log('未取到 userToken，可能未登录');
            return false;
        }
        try {
            const res = await fetch(DELETE_API, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ chat_session_ids: ids })
            });
            const data = await res.json().catch(() => ({}));
            const bizCode = data && data.data ? data.data.biz_code : undefined;
            const ok = res.ok
                && data.code === 0
                && (bizCode === 0 || bizCode === undefined);
            log('删除结果:', res.status, JSON.stringify(data).substring(0, 160));
            return ok;
        } catch (e) {
            log('删除异常:', e.message);
            return false;
        }
    }

    // ========== 功能 1：悬停注入静默删除按钮 ==========
    function initHoverDelete() {
        const style = document.createElement('style');
        style.textContent = `
            /* 三点菜单按钮是绝对定位（right:4px, 宽 28），我们的按钮同样绝对定位到它左侧。
               注意：不能用 .ds-conv-row 这类自己加的 class 做选择器 —— React 重渲染会把
               className 覆盖回它自己的值，导致 hover 规则失效、X 永远不显示。 */
            .ds-del-btn {
                display: none;
                position: absolute;
                right: 34px; top: 50%;
                transform: translateY(-50%);
                align-items: center; justify-content: center;
                width: 22px; height: 22px; padding: 0;
                border: none; border-radius: 4px;
                background: transparent; color: #999;
                font-size: 15px; line-height: 1; cursor: pointer;
                z-index: 3;
                /* 关键：右侧操作区 _254829d 是 pointer-events:none，
                   不显式打开的话真实鼠标点不到这个按钮 */
                pointer-events: auto;
            }
            .ds-del-btn:hover { color: #ff4d4f; background: rgba(255,77,79,0.12); }
            a[href*="/a/chat/s/"]:hover .ds-del-btn { display: flex; }
        `;
        document.head.appendChild(style);

        const injectAll = () => {
            for (const row of collectRows()) {
                if (row.querySelector('.ds-del-btn')) continue;   // 已注入（含被 React 重建后补注入）

                const btn = document.createElement('button');
                btn.className = 'ds-del-btn';
                btn.textContent = '×';
                btn.title = '删除会话';

                // 优先塞进右侧操作区（跟随其 hover 显隐），否则挂到行上
                const menuBtns = row.querySelectorAll('[role="button"]');
                const menu = menuBtns.length ? menuBtns[menuBtns.length - 1] : null;

                if (menu && menu.parentElement) {
                    menu.parentElement.appendChild(btn);
                } else {
                    row.appendChild(btn);
                }

                // 捕获阶段拦截，阻止链接跳转 / 三点菜单弹出
                ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick'].forEach((type) => {
                    btn.addEventListener(type, (e) => {
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        e.preventDefault();
                        if (type === 'click') handleDeleteClick(row, btn);
                    }, true);
                });
            }
        };

        let scheduled = false;
        new MutationObserver(() => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => { scheduled = false; injectAll(); });
        }).observe(document.body, { childList: true, subtree: true });

        injectAll();
        log('悬停删除已启用');
    }

    async function handleDeleteClick(row, btn) {
        const id = getSessionId(row);
        if (!id) {
            showToast('无法获取会话 ID');
            console.warn('[DeepSeek助手] 未取到会话 id，行 HTML：', row.outerHTML.substring(0, 800));
            return;
        }
        if (!getToken()) {
            showToast('未登录或 token 读取失败');
            return;
        }

        // React 可能已把原来的 <a> 换掉，按 href 重新定位当前真实节点
        const live = document.querySelector('a[href*="/a/chat/s/' + id + '"]') || row;

        btn.disabled = true;
        live.style.opacity = '0.4';
        const ok = await deleteSessions([id]);
        if (ok) {
            live.style.opacity = '';
            live.style.display = 'none';   // 不 remove，避免 React 卸载时报错
            showToast('已删除');
        } else {
            live.style.opacity = '';
            btn.disabled = false;
            showToast('删除失败');
        }
    }

    // ========== 功能 2：双击复制消息 ==========
    function initCopyOnDblclick() {
        document.addEventListener('dblclick', (e) => {
            const bubble = e.target.closest('[class*="markdown"], [class*="message"]');
            if (!bubble) return;
            const text = bubble.innerText;
            if (!text) return;
            navigator.clipboard.writeText(text).then(() => showToast('已复制'));
        });
        log('双击复制已启用');
    }

    // ========== 设置面板：悬浮球 + 多 Tab ==========
    // 布局密度直接改站点自己的尺寸变量，不碰 DOM：
    //   --sider-width                      左侧会话列表宽度（原生 261px）
    //   --message-list-padding-horizontal  正文左右内边距（原生 44px）
    // 消息之间的垂直间距没有变量，用站点自己的消息行类名 ._4f9bf79 和
    // .ds-markdown 的段落 margin 覆盖（前者是构建哈希，改版后失效只会回到原样）。
    const SETTINGS_KEY = 'dsh-helper.settings.v1';
    const LEGACY_WIDE_KEY = 'dsh-helper.wide.v1';
    const DENSITY_LIST = ['default', 'compact', 'loose'];

    // 默认「紧凑」：站点原生的消息间距和侧栏宽度都偏松
    const DEFAULTS = { wide: true, width: 0, density: 'compact' };

    // 加宽：width = 0 表示自动（原生 ×1.5）
    const WIDE_SCALE = 1.5;
    const WIDE_STEP = 40;
    // 加宽后左右各留的空白，避免贴到侧栏 / 窗口边缘
    const WIDE_GAP = 64;

    let settings = loadSettings();
    let panelEl = null;
    let closeTimer = null;
    let wideScroller = null;
    let wideRO = null;

    const GEAR_SVG = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor"'
        + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
        + '<circle cx="12" cy="12" r="3"></circle>'
        + '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33'
        + ' 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06'
        + 'a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65'
        + ' 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9'
        + 'a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0'
        + ' 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65'
        + ' 0 0 0-1.51 1z"></path></svg>';

    const CSS = `
        /* ========== 布局密度 ========== */
        /* 侧栏宽度、正文左右内边距站点都用变量控制，直接改变量即可 */
        html.dsh-density-compact {
            --sider-width: 220px;
            --message-list-padding-horizontal: 28px;
        }
        html.dsh-density-loose {
            --sider-width: 300px;
            --message-list-padding-horizontal: 56px;
        }

        /* 左侧会话列表：行高 40 → 32，侧栏内边距 12 → 8，跟着密度一起变 */
        html.dsh-density-compact .b8812f16 { padding: 4px 8px 0; }
        html.dsh-density-compact ._546d736 {
            height: 32px; padding: 5px 6px 5px 8px; border-radius: 10px;
        }
        html.dsh-density-compact ._2afd28d { padding: 3px 2px 3px 4px; }

        html.dsh-density-loose .b8812f16 { padding: 8px 16px 0; }
        html.dsh-density-loose ._546d736 {
            height: 46px; padding: 12px 6px 12px 10px;
        }

        /* 垂直节奏：站点正文是 16px/28px，段落间距 16px，紧凑档一起收一收 */
        html.dsh-density-compact .ds-markdown { line-height: 24px; }
        html.dsh-density-compact .ds-markdown .ds-markdown-paragraph { margin: 8px 0; }
        html.dsh-density-compact .ds-markdown ul,
        html.dsh-density-compact .ds-markdown ol { margin: 8px 0; }
        html.dsh-density-compact .ds-markdown h1,
        html.dsh-density-compact .ds-markdown h2,
        html.dsh-density-compact .ds-markdown h3 { margin: 16px 0 8px; }
        html.dsh-density-compact .ds-markdown h4,
        html.dsh-density-compact .ds-markdown h5,
        html.dsh-density-compact .ds-markdown h6 { margin: 8px 0; }
        html.dsh-density-compact .ds-markdown pre,
        html.dsh-density-compact .ds-markdown .md-code-block { margin: 8px 0; }
        html.dsh-density-compact .ds-markdown blockquote { margin: 8px 0 0; }
        html.dsh-density-compact .ds-markdown li:not(:first-child) { margin-top: 2px; }
        html.dsh-density-compact .ds-assistant-message-main-content { padding-bottom: 2px; }
        html.dsh-density-compact ._74c0879 + .ds-assistant-message-main-content { margin-top: 4px; }

        html.dsh-density-loose .ds-markdown { line-height: 32px; }
        html.dsh-density-loose .ds-markdown .ds-markdown-paragraph { margin: 20px 0; }
        html.dsh-density-loose .ds-markdown ul,
        html.dsh-density-loose .ds-markdown ol { margin: 20px 0; }
        html.dsh-density-loose .ds-assistant-message-main-content { padding-bottom: 10px; }
        html.dsh-density-loose ._74c0879 + .ds-assistant-message-main-content { margin-top: 16px; }

        /* ========== 聊天区加宽 ========== */
        html.dsh-wide {
            --message-list-max-width: var(--dsh-width, 840px);
        }
        /* 新对话页的居中容器把 840px 写死了，跟变量无关，顺手一起放宽 */
        html.dsh-wide ._9a2f8e4 {
            max-width: var(--dsh-width, 840px);
        }

        /* ========== 悬浮球 & 面板 ========== */
        #ds-ui, #ds-ui * { box-sizing: border-box; }
        #ds-ui {
            position: fixed; right: 20px; bottom: 96px; z-index: 2147483647;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
            font-size: 13px; line-height: 1.4; text-align: left; color: #333;
        }
        #ds-btn {
            width: 46px; height: 46px; padding: 0; border-radius: 50%; cursor: pointer;
            border: none; background: #4d6bfe; color: #fff;
            display: flex; align-items: center; justify-content: center;
            box-shadow: 0 2px 10px rgba(0,0,0,.22);
            transition: transform .2s ease, background .15s;
        }
        #ds-btn:hover { background: #3f59d9; transform: rotate(45deg); }
        #ds-btn svg { display: block; }

        #ds-panel {
            position: absolute; right: 0; bottom: 56px; width: 272px;
            display: none; background: #fff; border: 1px solid rgba(0,0,0,.08);
            border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.16);
            overflow: hidden;
        }
        #ds-panel.ds-open { display: block; }

        #ds-ui .ds-tabs {
            display: flex; gap: 2px; padding: 6px;
            border-bottom: 1px solid rgba(0,0,0,.06);
        }
        #ds-ui .ds-tab {
            flex: 1; padding: 6px 0; border: none; border-radius: 7px; cursor: pointer;
            background: transparent; color: #666; font: inherit; font-size: 12.5px;
        }
        #ds-ui .ds-tab:hover { background: rgba(0,0,0,.04); }
        #ds-ui .ds-tab.ds-active { background: #eef1ff; color: #4d6bfe; font-weight: 600; }

        #ds-ui .ds-pane { padding: 6px; max-height: 62vh; overflow-y: auto; }
        #ds-ui .ds-pane[hidden] { display: none; }

        #ds-ui .ds-row {
            display: flex; align-items: center; justify-content: space-between; gap: 10px;
            padding: 7px 8px; border-radius: 8px; font-size: 12.5px;
        }
        #ds-ui .ds-row[data-k] { cursor: pointer; user-select: none; }
        #ds-ui .ds-row[data-k]:hover { background: rgba(0,0,0,.04); }
        #ds-ui .ds-row--input { padding: 2px 8px 8px; gap: 6px; }

        #ds-ui .ds-sw {
            position: relative; flex: 0 0 auto; width: 32px; height: 18px;
            border-radius: 999px; background: #d9d9d9; transition: background .15s;
        }
        #ds-ui .ds-sw::after {
            content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
            border-radius: 50%; background: #fff; transition: transform .15s;
            box-shadow: 0 1px 2px rgba(0,0,0,.15);
        }
        #ds-ui .ds-row.ds-on .ds-sw { background: #4d6bfe; }
        #ds-ui .ds-row.ds-on .ds-sw::after { transform: translateX(14px); }

        #ds-ui .ds-seg {
            display: flex; gap: 2px; padding: 2px; background: #f4f5f7; border-radius: 8px;
        }
        #ds-ui .ds-seg button {
            padding: 3px 8px; border: none; border-radius: 6px; cursor: pointer;
            background: transparent; color: #666; font: inherit; font-size: 12px;
        }
        #ds-ui .ds-seg button:hover { color: #333; }
        #ds-ui .ds-seg button.ds-active {
            background: #fff; color: #4d6bfe; font-weight: 600;
            box-shadow: 0 1px 3px rgba(0,0,0,.12);
        }

        #ds-ui .ds-stepper { display: flex; align-items: center; gap: 4px; }
        #ds-ui .ds-stepper button {
            width: 22px; height: 22px; padding: 0; border-radius: 6px; cursor: pointer;
            border: 1px solid rgba(0,0,0,.1); background: #f7f7f7; color: #333;
            font-size: 14px; line-height: 1; font-family: inherit;
        }
        #ds-ui .ds-stepper button:hover { background: #efefef; }
        #ds-ui .ds-stepper button:disabled { opacity: .35; cursor: not-allowed; }
        #ds-ui .ds-stepper b {
            min-width: 52px; text-align: center; font-weight: 600; font-size: 12px; color: #4d6bfe;
        }
        #ds-ui .ds-auto {
            display: none; margin-left: 4px; padding: 0 3px; font-style: normal; font-size: 10px;
            line-height: 14px; color: #4d6bfe; border: 1px solid currentColor; border-radius: 3px;
        }
        #ds-ui .ds-auto.ds-show { display: inline-block; }
        #ds-ui .ds-tip {
            padding: 6px 8px 4px; font-size: 11px; color: #999;
            border-top: 1px solid rgba(0,0,0,.06); margin-top: 4px;
        }

        /* ========== 批删 tab ========== */
        #ds-ui .ds-kw-list { display: flex; flex-wrap: wrap; gap: 5px; margin: 2px 0 8px; }
        #ds-ui .ds-kw-chip {
            display: inline-flex; align-items: center; gap: 2px;
            padding: 2px 3px 2px 8px; border-radius: 11px;
            background: #eef1ff; color: #4d6bfe; border: 1px solid #c9d2ff;
            font-size: 12px; line-height: 1.5; cursor: pointer; user-select: none;
        }
        #ds-ui .ds-kw-chip.off {
            background: #f4f4f4; color: #aaa; border-color: #e2e2e2; text-decoration: line-through;
        }
        #ds-ui .ds-kw-del {
            width: 15px; height: 15px; padding: 0; line-height: 1;
            border: none; background: transparent; color: inherit;
            font-size: 13px; cursor: pointer; border-radius: 50%; opacity: .6;
        }
        #ds-ui .ds-kw-del:hover { background: rgba(0,0,0,.08); opacity: 1; }
        #ds-ui .ds-kw-input {
            flex: 1; min-width: 0; padding: 3px 6px; font-size: 12px;
            border: 1px solid #ddd; border-radius: 4px; outline: none; font-family: inherit;
        }
        #ds-ui .ds-kw-input:focus { border-color: #4d6bfe; }
        #ds-ui .ds-kw-add {
            flex-shrink: 0; padding: 3px 8px; font-size: 12px;
            border: 1px solid #4d6bfe; background: #fff; color: #4d6bfe;
            border-radius: 4px; cursor: pointer; font-family: inherit;
        }
        #ds-ui .ds-kw-add:hover { background: #4d6bfe; color: #fff; }

        #ds-ui .ds-inline { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #666; }
        #ds-ui .ds-inline input {
            width: 46px; padding: 3px 5px; font-size: 12px; text-align: center;
            border: 1px solid #ddd; border-radius: 4px; outline: none; font-family: inherit;
        }
        #ds-ui .ds-inline input:focus { border-color: #4d6bfe; }

        #ds-ui .ds-batch-status {
            margin: 6px 0; padding: 6px 8px; font-size: 12px;
            background: #f6f6f6; border-radius: 5px; color: #666;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        #ds-ui .ds-batch-run {
            width: 100%; padding: 8px; border: none; border-radius: 6px;
            background: #4d6bfe; color: #fff; font-size: 13px; cursor: pointer; font-family: inherit;
        }
        #ds-ui .ds-batch-run:hover { background: #3f59d9; }
        #ds-ui .ds-batch-run.running { background: #ff4d4f; }
        #ds-ui .ds-batch-run.running:hover { background: #e63f41; }
    `;

    function injectCSS() {
        if (document.getElementById('ds-style')) return;
        const style = document.createElement('style');
        style.id = 'ds-style';
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);
    }

    // ========== 设置读写 ==========
    function loadSettings() {
        let saved = {};
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (raw) {
                saved = JSON.parse(raw) || {};
            } else {
                // 兼容只有加宽设置的老版本
                const legacy = localStorage.getItem(LEGACY_WIDE_KEY);
                if (legacy) saved = JSON.parse(legacy) || {};
            }
        } catch (e) {
            saved = {};
        }
        const s = Object.assign({}, DEFAULTS, saved);
        if (DENSITY_LIST.indexOf(s.density) < 0) s.density = DEFAULTS.density;
        return s;
    }

    function saveSettings() {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (e) { /* 忽略隐私模式写入失败 */ }
    }

    // ========== 宽度计算 ==========
    // 站点原生宽度（跟着断点走，见 CSS 里的 :root 声明）
    function nativeMaxWidth() {
        return window.innerWidth >= 1024 ? 840 : 712;
    }

    // 消息列表滚动容器由站点自己把宽度写进 --dsl-virtual-list-width，
    // 拿它当「可用宽度」，侧栏展开/收起都能跟着变。
    function findScroller() {
        const el = document.querySelector('[style*="--dsl-virtual-list-width"]');
        return el && el.clientWidth > 0 ? el : null;
    }

    function mainAreaWidth() {
        const el = findScroller();
        if (el) return el.clientWidth;
        // 兜底：按侧栏展开（261px）估算，宁可窄一点也不要撑出屏幕
        return Math.max(320, window.innerWidth - 300);
    }

    // 加宽上限：不超过主区域宽度，也不低于原生宽度（窄屏时保持原样）
    function wideCap() {
        const raw = Math.floor((mainAreaWidth() - WIDE_GAP) / WIDE_STEP) * WIDE_STEP;
        return Math.max(nativeMaxWidth(), raw);
    }

    function autoWidth() {
        return Math.min(Math.round(nativeMaxWidth() * WIDE_SCALE), wideCap());
    }

    function effectiveWidth() {
        if (!settings.width) return autoWidth();
        const n = Math.round(Number(settings.width) / WIDE_STEP) * WIDE_STEP;
        if (!isFinite(n)) return autoWidth();
        return Math.min(wideCap(), Math.max(nativeMaxWidth(), n));
    }

    // 侧栏展开 / 收起、密度切换都会改变可用宽度，跟着重算一次上限
    function observeScroller() {
        const el = findScroller();
        if (el === wideScroller) return;
        if (wideRO) { wideRO.disconnect(); wideRO = null; }
        wideScroller = el;
        if (!el || typeof ResizeObserver === 'undefined') return;
        wideRO = new ResizeObserver(() => apply());
        wideRO.observe(el);
    }

    // ========== 应用状态 ==========
    // 密度和宽度都落在 <html> 的 class / 变量上，CSS 只做声明式覆盖，
    // 调设置不需要重建样式表，也不会被 React 重渲染冲掉。
    function apply() {
        const html = document.documentElement;
        if (!html) return;
        observeScroller();

        html.classList.toggle('dsh-wide', !!settings.wide);
        html.classList.toggle('dsh-density-compact', settings.density === 'compact');
        html.classList.toggle('dsh-density-loose', settings.density === 'loose');

        const w = effectiveWidth() + 'px';
        if (html.style.getPropertyValue('--dsh-width') !== w) {
            html.style.setProperty('--dsh-width', w);
        }
        syncUI();
    }

    function setSetting(key, value) {
        settings[key] = value;
        saveSettings();
        apply();
    }

    function toggleWide() {
        setSetting('wide', !settings.wide);
        showToast(settings.wide
            ? `聊天区已加宽（${effectiveWidth()}px）`
            : '聊天区已恢复原宽');
    }

    // 点 ± 后从「自动」切换成手动宽度
    function stepWide(dir) {
        const cur = effectiveWidth();
        const next = Math.min(wideCap(), Math.max(nativeMaxWidth(), cur + dir * WIDE_STEP));
        if (next === cur) return;
        settings.wide = true;
        settings.width = next;
        saveSettings();
        apply();
        showToast(`聊天区宽度 ${next}px`);
    }

    const DENSITY_LABEL = { default: '默认', compact: '紧凑', loose: '宽松' };

    function setDensity(name) {
        if (DENSITY_LIST.indexOf(name) < 0 || settings.density === name) return;
        setSetting('density', name);
        showToast(`布局密度：${DENSITY_LABEL[name]}`);
    }

    // ========== 悬浮面板 ==========
    function openPanel() {
        clearTimeout(closeTimer);
        if (panelEl) panelEl.classList.add('ds-open');
    }

    function closePanel(delay) {
        clearTimeout(closeTimer);
        closeTimer = setTimeout(() => {
            if (batchState.running) return;   // 批删进行中保持展开
            if (panelEl) panelEl.classList.remove('ds-open');
        }, delay || 0);
    }

    function switchTab(name) {
        if (!panelEl) return;
        panelEl.querySelectorAll('.ds-tab').forEach((t) => {
            t.classList.toggle('ds-active', t.getAttribute('data-tab') === name);
        });
        panelEl.querySelectorAll('.ds-pane').forEach((p) => {
            p.hidden = p.getAttribute('data-pane') !== name;
        });
    }

    // ========== 功能 3：批量删除 ==========
    const batchKeywords = [
        { text: '科技', on: true },
        { text: '摘要', on: true }
    ];

    function getBatchKeywords() {
        return batchKeywords.filter((k) => k.on).map((k) => k.text);
    }

    function addBatchKeyword(text) {
        const t = String(text || '').trim();
        if (!t) return false;
        if (batchKeywords.some((k) => k.text === t)) return false;
        batchKeywords.push({ text: t, on: true });
        return true;
    }

    function findBatchTargets() {
        const kws = getBatchKeywords().map((k) => k.toLowerCase());
        if (!kws.length) return [];
        const out = [];
        for (const row of collectRows()) {
            const text = (row.innerText || row.textContent || '')
                .replace(/\s+/g, '').toLowerCase();
            if (kws.every((k) => text.includes(k))) out.push(row);
        }
        return out;
    }

    function buildBatchPane() {
        const statusEl = panelEl.querySelector('.ds-batch-status');
        const runBtn = panelEl.querySelector('.ds-batch-run');
        const limitEl = panelEl.querySelector('.ds-limit');
        const minEl = panelEl.querySelector('.ds-min');
        const maxEl = panelEl.querySelector('.ds-max');
        const kwListEl = panelEl.querySelector('.ds-kw-list');
        const kwInputEl = panelEl.querySelector('.ds-kw-input');

        const setStatus = (text, tip) => {
            if (statusEl.textContent !== text) statusEl.textContent = text;
            if (tip !== undefined) statusEl.title = tip;
        };

        const refresh = () => {
            if (batchState.running) return;
            const targets = findBatchTargets();
            const tip = targets.slice(0, 5)
                .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim().substring(0, 40))
                .join('\n');
            setStatus(`匹配 ${targets.length} 个会话`, tip);
        };

        const renderKeywords = () => {
            kwListEl.innerHTML = '';
            for (const kw of batchKeywords) {
                const chip = document.createElement('span');
                chip.className = 'ds-kw-chip' + (kw.on ? '' : ' off');
                chip.title = kw.on ? '点击停用' : '点击启用';

                const text = document.createElement('span');
                text.textContent = kw.text;
                chip.appendChild(text);

                const del = document.createElement('button');
                del.className = 'ds-kw-del';
                del.textContent = '×';
                del.title = '移除关键词';
                chip.appendChild(del);

                chip.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (e.target === del) {
                        const i = batchKeywords.indexOf(kw);
                        if (i >= 0) batchKeywords.splice(i, 1);
                    } else {
                        kw.on = !kw.on;
                    }
                    renderKeywords();
                    refresh();
                });

                kwListEl.appendChild(chip);
            }
        };

        const submitKeyword = () => {
            const v = kwInputEl.value;
            if (!addBatchKeyword(v)) {
                if (v.trim()) showToast('关键词已存在');
                return;
            }
            kwInputEl.value = '';
            renderKeywords();
            refresh();
        };

        panelEl.querySelector('.ds-kw-add').addEventListener('click', (e) => {
            e.stopPropagation();
            submitKeyword();
        });
        kwInputEl.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                e.preventDefault();
                submitKeyword();
            }
        });

        [limitEl, minEl, maxEl].forEach((el) => el.addEventListener('change', refresh));

        runBtn.addEventListener('click', () => {
            if (batchState.running) {
                batchState.stop = true;
                setStatus('正在停止…');
                return;
            }
            openPanel();
            runBatchDelete({ limitEl, minEl, maxEl, runBtn, setStatus });
        });

        renderKeywords();
        refresh();

        let pending = false;
        new MutationObserver(() => {
            if (pending) return;
            pending = true;
            requestAnimationFrame(() => { pending = false; refresh(); });
        }).observe(document.body, { childList: true, subtree: true });
    }

    async function runBatchDelete({ limitEl, minEl, maxEl, runBtn, setStatus }) {
        const limit = Math.min(100, Math.max(1, parseInt(limitEl.value, 10) || 10));
        const minGap = Math.max(1, parseInt(minEl.value, 10) || 2);
        const maxGap = Math.max(minGap, parseInt(maxEl.value, 10) || 5);

        const skipped = new WeakSet();
        let done = 0;

        batchState.running = true;
        batchState.stop = false;
        runBtn.textContent = '停止';
        runBtn.classList.add('running');
        openPanel();

        try {
            while (!batchState.stop && done < limit) {
                const targets = findBatchTargets().filter((el) => !skipped.has(el));
                if (!targets.length) break;

                const row = targets[0];
                const id = getSessionId(row);
                if (!id) {
                    skipped.add(row);
                    log('跳过无 id 的会话行');
                    continue;
                }

                setStatus(`正在删除 ${done + 1}/${limit}…`);
                const ok = await deleteSessions([id]);
                if (!ok) {
                    setStatus(`删除失败，已停止（成功 ${done} 个）`);
                    break;
                }

                // React 可能已替换节点，按 href 重新定位
                const live = document.querySelector('a[href*="/a/chat/s/' + id + '"]') || row;
                live.style.opacity = '';
                live.style.display = 'none';
                done++;
                setStatus(`已删除 ${done}/${limit}`);

                if (done < limit && !batchState.stop) {
                    const gap = randInt(minGap, maxGap);
                    setStatus(`已删除 ${done}/${limit}，${gap}s 后继续…`);
                    await sleepCancellable(gap * 1000);
                }
            }
        } catch (e) {
            log('批量删除异常:', e.message);
            setStatus(`异常中断：${e.message}`);
        } finally {
            batchState.running = false;
            batchState.stop = false;
            runBtn.textContent = '开始批量删除';
            runBtn.classList.remove('running');
            if (done > 0) showToast(`批量删除完成：${done} 个`);
        }
    }

    // ========== 面板构建 ==========
    function initSettingsUI() {
        if (document.getElementById('ds-ui')) return;

        const root = document.createElement('div');
        root.id = 'ds-ui';
        root.innerHTML = `
            <div id="ds-panel">
                <div class="ds-tabs">
                    <button type="button" class="ds-tab ds-active" data-tab="layout">布局</button>
                    <button type="button" class="ds-tab" data-tab="batch">批删</button>
                </div>

                <div class="ds-pane" data-pane="layout">
                    <div class="ds-row">
                        <span>布局密度</span>
                        <span class="ds-seg">
                            <button type="button" data-density="default">默认</button>
                            <button type="button" data-density="compact">紧凑</button>
                            <button type="button" data-density="loose">宽松</button>
                        </span>
                    </div>
                    <div class="ds-row" data-k="wide"><span>聊天区加宽</span><i class="ds-sw"></i></div>
                    <div class="ds-row">
                        <span>宽度<i class="ds-auto">自动</i></span>
                        <span class="ds-stepper">
                            <button type="button" data-step="-1" title="变窄">−</button>
                            <b data-val>0px</b>
                            <button type="button" data-step="1" title="变宽">+</button>
                        </span>
                    </div>
                    <div class="ds-tip">Alt + W 快速切换加宽</div>
                </div>

                <div class="ds-pane" data-pane="batch" hidden>
                    <div class="ds-kw-list"></div>
                    <div class="ds-row ds-row--input">
                        <input type="text" class="ds-kw-input" placeholder="添加关键词，回车确认">
                        <button type="button" class="ds-kw-add">添加</button>
                    </div>
                    <div class="ds-row">
                        <span>最近</span>
                        <span class="ds-inline">
                            <input type="number" class="ds-limit" value="10" min="1" max="100"><span>个</span>
                        </span>
                    </div>
                    <div class="ds-row">
                        <span>间隔</span>
                        <span class="ds-inline">
                            <input type="number" class="ds-min" value="2" min="1" max="60"><span>-</span>
                            <input type="number" class="ds-max" value="5" min="1" max="60"><span>秒</span>
                        </span>
                    </div>
                    <div class="ds-batch-status">匹配 0 个</div>
                    <button type="button" class="ds-batch-run">开始批量删除</button>
                </div>
            </div>
            <button type="button" id="ds-btn" title="DeepSeek 助手设置">${GEAR_SVG}</button>
        `;

        // 挂到 <html> 上，避免被 React 重渲染清掉
        document.documentElement.appendChild(root);
        panelEl = root.querySelector('#ds-panel');

        // 鼠标移入展开，移出收起（留 300ms 缓冲，方便移到面板上）
        root.addEventListener('mouseenter', () => openPanel());
        root.addEventListener('mouseleave', () => closePanel(300));

        root.querySelector('#ds-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            if (panelEl.classList.contains('ds-open')) closePanel();
            else openPanel();
        });

        root.querySelectorAll('.ds-tab').forEach((tab) => {
            tab.addEventListener('click', (e) => {
                e.stopPropagation();
                switchTab(tab.getAttribute('data-tab'));
            });
        });

        panelEl.addEventListener('click', (e) => {
            const densityBtn = e.target.closest('[data-density]');
            if (densityBtn) {
                e.stopPropagation();
                setDensity(densityBtn.getAttribute('data-density'));
                return;
            }
            const stepBtn = e.target.closest('button[data-step]');
            if (stepBtn) {
                e.stopPropagation();
                stepWide(Number(stepBtn.getAttribute('data-step')));
                return;
            }
            const row = e.target.closest('.ds-row[data-k]');
            if (!row) return;
            e.stopPropagation();
            toggleWide();
        });

        buildBatchPane();
        syncUI();
    }

    function syncUI() {
        if (!panelEl) return;
        const w = effectiveWidth();

        panelEl.querySelectorAll('.ds-row[data-k]').forEach((row) => {
            row.classList.toggle('ds-on', !!settings[row.getAttribute('data-k')]);
        });
        panelEl.querySelectorAll('[data-density]').forEach((btn) => {
            btn.classList.toggle('ds-active', btn.getAttribute('data-density') === settings.density);
        });

        const val = panelEl.querySelector('[data-val]');
        if (val) val.textContent = w + 'px';

        const autoTag = panelEl.querySelector('.ds-auto');
        if (autoTag) autoTag.classList.toggle('ds-show', !settings.width);

        const minus = panelEl.querySelector('button[data-step="-1"]');
        const plus = panelEl.querySelector('button[data-step="1"]');
        if (minus) minus.disabled = w <= nativeMaxWidth();
        if (plus) plus.disabled = w >= wideCap();

        const btn = document.getElementById('ds-btn');
        if (btn) {
            btn.title = settings.wide
                ? `DeepSeek 助手设置：聊天区已加宽至 ${w}px（Alt+W 切换）`
                : 'DeepSeek 助手设置：点击加宽聊天区（Alt+W）';
        }
    }

    // ========== 快捷键 ==========
    function initShortcut() {
        document.addEventListener('keydown', (e) => {
            if (!e.altKey || e.ctrlKey || e.metaKey) return;
            if (e.code !== 'KeyW' && e.key.toLowerCase() !== 'w') return;
            e.preventDefault();
            e.stopPropagation();
            toggleWide();
        }, true);
    }

    // ========== 诊断：控制台执行 dsDump() ==========
    function installDiagnostics() {
        window.dsDump = function () {
            const rows = collectRows();
            console.table(rows.map((el, i) => ({
                '#': i,
                tag: el.tagName,
                class: String(el.className || '').substring(0, 40),
                id: getSessionId(el),
                href: (el.getAttribute && el.getAttribute('href') || '').substring(0, 40),
                text: (el.innerText || '').replace(/\s+/g, ' ').substring(0, 30)
            })));
            console.log('[DeepSeek助手] 识别行数:', rows.length,
                '| 登录:', !!getToken(),
                '| 链接总数:', document.querySelectorAll(ROW_SELECTOR).length);
            return rows.length;
        };
    }

    // ========== 启动 ==========
    function bootstrap() {
        if (window.__deepseekHelperLoaded) return;
        window.__deepseekHelperLoaded = true;
        console.log('[DeepSeek助手] v1.4.1 已加载');

        initHoverDelete();
        initCopyOnDblclick();
        initSettingsUI();
        initShortcut();
        installDiagnostics();

        window.addEventListener('resize', apply);
        // 聊天页是异步挂载的，滚动容器出现后再补算一次上限
        [600, 1500, 3000].forEach((t) => setTimeout(apply, t));
        apply();
        log('已启用，密度：' + settings.density + '，宽度：' + effectiveWidth() + 'px');
    }

    // 样式和状态类要在首屏渲染前就位，否则会先看到原生布局再跳变
    injectCSS();
    if (document.documentElement) apply();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }
})();
