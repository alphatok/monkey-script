// ==UserScript==
// @name         元宝助手 - Yuanbao Helper
// @namespace    http://tampermonkey.net/
// @version      1.3.0
// @description  腾讯元宝聊天页面增强：快捷键发送、自动聚焦、界面精简、会话一键删除
// @author       You
// @match        https://yuanbao.tencent.com/chat/*
// @grant        none
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

    // ========== 功能 6：会话列表注入删除按钮 ==========
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
            .yb-recent-conv-list__item:hover .yh-delete-btn {
                display: inline-flex !important;
            }
        `;
        document.head.appendChild(style);

        const observer = new MutationObserver(() => {
            const convList = document.querySelector('.yb-recent-conv-list');
            if (!convList) return;

            // 会话项 class 为 yb-recent-conv-list__item
            const items = convList.querySelectorAll('.yb-recent-conv-list__item');
            for (const item of items) {
                if (item.dataset.__yhDeleteInjected) continue;
                item.dataset.__yhDeleteInjected = '1';
                item.classList.add('yh-conv-item');

                const delBtn = document.createElement('button');
                delBtn.className = 'yh-delete-btn';
                delBtn.textContent = '×';
                delBtn.title = '删除会话';

                // 插到会话项内最后一个可交互元素（三点按钮）之前
                const nameEl = item.querySelector('.yb-recent-conv-list__item-name');
                if (nameEl && nameEl.parentElement) {
                    nameEl.parentElement.insertBefore(delBtn, nameEl.nextSibling);
                } else {
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
        });

        observer.observe(document.body, { childList: true, subtree: true });
        log('删除按钮注入已启用');
    }

    // ========== 功能 7：直接调用删除 API ==========
    function getConvId(item) {
        // 会话项有 data-conversation-id / dt-cid 属性
        return item.getAttribute('data-conversation-id')
            || item.getAttribute('dt-cid')
            || item.querySelector('[data-conversation-id]')?.getAttribute('data-conversation-id')
            || null;
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
        badge.textContent = '元宝助手 v1.3.0';
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

        console.log('[元宝助手] v1.3.0 已加载');

        initShortcutSend();
        initAutoFocus();
        initCleanUI();
        initCopyOnDblclick();
        initAutoTempSession();
        initHoverDelete();
        initNewChatProtection();
        showLoadedBadge();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }
})();
