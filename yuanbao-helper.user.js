// ==UserScript==
// @name         元宝助手 - Yuanbao Helper
// @namespace    http://tampermonkey.net/
// @version      1.1.1
// @description  腾讯元宝聊天页面增强：快捷键发送、自动聚焦、界面精简、会话快速删除
// @author       You
// @match        https://yuanbao.tencent.com/chat/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/alphatok/monkey-script/main/yuanbao-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/alphatok/monkey-script/main/yuanbao-helper.user.js
// ==/UserScript==

(function () {
    'use strict';

    const DEBUG = true; // 调试模式，可在控制台查看日志
    const log = (...args) => DEBUG && console.log('[元宝助手]', ...args);

    // 保护新建会话：记录新建时间
    let lastNewChatTime = 0;
    const NEW_CHAT_PROTECT_MS = 30000; // 30秒内新建的会话受保护

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
        log('快捷键发送已启用：Enter 发送，Shift+Enter 换行');
    }

    function clickSendButton() {
        const btn = document.querySelector('[aria-label="发送"]')
            || document.querySelector('button[class*="send"]')
            || [...document.querySelectorAll('button')].find(b => b.textContent.includes('发送'));

        if (btn && !btn.disabled) {
            btn.click();
            log('已触发发送');
        }
    }

    // ========== 功能 2：自动聚焦输入框 ==========
    function initAutoFocus() {
        const tryFocus = () => {
            const input = findInputBox();
            if (input && document.activeElement !== input) {
                input.focus();
                log('已自动聚焦输入框');
            }
        };

        setTimeout(tryFocus, 800);

        const observer = new MutationObserver(() => {
            setTimeout(tryFocus, 100);
        });

        const chatContainer = document.querySelector('[class*="chat"]')
            || document.querySelector('[class*="message"]')
            || document.body;

        observer.observe(chatContainer, { childList: true, subtree: true });
    }

    function findInputBox() {
        return document.querySelector('textarea[placeholder]')
            || document.querySelector('[contenteditable="true"]')
            || document.querySelector('textarea')
            || document.querySelector('[class*="input"] textarea');
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
                || e.target.closest('[class*="bubble"]')
                || e.target.closest('[class*="content"]');

            if (!bubble) return;

            const text = bubble.innerText;
            if (text) {
                navigator.clipboard.writeText(text).then(() => {
                    showToast('已复制到剪贴板');
                });
            }
        });
        log('双击复制已启用');
    }

    // ========== 功能 5：默认进入临时会话模式 ==========
    function initAutoTempSession() {
        // 策略1：如果当前不是临时会话模式，点击"进入临时会话"按钮
        const tryEnterTemp = () => {
            const url = new URL(location.href);
            if (url.searchParams.get('chatMode') === 'temp') {
                log('当前已是临时会话模式');
                return;
            }

            const tempBtn = document.querySelector('[aria-label="Enter Temporary Chat"]');
            if (tempBtn) {
                tempBtn.click();
                log('已点击"进入临时会话"按钮');
                return;
            }

            // 策略2：如果 URL 中没有 chatMode=temp，尝试自动添加
            // 注意：这会刷新页面，谨慎使用
            // url.searchParams.set('chatMode', 'temp');
            // location.href = url.toString();
        };

        // 页面加载后尝试进入临时会话
        setTimeout(tryEnterTemp, 1000);

        // 监听 URL 变化（SPA 路由变化）
        let lastUrl = location.href;
        const urlObserver = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                log('URL 变化:', lastUrl);
                setTimeout(tryEnterTemp, 500);
            }
        });
        urlObserver.observe(document.body, { childList: true, subtree: true });

        // 拦截新建对话按钮点击，改为进入临时会话
        document.addEventListener('click', (e) => {
            const target = e.target.closest('.yb-new-chat-entry__item')
                || e.target.closest('[aria-label="New Chat"]');
            if (!target) return;

            const url = new URL(location.href);
            if (url.searchParams.get('chatMode') !== 'temp') {
                log('拦截新建对话，改为临时会话模式');
                e.preventDefault();
                e.stopPropagation();
                url.searchParams.set('chatMode', 'temp');
                location.href = url.toString();
            }
        }, true);

        log('自动进入临时会话模式已启用');
    }

    // ========== 功能 6：会话列表 hover 直接显示删除按钮 ==========
    function initHoverDelete() {
        // 注入 CSS：强制显示操作按钮
        const style = document.createElement('style');
        style.textContent = `
            /* 强制显示会话项的操作按钮 */
            .yb-recent-conv-list > * [class*="more"],
            .yb-recent-conv-list > * [class*="action"],
            .yb-recent-conv-list > * [class*="menu"] {
                opacity: 1 !important;
                visibility: visible !important;
                display: inline-flex !important;
            }
        `;
        document.head.appendChild(style);

        // 监听会话列表变化，为每个会话项注入删除按钮
        const observer = new MutationObserver(() => {
            const convList = document.querySelector('.yb-recent-conv-list');
            if (!convList) return;

            const items = convList.children;
            for (const item of items) {
                if (item.dataset.__yhDeleteInjected) continue;
                item.dataset.__yhDeleteInjected = '1';

                // 创建直接删除按钮
                const delBtn = document.createElement('button');
                delBtn.textContent = '×';
                delBtn.title = '删除会话';
                delBtn.style.cssText = `
                    position: absolute;
                    right: 8px;
                    top: 50%;
                    transform: translateY(-50%);
                    background: transparent;
                    border: none;
                    color: #999;
                    cursor: pointer;
                    font-size: 18px;
                    line-height: 1;
                    padding: 4px 8px;
                    z-index: 10;
                    opacity: 0;
                    transition: opacity 0.2s, color 0.2s;
                `;

                // 悬浮时显示删除按钮
                item.style.position = 'relative';
                item.addEventListener('mouseenter', () => { delBtn.style.opacity = '1'; });
                item.addEventListener('mouseleave', () => { delBtn.style.opacity = '0'; });
                delBtn.addEventListener('mouseenter', () => { delBtn.style.color = '#ff4d4f'; });
                delBtn.addEventListener('mouseleave', () => { delBtn.style.color = '#999'; });

                delBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    deleteSession(item);
                });

                item.appendChild(delBtn);
                log('已为会话项注入删除按钮');
            }
        });

        // 监听整个文档，等待会话列表出现
        observer.observe(document.body, { childList: true, subtree: true });
        log('hover 直接删除按钮已启用');
    }

    function deleteSession(item) {
        // 保护新建会话
        if (isProtectedSession(item)) {
            showToast('该会话为新建会话，已跳过删除');
            log('跳过删除：受保护的会话');
            return;
        }

        // 策略1：查找已有的删除按钮/菜单并点击
        const existingDelete = item.querySelector('[class*="delete"]')
            || item.querySelector('[aria-label*="删除"]')
            || item.querySelector('[aria-label*="Delete"]')
            || item.querySelector('button[title*="删除"]');

        if (existingDelete) {
            existingDelete.click();
            log('点击了已有删除按钮');
            return;
        }

        // 策略2：查找更多操作菜单（三个点）
        const moreBtn = item.querySelector('[class*="more"]')
            || item.querySelector('button[class*="menu"]')
            || item.querySelector('[aria-label*="更多"]')
            || item.querySelector('[aria-label*="More"]');

        if (moreBtn) {
            moreBtn.click();
            // 菜单弹出后点击删除
            setTimeout(() => {
                const menuDelete = document.querySelector('[class*="menu"] [class*="delete"]')
                    || document.querySelector('[class*="dropdown"] [class*="delete"]')
                    || [...document.querySelectorAll('[class*="menu"] *, [class*="dropdown"] *')]
                        .find(el => el.textContent.includes('删除') || el.textContent.includes('Delete'));
                if (menuDelete) {
                    menuDelete.click();
                    log('通过菜单删除了会话');
                }
            }, 100);
            return;
        }

        // 策略3：模拟右键菜单
        const event = new MouseEvent('contextmenu', { bubbles: true });
        item.dispatchEvent(event);
        log('尝试右键菜单删除');
    }

    function isProtectedSession(item) {
        const now = Date.now();
        if (now - lastNewChatTime < NEW_CHAT_PROTECT_MS) {
            // 检查是否是当前活跃会话
            const isActive = item.classList.contains('active')
                || item.classList.contains('selected')
                || item.getAttribute('aria-selected') === 'true'
                || item.querySelector('[class*="active"]');
            if (isActive) {
                log('当前活跃会话受保护');
                return true;
            }
        }
        return false;
    }

    // ========== 功能 7：跳过删除确认弹窗 ==========
    function initSkipConfirm() {
        // 拦截原生 confirm
        const originalConfirm = window.confirm;
        window.confirm = function(message) {
            if (message && (
                message.includes('删除') ||
                message.includes('Delete') ||
                message.includes('confirm') ||
                message.includes('确认')
            )) {
                log('拦截确认弹窗，自动返回 true:', message);
                return true;
            }
            return originalConfirm.apply(this, arguments);
        };

        // 拦截 DOM 确认弹窗（modal/dialog）
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    const text = node.textContent || '';
                    if ((text.includes('删除') || text.includes('Delete')) &&
                        (text.includes('确认') || text.includes('Confirm') || text.includes('确定'))) {
                        // 查找确认按钮并点击
                        const confirmBtn = node.querySelector('button[class*="primary"]')
                            || node.querySelector('button[class*="confirm"]')
                            || node.querySelector('button[class*="danger"]')
                            || [...node.querySelectorAll('button')].find(b =>
                                b.textContent.includes('确认') ||
                                b.textContent.includes('确定') ||
                                b.textContent.includes('Confirm') ||
                                b.textContent.includes('Delete')
                            );
                        if (confirmBtn) {
                            setTimeout(() => confirmBtn.click(), 50);
                            log('自动点击确认按钮');
                        }
                    }
                }
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
        log('跳过删除确认已启用');
    }

    // ========== 功能 8：监听新建对话，标记保护时间 ==========
    function initNewChatProtection() {
        document.addEventListener('click', (e) => {
            const target = e.target.closest('.yb-new-chat-entry__item')
                || e.target.closest('[aria-label="New Chat"]')
                || e.target.closest('button')
                || e.target.closest('div[role="button"]');

            if (!target) return;

            const text = target.textContent || target.getAttribute('aria-label') || '';
            if (text.includes('New Chat') || text.includes('新建') || text.includes('New')) {
                lastNewChatTime = Date.now();
                log('检测到新建对话，设置保护时间');
            }
        }, true);
    }

    // ========== 通用 Toast ==========
    function showToast(msg) {
        const toast = document.createElement('div');
        toast.textContent = msg;
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0,0,0,0.75);
            color: #fff;
            padding: 8px 16px;
            border-radius: 6px;
            font-size: 14px;
            z-index: 99999;
            pointer-events: none;
        `;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 1500);
    }

    // ========== 加载状态角标 ==========
    function showLoadedBadge() {
        const badge = document.createElement('div');
        badge.textContent = '元宝助手已加载';
        badge.style.cssText = `
            position: fixed;
            bottom: 12px;
            left: 12px;
            background: #07c160;
            color: #fff;
            padding: 4px 10px;
            border-radius: 4px;
            font-size: 12px;
            z-index: 99999;
            opacity: 0.85;
            pointer-events: none;
            transition: opacity 0.5s;
        `;
        document.body.appendChild(badge);
        setTimeout(() => { badge.style.opacity = '0'; }, 3000);
        setTimeout(() => badge.remove(), 3500);
    }

    // ========== 启动 ==========
    function bootstrap() {
        if (window.__yuanbaoHelperLoaded) return;
        window.__yuanbaoHelperLoaded = true;

        console.log('[元宝助手] v1.1.1 已加载');

        initShortcutSend();
        initAutoFocus();
        initCleanUI();
        initCopyOnDblclick();
        initAutoTempSession();
        initHoverDelete();
        initSkipConfirm();
        initNewChatProtection();
        showLoadedBadge();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }
})();
