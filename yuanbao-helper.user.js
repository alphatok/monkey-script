// ==UserScript==
// @name         元宝助手 - Yuanbao Helper
// @namespace    http://tampermonkey.net/
// @version      1.5.0
// @description  腾讯元宝聊天页面增强：布局密度（默认/紧凑/宽松）、聊天区加宽、快捷键发送、自动聚焦、界面精简、会话一键删除
// @author       You
// @match        https://yuanbao.tencent.com/chat/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/alphatok/monkey-script/main/yuanbao-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/alphatok/monkey-script/main/yuanbao-helper.user.js
// ==/UserScript==

(function () {
    'use strict';

    const DEBUG = true;
    const log = (...args) => DEBUG && console.log('[元宝助手]', ...args);

    // 保护新建会话
    let lastNewChatTime = 0;
    const NEW_CHAT_PROTECT_MS = 30000;

    // 真实删除 API（从页面 webpack 模块 6231 deleteAgentHistory 抓取）
    const DELETE_API = '/api/user/agent/conversation/v1/clear';

    // 元宝不同列表（最近 / 分组 / 收藏）用的属性名不完全一致，全部兼容
    const CONV_ID_ATTRS = [
        'data-conversation-id', 'data-conv-id', 'data-cid', 'dt-cid'
    ];
    const CONV_SELECTOR = CONV_ID_ATTRS.map((a) => '[' + a + ']').join(', ');

    // ========== 功能 1：快捷键发送消息 ==========
    function initShortcutSend() {
        document.addEventListener('keydown', (e) => {
            const isInput = e.target.tagName === 'TEXTAREA'
                || e.target.contentEditable === 'true';
            if (!isInput) return;
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                clickSendButton();
            }
        }, true);
        log('快捷键发送已启用');
    }

    function clickSendButton() {
        // 实际 DOM: <div id="yuanbao-send-btn" aria-label="Send">
        const btn = document.getElementById('yuanbao-send-btn')
            || document.querySelector('[aria-label="发送"]')
            || document.querySelector('[aria-label="Send"]')
            || document.querySelector('[class*="SendButton"]');
        if (!btn) {
            log('未找到发送按钮');
            return;
        }
        const cls = String(btn.className || '');
        if (cls.includes('disabled') || btn.getAttribute('aria-disabled') === 'true') {
            log('发送按钮禁用中');
            return;
        }
        btn.click();
        log('已触发发送');
    }

    // ========== 功能 2：自动聚焦输入框 ==========
    function initAutoFocus() {
        const tryFocus = () => {
            // 用户正在操作悬浮面板时不要抢焦点
            const active = document.activeElement;
            if (active && active.closest && active.closest('.yh-batch')) return;

            const input = findInputBox();
            if (input && document.activeElement !== input) {
                input.focus();
            }
        };
        setTimeout(tryFocus, 800);
        const observer = new MutationObserver(() => setTimeout(tryFocus, 100));
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function findInputBox() {
        return document.querySelector('textarea[placeholder]')
            || document.querySelector('[contenteditable="true"]')
            || document.querySelector('textarea');
    }

    // ========== 功能 3：精简界面 ==========
    function initCleanUI() {
        const style = document.createElement('style');
        style.textContent = `
            [class*="download"],
            [class*="pc-download"],
            a[href*="download"] {
                display: none !important;
            }
        `;
        document.head.appendChild(style);
        log('界面精简已应用');
    }

    // ========== 功能 4：双击消息复制内容 ==========
    function initCopyOnDblclick() {
        document.addEventListener('dblclick', (e) => {
            const bubble = e.target.closest('[class*="message"]')
                || e.target.closest('[class*="bubble"]');
            if (!bubble) return;
            const text = bubble.innerText;
            if (text) {
                navigator.clipboard.writeText(text).then(() => showToast('已复制'));
            }
        });
        log('双击复制已启用');
    }

    // ========== 功能 5：默认进入临时会话（尊重用户手动取消） ==========
    function initAutoTempSession() {
        const LS_KEY = 'yh_user_disabled_temp';

        function detectUserCancelTemp() {
            const isTemp = new URL(location.href).searchParams.get('chatMode') === 'temp';
            const wasTemp = sessionStorage.getItem('yh_last_was_temp') === '1';
            if (wasTemp && !isTemp) {
                localStorage.setItem(LS_KEY, '1');
                log('用户手动取消临时会话，记住偏好');
            }
            sessionStorage.setItem('yh_last_was_temp', isTemp ? '1' : '0');
        }

        detectUserCancelTemp();
        const userDisabled = localStorage.getItem(LS_KEY) === '1';
        if (userDisabled) log('用户已禁用自动临时会话');

        const tryEnterTemp = () => {
            if (localStorage.getItem(LS_KEY) === '1') return;
            if (new URL(location.href).searchParams.get('chatMode') === 'temp') return;
            const tempBtn = document.querySelector('[aria-label="Enter Temporary Chat"]');
            if (tempBtn) {
                tempBtn.click();
                log('已进入临时会话');
            }
        };

        setTimeout(tryEnterTemp, 1000);

        let lastUrl = location.href;
        const urlObserver = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                detectUserCancelTemp();
                setTimeout(tryEnterTemp, 500);
            }
        });
        urlObserver.observe(document.body, { childList: true, subtree: true });

        // 拦截新建对话，改为临时会话
        document.addEventListener('click', (e) => {
            if (localStorage.getItem(LS_KEY) === '1') return;
            const target = e.target.closest('.yb-new-chat-entry__item')
                || e.target.closest('[aria-label="New Chat"]');
            if (!target) return;
            const url = new URL(location.href);
            if (url.searchParams.get('chatMode') !== 'temp') {
                e.preventDefault();
                e.stopPropagation();
                url.searchParams.set('chatMode', 'temp');
                location.href = url.toString();
            }
        }, true);

        log('自动临时会话已启用');
    }

    // ========== 功能 6：会话列表注入删除按钮（含 Group 分组） ==========
    function initHoverDelete() {
        const style = document.createElement('style');
        style.textContent = `
            .yh-conv-item { position: relative !important; }
            .yh-delete-btn {
                display: none !important;
                align-items: center;
                justify-content: center;
                width: 22px;
                height: 22px;
                margin-right: 2px;
                padding: 0;
                background: transparent;
                border: none;
                border-radius: 4px;
                color: #999;
                cursor: pointer;
                font-size: 16px;
                line-height: 1;
                flex-shrink: 0;
                position: relative;
                z-index: 2;
                transition: color 0.15s, background 0.15s;
            }
            .yh-delete-btn:hover {
                color: #ff4d4f;
                background: rgba(255,77,79,0.12);
            }
            .yb-recent-conv-list__item:hover .yh-delete-btn,
            .yh-conv-item:hover .yh-delete-btn {
                display: inline-flex !important;
            }
            /* 结构未知的 Group 行：绝对定位，放在三点按钮左侧，避免遮挡 */
            .yh-delete-btn--abs {
                position: absolute !important;
                right: 26px;
                top: 50%;
                transform: translateY(-50%);
                margin: 0;
                z-index: 3;
            }
        `;
        document.head.appendChild(style);

        const injectAll = () => {
            for (const item of collectConvItems()) {
                if (item.dataset.__yhDeleteInjected) continue;
                item.dataset.__yhDeleteInjected = '1';
                item.classList.add('yh-conv-item');

                const delBtn = document.createElement('button');
                delBtn.className = 'yh-delete-btn';
                delBtn.textContent = '×';
                delBtn.title = '删除会话';

                // 优先插到标题后面（普通列表 + 多数分组项）
                const nameEl = item.querySelector('.yb-recent-conv-list__item-name')
                    || item.querySelector('[class*="item-name"]')
                    || item.querySelector('[class*="conv-name"]')
                    || item.querySelector('[class*="title"]');

                if (nameEl && nameEl.parentElement) {
                    nameEl.parentElement.insertBefore(delBtn, nameEl.nextSibling);
                } else {
                    // 结构未知：绝对定位到右侧，不参与流式布局
                    delBtn.classList.add('yh-delete-btn--abs');
                    item.appendChild(delBtn);
                }

                // 关键：在捕获阶段拦截所有指针事件，阻止冒泡到会话项触发下拉菜单
                ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick'].forEach((type) => {
                    delBtn.addEventListener(type, (e) => {
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        e.preventDefault();
                        if (type === 'click') deleteSession(item);
                    }, true);
                });

                log('已注入删除按钮');
            }
        };

        // rAF 节流：SPA 里 DOM 变动极频繁，避免每次变动都全量扫描 + 触发重排
        let scheduled = false;
        const observer = new MutationObserver(() => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => { scheduled = false; injectAll(); });
        });

        observer.observe(document.body, { childList: true, subtree: true });
        injectAll();
        log('删除按钮注入已启用');
    }

    // 收集所有会话行：普通最近列表 + Group 分组 + 弹层/portal 里的分组列表
    const LISTISH = /conv|group|session|history|recent|chat-item/i;

    function isListRow(el) {
        // 排除聊天正文
        if (el.closest('[class*="chat-content"], [class*="message-list"], [class*="agent-chat"]')) {
            return false;
        }
        // 1) class 命中 conv/group/session 之类
        let node = el;
        for (let i = 0; i < 4 && node; i++, node = node.parentElement) {
            if (LISTISH.test(String(node.className || ''))) return true;
        }
        // 2) 几何兜底：窄行 + 位于左半屏（分组弹层的 class 未必带 group）
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.width <= 420 && rect.height > 0 && rect.height <= 120
            && rect.left < window.innerWidth / 2) {
            return true;
        }
        return false;
    }

    function collectConvItems() {
        const set = new Set();

        // 1) 左侧导航区：已知列表项 + 任何带会话 id 的最内层元素
        const nav = document.querySelector('.yb-nav__content') || document.querySelector('.yb-nav');
        if (nav) {
            nav.querySelectorAll('.yb-recent-conv-list__item').forEach((el) => set.add(el));
            nav.querySelectorAll(CONV_SELECTOR).forEach((el) => {
                if (el.closest('.yb-recent-conv-list__item')) return;  // 已被上一行覆盖
                if (el.querySelector(CONV_SELECTOR)) return;           // 只取最内层
                set.add(el);
            });
        }

        // 2) 全文档兜底：Group 分组可能被渲染到 portal，不在 nav 内
        document.querySelectorAll(CONV_SELECTOR).forEach((el) => {
            if (el.closest('.yb-recent-conv-list__item')) return;
            if (el.querySelector(CONV_SELECTOR)) return;
            if (el.closest('[class*="chat-content"], [class*="message-list"], [class*="agent-chat"]')) return;
            if (!isListRow(el)) return;
            set.add(el);
        });

        return [...set];
    }

    // ========== 功能 7：直接调用删除 API ==========
    function getConvId(item) {
        for (const attr of CONV_ID_ATTRS) {
            const v = item.getAttribute && item.getAttribute(attr);
            if (v) return v;
        }
        for (const attr of CONV_ID_ATTRS) {
            const inner = item.querySelector && item.querySelector('[' + attr + ']');
            const v = inner && inner.getAttribute(attr);
            if (v) return v;
        }
        return null;
    }

    function getWebpackRequire() {
        const chunks = window.webpackChunk_N_E;
        if (!chunks) return null;
        let reqFn = null;
        const id = '__yh_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
        try {
            chunks.push([[id], {}, function (r) { reqFn = r; }]);
            const idx = chunks.findIndex(c => c && c[0] && c[0][0] === id);
            if (idx >= 0) chunks.splice(idx, 1);
        } catch (e) {
            log('获取 webpack require 失败:', e.message);
        }
        return reqFn;
    }

    async function deleteConvById(convId) {
        // 优先：调用页面内部的 deleteAgentHistory（自动带上 token 等公共参数）
        const req = getWebpackRequire();
        if (req) {
            try {
                const mod = req(6231);
                if (mod && typeof mod.deleteAgentHistory === 'function') {
                    await mod.deleteAgentHistory({
                        conversationIds: [convId],
                        uiOptions: { noToast: true }
                    });
                    log('已通过 deleteAgentHistory 删除:', convId);
                    return true;
                }
            } catch (e) {
                log('deleteAgentHistory 失败，回退 fetch:', e.message);
            }
        }

        // 回退：直接 fetch 真实 API
        try {
            const res = await fetch(DELETE_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    conversationIds: [convId],
                    uiOptions: { noToast: true }
                })
            });
            const data = await res.json().catch(() => ({}));
            const ok = res.ok && (data.code === 0 || data.code === undefined);
            log('fetch 删除结果:', res.status, JSON.stringify(data).substring(0, 120));
            return ok;
        } catch (e) {
            log('fetch 删除异常:', e.message);
            return false;
        }
    }

    async function deleteSession(item) {
        if (isProtectedSession(item)) {
            showToast('新建会话受保护，已跳过');
            return;
        }

        const convId = getConvId(item);
        if (!convId) {
            showToast('无法获取会话 ID');
            log('未找到 convId，item HTML:', item.outerHTML.substring(0, 300));
            return;
        }

        log('准备删除会话:', convId);
        item.style.opacity = '0.4';

        const ok = await deleteConvById(convId);
        if (ok) {
            item.remove();
            showToast('已删除');
        } else {
            item.style.opacity = '';
            showToast('删除失败，请重试');
        }
    }

    function isProtectedSession(item) {
        if (Date.now() - lastNewChatTime >= NEW_CHAT_PROTECT_MS) return false;
        return item.classList.contains('active')
            || item.classList.contains('selected')
            || item.getAttribute('aria-selected') === 'true';
    }

    // ========== 功能 8：监听新建对话 ==========
    function initNewChatProtection() {
        document.addEventListener('click', (e) => {
            const target = e.target.closest('.yb-new-chat-entry__item')
                || e.target.closest('[aria-label="New Chat"]');
            if (!target) return;
            lastNewChatTime = Date.now();
            log('新建对话，启动 30s 保护');
        }, true);
    }

    // ========== 设置面板：悬浮球 + 多 Tab ==========
    // 元宝的布局尺寸都收在几个 CSS 变量 / 类上，密度档位只改变量，不碰 DOM：
    //   .yb-nav__content-wrapper{width:254px}          左侧会话列表宽度（JS 还写了内联宽度）
    //   .yb-nav--push.yb-nav--open ~ .yb-layout__content{margin-left:254px}
    //   --chat-content-padding-x:50px                  消息行左右内边距
    //   --hunyuan-chat-list-max-width:880px            聊天区 / 输入框最大宽度
    const SETTINGS_KEY = 'yb-helper.settings.v1';
    const DENSITY_LIST = ['default', 'compact', 'loose'];

    // 默认「紧凑」：站点原生的侧栏和消息间距都偏松
    const DEFAULTS = { wide: true, width: 0, density: 'compact' };

    const WIDE_STEP = 40;
    const WIDE_GAP = 40;
    // 站点原生聊天区宽度（.agent-dialogue__content--common--main-pc）
    const NATIVE_MAX = 880;

    const SIDER = { compact: 220, loose: 290 };
    const PAD_X = { compact: 32, loose: 64 };
    const ROW_H = { compact: 28, loose: 40 };

    let settings = loadSettings();
    let panelEl = null;
    let closeTimer = null;

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
        html.yb-density-compact .yb-nav__content-wrapper { width: ${SIDER.compact}px !important; }
        html.yb-density-compact .yb-nav--push.yb-nav--open ~ .yb-layout__content,
        html.yb-density-compact .yb-nav--push.yb-nav--open ~ .yb-layout__content-skeleton { margin-left: ${SIDER.compact}px; }
        html.yb-density-compact .agent-dialogue__content--common--main-pc { --chat-content-padding-x: ${PAD_X.compact}px; }
        html.yb-density-compact .yb-recent-conv-list--new-framework .yb-recent-conv-list__item { height: ${ROW_H.compact}px; }
        html.yb-density-compact .yb-recent-conv-list--new-framework .yb-recent-conv-list__item-name {
            padding-top: 4px; padding-bottom: 4px;
        }
        /* 消息之间的垂直间距：只有 common-new 布局原生气泡带 32px margin，common 布局没有，别乱加 */
        html.yb-density-compact .agent-dialogue__content--common-new .agent-chat__list__item .agent-chat__bubble__avatar {
            margin-bottom: 18px;
        }
        /* 正文排版：原生 line-height 1.7 / 段落 16px / 列表项 10px */
        html.yb-density-compact .hyc-common-markdown-style p,
        html.yb-density-compact .hyc-common-markdown-style .ybc-p {
            line-height: 1.55; margin-top: 8px; margin-bottom: 8px;
        }
        html.yb-density-compact .hyc-common-markdown-style ul,
        html.yb-density-compact .hyc-common-markdown-style ol { margin-top: 8px; margin-bottom: 8px; }
        html.yb-density-compact .hyc-common-markdown-style li { margin-bottom: 4px; }
        html.yb-density-compact .hyc-common-markdown-style h3,
        html.yb-density-compact .hyc-common-markdown-style h4,
        html.yb-density-compact .hyc-common-markdown-style h5,
        html.yb-density-compact .hyc-common-markdown-style h6 { margin-top: 12px; margin-bottom: 8px; }
        html.yb-density-compact .hyc-common-markdown-style blockquote { margin-top: 8px; margin-bottom: 8px; }
        html.yb-density-compact .hyc-common-markdown-style .hyc-common-markdown__img {
            margin-top: 8px; margin-bottom: 8px;
        }

        html.yb-density-loose .yb-nav__content-wrapper { width: ${SIDER.loose}px !important; }
        html.yb-density-loose .yb-nav--push.yb-nav--open ~ .yb-layout__content,
        html.yb-density-loose .yb-nav--push.yb-nav--open ~ .yb-layout__content-skeleton { margin-left: ${SIDER.loose}px; }
        html.yb-density-loose .agent-dialogue__content--common--main-pc { --chat-content-padding-x: ${PAD_X.loose}px; }
        html.yb-density-loose .yb-recent-conv-list--new-framework .yb-recent-conv-list__item { height: ${ROW_H.loose}px; }
        html.yb-density-loose .agent-dialogue__content--common-new .agent-chat__list__item .agent-chat__bubble__avatar {
            margin-bottom: 44px;
        }
        html.yb-density-loose .hyc-common-markdown-style p,
        html.yb-density-loose .hyc-common-markdown-style .ybc-p {
            line-height: 1.9; margin-top: 20px; margin-bottom: 20px;
        }
        html.yb-density-loose .hyc-common-markdown-style ul,
        html.yb-density-loose .hyc-common-markdown-style ol { margin-top: 20px; margin-bottom: 20px; }
        html.yb-density-loose .hyc-common-markdown-style li { margin-bottom: 12px; }

        /* ========== 聊天区加宽 ========== */
        /* 聊天列表和输入框都吃这一个变量，输入框宽度是 calc 出来的，会自动跟着变 */
        html.yb-wide .agent-dialogue__content--common--main-pc {
            --hunyuan-chat-list-max-width: var(--yb-width, ${NATIVE_MAX}px);
        }

        /* ========== 悬浮球 & 面板 ========== */
        #yh-ui, #yh-ui * { box-sizing: border-box; }
        #yh-ui {
            position: fixed; right: 20px; bottom: 96px; z-index: 2147483647;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
            font-size: 13px; line-height: 1.4; text-align: left; color: #333;
        }
        #yh-btn {
            width: 46px; height: 46px; padding: 0; border-radius: 50%; cursor: pointer;
            border: none; background: #07c160; color: #fff;
            display: flex; align-items: center; justify-content: center;
            box-shadow: 0 2px 10px rgba(0,0,0,.22);
            transition: transform .2s ease, background .15s;
        }
        #yh-btn:hover { background: #06ad56; transform: rotate(45deg); }
        #yh-btn svg { display: block; }

        #yh-panel {
            position: absolute; right: 0; bottom: 56px; width: 272px;
            display: none; background: #fff; border: 1px solid rgba(0,0,0,.08);
            border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.16);
            overflow: hidden;
        }
        #yh-panel.yh-open { display: block; }

        #yh-ui .yh-tabs {
            display: flex; gap: 2px; padding: 6px;
            border-bottom: 1px solid rgba(0,0,0,.06);
        }
        #yh-ui .yh-tab {
            flex: 1; padding: 6px 0; border: none; border-radius: 7px; cursor: pointer;
            background: transparent; color: #666; font: inherit; font-size: 12.5px;
        }
        #yh-ui .yh-tab:hover { background: rgba(0,0,0,.04); }
        #yh-ui .yh-tab.yh-active { background: #e8f8ef; color: #07a352; font-weight: 600; }

        #yh-ui .yh-pane { padding: 6px; max-height: 62vh; overflow-y: auto; }
        #yh-ui .yh-pane[hidden] { display: none; }

        #yh-ui .yh-row {
            display: flex; align-items: center; justify-content: space-between; gap: 10px;
            padding: 7px 8px; border-radius: 8px; font-size: 12.5px;
        }
        #yh-ui .yh-row[data-k] { cursor: pointer; user-select: none; }
        #yh-ui .yh-row[data-k]:hover { background: rgba(0,0,0,.04); }
        #yh-ui .yh-row--input { padding: 2px 8px 8px; gap: 6px; }

        #yh-ui .yh-sw {
            position: relative; flex: 0 0 auto; width: 32px; height: 18px;
            border-radius: 999px; background: #d9d9d9; transition: background .15s;
        }
        #yh-ui .yh-sw::after {
            content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
            border-radius: 50%; background: #fff; transition: transform .15s;
            box-shadow: 0 1px 2px rgba(0,0,0,.15);
        }
        #yh-ui .yh-row.yh-on .yh-sw { background: #07c160; }
        #yh-ui .yh-row.yh-on .yh-sw::after { transform: translateX(14px); }

        #yh-ui .yh-seg {
            display: flex; gap: 2px; padding: 2px; background: #f4f5f7; border-radius: 8px;
        }
        #yh-ui .yh-seg button {
            padding: 3px 8px; border: none; border-radius: 6px; cursor: pointer;
            background: transparent; color: #666; font: inherit; font-size: 12px;
        }
        #yh-ui .yh-seg button:hover { color: #333; }
        #yh-ui .yh-seg button.yh-active {
            background: #fff; color: #07a352; font-weight: 600;
            box-shadow: 0 1px 3px rgba(0,0,0,.12);
        }

        #yh-ui .yh-stepper { display: flex; align-items: center; gap: 4px; }
        #yh-ui .yh-stepper button {
            width: 22px; height: 22px; padding: 0; border-radius: 6px; cursor: pointer;
            border: 1px solid rgba(0,0,0,.1); background: #f7f7f7; color: #333;
            font-size: 14px; line-height: 1; font-family: inherit;
        }
        #yh-ui .yh-stepper button:hover { background: #efefef; }
        #yh-ui .yh-stepper button:disabled { opacity: .35; cursor: not-allowed; }
        #yh-ui .yh-stepper b {
            min-width: 52px; text-align: center; font-weight: 600; font-size: 12px; color: #07a352;
        }
        #yh-ui .yh-auto {
            display: none; margin-left: 4px; padding: 0 3px; font-style: normal; font-size: 10px;
            line-height: 14px; color: #07a352; border: 1px solid currentColor; border-radius: 3px;
        }
        #yh-ui .yh-auto.yh-show { display: inline-block; }
        #yh-ui .yh-tip {
            padding: 6px 8px 4px; font-size: 11px; color: #999;
            border-top: 1px solid rgba(0,0,0,.06); margin-top: 4px;
        }

        /* ========== 批删 tab ========== */
        #yh-ui .yh-kw-list { display: flex; flex-wrap: wrap; gap: 5px; margin: 2px 0 8px; }
        #yh-ui .yh-kw-chip {
            display: inline-flex; align-items: center; gap: 2px;
            padding: 2px 3px 2px 8px; border-radius: 11px;
            background: #e8f8ef; color: #07a352; border: 1px solid #b7e6cc;
            font-size: 12px; line-height: 1.5; cursor: pointer; user-select: none;
        }
        #yh-ui .yh-kw-chip.off {
            background: #f4f4f4; color: #aaa; border-color: #e2e2e2; text-decoration: line-through;
        }
        #yh-ui .yh-kw-del {
            width: 15px; height: 15px; padding: 0; line-height: 1;
            border: none; background: transparent; color: inherit;
            font-size: 13px; cursor: pointer; border-radius: 50%; opacity: .6;
        }
        #yh-ui .yh-kw-del:hover { background: rgba(0,0,0,.08); opacity: 1; }
        #yh-ui .yh-kw-input {
            flex: 1; min-width: 0; padding: 3px 6px; font-size: 12px;
            border: 1px solid #ddd; border-radius: 4px; outline: none; font-family: inherit;
        }
        #yh-ui .yh-kw-input:focus { border-color: #07c160; }
        #yh-ui .yh-kw-add {
            flex-shrink: 0; padding: 3px 8px; font-size: 12px;
            border: 1px solid #07c160; background: #fff; color: #07c160;
            border-radius: 4px; cursor: pointer; font-family: inherit;
        }
        #yh-ui .yh-kw-add:hover { background: #07c160; color: #fff; }

        #yh-ui .yh-inline { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #666; }
        #yh-ui .yh-inline input {
            width: 46px; padding: 3px 5px; font-size: 12px; text-align: center;
            border: 1px solid #ddd; border-radius: 4px; outline: none; font-family: inherit;
        }
        #yh-ui .yh-inline input:focus { border-color: #07c160; }

        #yh-ui .yh-batch-status {
            margin: 6px 0; padding: 6px 8px; font-size: 12px;
            background: #f6f6f6; border-radius: 5px; color: #666;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        #yh-ui .yh-batch-run {
            width: 100%; padding: 8px; border: none; border-radius: 6px;
            background: #07c160; color: #fff; font-size: 13px; cursor: pointer; font-family: inherit;
        }
        #yh-ui .yh-batch-run:hover { background: #06ad56; }
        #yh-ui .yh-batch-run.running { background: #ff4d4f; }
        #yh-ui .yh-batch-run.running:hover { background: #e63f41; }
    `;

    function injectCSS() {
        if (document.getElementById('yh-style')) return;
        const style = document.createElement('style');
        style.id = 'yh-style';
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);
    }

    function loadSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            const s = Object.assign({}, DEFAULTS, raw ? (JSON.parse(raw) || {}) : {});
            if (DENSITY_LIST.indexOf(s.density) < 0) s.density = DEFAULTS.density;
            return s;
        } catch (e) {
            return Object.assign({}, DEFAULTS);
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (e) { /* 忽略隐私模式写入失败 */ }
    }

    // ========== 宽度计算 ==========
    function mainWidth() {
        const el = document.querySelector('.agent-dialogue__content--common__content')
            || document.querySelector('.yb-layout__content');
        if (el && el.clientWidth > 0) return el.clientWidth;
        return Math.max(320, window.innerWidth - 280);
    }

    // 加宽上限：不超过内容区宽度，也不低于原生宽度（窄屏保持原样）
    function wideCap() {
        const raw = Math.floor((mainWidth() - WIDE_GAP) / WIDE_STEP) * WIDE_STEP;
        return Math.max(NATIVE_MAX, raw);
    }

    function autoWidth() {
        return Math.min(Math.round(NATIVE_MAX * 1.5), wideCap());
    }

    function effectiveWidth() {
        if (!settings.width) return autoWidth();
        const n = Math.round(Number(settings.width) / WIDE_STEP) * WIDE_STEP;
        if (!isFinite(n)) return autoWidth();
        return Math.min(wideCap(), Math.max(NATIVE_MAX, n));
    }

    // ========== 应用状态 ==========
    function apply() {
        const html = document.documentElement;
        if (!html) return;

        html.classList.toggle('yb-wide', !!settings.wide);
        html.classList.toggle('yb-density-compact', settings.density === 'compact');
        html.classList.toggle('yb-density-loose', settings.density === 'loose');

        const w = effectiveWidth() + 'px';
        if (html.style.getPropertyValue('--yb-width') !== w) {
            html.style.setProperty('--yb-width', w);
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

    function stepWide(dir) {
        const cur = effectiveWidth();
        const next = Math.min(wideCap(), Math.max(NATIVE_MAX, cur + dir * WIDE_STEP));
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
        if (panelEl) panelEl.classList.add('yh-open');
    }

    function closePanel(delay) {
        clearTimeout(closeTimer);
        closeTimer = setTimeout(() => {
            if (batchState.running) return;   // 批删进行中保持展开
            if (panelEl) panelEl.classList.remove('yh-open');
        }, delay || 0);
    }

    function switchTab(name) {
        if (!panelEl) return;
        panelEl.querySelectorAll('.yh-tab').forEach((t) => {
            t.classList.toggle('yh-active', t.getAttribute('data-tab') === name);
        });
        panelEl.querySelectorAll('.yh-pane').forEach((p) => {
            p.hidden = p.getAttribute('data-pane') !== name;
        });
    }

    // ========== 功能 9：批量删除 ==========
    const batchState = { running: false, stop: false };

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

    // 关键词状态：on=false 表示暂时不参与匹配；全部关键词为 AND 关系
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

    // 命中规则：会话行文本同时包含所有启用中的关键词（AND）
    function findBatchTargets() {
        const kws = getBatchKeywords().map((k) => k.toLowerCase());
        if (!kws.length) return [];
        const out = [];
        for (const item of collectConvItems()) {
            const text = (item.innerText || item.textContent || '')
                .replace(/\s+/g, '').toLowerCase();
            if (kws.every((k) => text.includes(k))) out.push(item);
        }
        return out;
    }

    function buildBatchPane() {
        const statusEl = panelEl.querySelector('.yh-batch-status');
        const runBtn = panelEl.querySelector('.yh-batch-run');
        const limitEl = panelEl.querySelector('.yh-limit');
        const minEl = panelEl.querySelector('.yh-min');
        const maxEl = panelEl.querySelector('.yh-max');
        const kwListEl = panelEl.querySelector('.yh-kw-list');
        const kwInputEl = panelEl.querySelector('.yh-kw-input');
        const kwAddEl = panelEl.querySelector('.yh-kw-add');

        const setStatus = (text, tip) => {
            // 内容不变就不写 DOM，避免 MutationObserver 自激循环
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
                chip.className = 'yh-kw-chip' + (kw.on ? '' : ' off');
                chip.title = kw.on ? '点击停用' : '点击启用';

                const text = document.createElement('span');
                text.textContent = kw.text;
                chip.appendChild(text);

                const del = document.createElement('button');
                del.className = 'yh-kw-del';
                del.textContent = '×';
                del.title = '移除关键词';
                chip.appendChild(del);

                // 点词体：切换启用状态；点 ×：移除（都不冒泡到面板外）
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

        kwAddEl.addEventListener('click', (e) => {
            e.stopPropagation();
            submitKeyword();
        });
        kwInputEl.addEventListener('keydown', (e) => {
            // 拦住回车，避免触发页面全局的 Enter 发送逻辑
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

        // 列表变化时刷新匹配数（rAF 节流）
        let pending = false;
        new MutationObserver(() => {
            if (pending) return;
            pending = true;
            requestAnimationFrame(() => { pending = false; refresh(); });
        }).observe(document.body, { childList: true, subtree: true });

        renderKeywords();
        refresh();
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

                const item = targets[0];
                const convId = getConvId(item);
                if (!convId) {
                    skipped.add(item);
                    log('跳过无 convId 的会话项');
                    continue;
                }

                setStatus(`正在删除 ${done + 1}/${limit}…`);
                const ok = await deleteConvById(convId);
                if (!ok) {
                    setStatus(`删除失败，已停止（成功 ${done} 个）`);
                    break;
                }

                item.remove();
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
            setStatus(`完成，共删除 ${done} 个会话`);
            if (done > 0) showToast(`批量删除完成：${done} 个`);
        }
    }

    // ========== 面板构建 ==========
    function initSettingsUI() {
        if (document.getElementById('yh-ui')) return;

        const root = document.createElement('div');
        root.id = 'yh-ui';
        root.innerHTML = `
            <div id="yh-panel">
                <div class="yh-tabs">
                    <button type="button" class="yh-tab yh-active" data-tab="layout">布局</button>
                    <button type="button" class="yh-tab" data-tab="batch">批删</button>
                </div>

                <div class="yh-pane" data-pane="layout">
                    <div class="yh-row">
                        <span>布局密度</span>
                        <span class="yh-seg">
                            <button type="button" data-density="default">默认</button>
                            <button type="button" data-density="compact">紧凑</button>
                            <button type="button" data-density="loose">宽松</button>
                        </span>
                    </div>
                    <div class="yh-row" data-k="wide"><span>聊天区加宽</span><i class="yh-sw"></i></div>
                    <div class="yh-row">
                        <span>宽度<i class="yh-auto">自动</i></span>
                        <span class="yh-stepper">
                            <button type="button" data-step="-1" title="变窄">−</button>
                            <b data-val>0px</b>
                            <button type="button" data-step="1" title="变宽">+</button>
                        </span>
                    </div>
                    <div class="yh-tip">Alt + W 快速切换加宽</div>
                </div>

                <div class="yh-pane" data-pane="batch" hidden>
                    <div class="yh-kw-list"></div>
                    <div class="yh-row yh-row--input">
                        <input type="text" class="yh-kw-input" placeholder="添加关键词，回车确认">
                        <button type="button" class="yh-kw-add">添加</button>
                    </div>
                    <div class="yh-row">
                        <span>最近</span>
                        <span class="yh-inline">
                            <input type="number" class="yh-limit" value="10" min="1" max="100"><span>个</span>
                        </span>
                    </div>
                    <div class="yh-row">
                        <span>间隔</span>
                        <span class="yh-inline">
                            <input type="number" class="yh-min" value="2" min="1" max="60"><span>-</span>
                            <input type="number" class="yh-max" value="5" min="1" max="60"><span>秒</span>
                        </span>
                    </div>
                    <div class="yh-batch-status">匹配 0 个</div>
                    <button type="button" class="yh-batch-run">开始批量删除</button>
                </div>
            </div>
            <button type="button" id="yh-btn" title="元宝助手设置">${GEAR_SVG}</button>
        `;

        document.documentElement.appendChild(root);
        panelEl = root.querySelector('#yh-panel');

        root.addEventListener('mouseenter', () => openPanel());
        root.addEventListener('mouseleave', () => closePanel(300));

        root.querySelector('#yh-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            if (panelEl.classList.contains('yh-open')) closePanel();
            else openPanel();
        });

        root.querySelectorAll('.yh-tab').forEach((tab) => {
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
            const row = e.target.closest('.yh-row[data-k]');
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

        panelEl.querySelectorAll('.yh-row[data-k]').forEach((row) => {
            row.classList.toggle('yh-on', !!settings[row.getAttribute('data-k')]);
        });
        panelEl.querySelectorAll('[data-density]').forEach((btn) => {
            btn.classList.toggle('yh-active', btn.getAttribute('data-density') === settings.density);
        });

        const val = panelEl.querySelector('[data-val]');
        if (val) val.textContent = w + 'px';

        const autoTag = panelEl.querySelector('.yh-auto');
        if (autoTag) autoTag.classList.toggle('yh-show', !settings.width);

        const minus = panelEl.querySelector('button[data-step="-1"]');
        const plus = panelEl.querySelector('button[data-step="1"]');
        if (minus) minus.disabled = w <= NATIVE_MAX;
        if (plus) plus.disabled = w >= wideCap();

        const btn = document.getElementById('yh-btn');
        if (btn) {
            btn.title = settings.wide
                ? `元宝助手设置：聊天区已加宽至 ${w}px（Alt+W 切换）`
                : '元宝助手设置：点击加宽聊天区（Alt+W）';
        }
    }

    function initShortcut() {
        document.addEventListener('keydown', (e) => {
            if (!e.altKey || e.ctrlKey || e.metaKey) return;
            if (e.code !== 'KeyW' && e.key.toLowerCase() !== 'w') return;
            e.preventDefault();
            e.stopPropagation();
            toggleWide();
        }, true);
    }

    // ========== 诊断：控制台执行 yhDump() 可打印识别到的会话行 ==========
    function installDiagnostics() {
        window.yhDump = function () {
            const rows = collectConvItems();
            console.table(rows.map((el, i) => ({
                '#': i,
                class: String(el.className || '').substring(0, 50),
                id: getConvId(el),
                attrs: [...el.attributes].map((a) => a.name).join(','),
                text: (el.innerText || '').replace(/\s+/g, ' ').substring(0, 30)
            })));
            console.log('[元宝助手] nav:', !!document.querySelector('.yb-nav__content'),
                '| 识别行数:', rows.length,
                '| 全页带会话 id 节点:', document.querySelectorAll(CONV_SELECTOR).length);
            return rows.length;
        };
    }

    // ========== 通用工具 ==========
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

    function showLoadedBadge() {
        const badge = document.createElement('div');
        badge.textContent = '元宝助手 v1.5.0';
        badge.style.cssText = `
            position: fixed; bottom: 12px; left: 12px; background: #07c160;
            color: #fff; padding: 4px 10px; border-radius: 4px; font-size: 12px;
            z-index: 999999; opacity: 0.85; pointer-events: none; transition: opacity 0.5s;
        `;
        document.body.appendChild(badge);
        setTimeout(() => { badge.style.opacity = '0'; }, 3000);
        setTimeout(() => badge.remove(), 3500);
    }

    // ========== 启动 ==========
    function bootstrap() {
        if (window.__yuanbaoHelperLoaded) return;
        window.__yuanbaoHelperLoaded = true;

        console.log('[元宝助手] v1.5.0 已加载');

        initShortcutSend();
        initAutoFocus();
        initCleanUI();
        initCopyOnDblclick();
        initAutoTempSession();
        initHoverDelete();
        initSettingsUI();
        initShortcut();
        installDiagnostics();
        initNewChatProtection();
        showLoadedBadge();

        window.addEventListener('resize', apply);
        // 聊天页是异步挂载的，内容区出现后再补算一次上限
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
