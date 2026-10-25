// ==UserScript==
// @name         元宝助手 - Yuanbao Helper
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  腾讯元宝聊天页面增强：快捷键发送、自动聚焦、界面精简、会话快速删除
// @author       You
// @match        https://yuanbao.tencent.com/chat/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/alphatok/monkey-script/main/yuanbao-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/alphatok/monkey-script/main/yuanbao-helper.user.js
// ==/UserScript==

(function () {
    'use strict';

    const DEBUG = false;
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

    // ========== 功能 3：精简界面（隐藏下载提示） ==========
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

    // ========== 功能 5：默认勾选"临时会话" ==========
    function initAutoTempSession() {
        const observer = new MutationObserver(() => {
            // 策略1：通过文字内容查找复选框
            const labels = document.querySelectorAll('label, span, div');
            for (const el of labels) {
                if (el.textContent.includes('临时会话') || el.textContent.includes('临时')) {
                    const checkbox = el.closest('label')?.querySelector('input[type="checkbox"]')
                        || el.parentElement?.querySelector('input[type="checkbox"]')
                        || el.querySelector('input[type="checkbox"]');
                    if (checkbox && !checkbox.checked) {
                        checkbox.click();
                        log('已自动勾选临时会话');
                    }
                }
            }

            // 策略2：通过 aria-label 或 placeholder 查找
            const inputs = document.querySelectorAll('input[type="checkbox"]');
            for (const cb of inputs) {
                const label = cb.closest('label');
                if (label && (label.textContent.includes('临时') || label.textContent.includes('temp'))) {
                    if (!cb.checked) {
                        cb.click();
                        log('已自动勾选临时会话 (策略2)');
                    }
                }
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
        log('自动勾选临时会话已启用');
    }

    // ========== 功能 6：会话列表 hover 直接显示删除按钮 ==========
    function initHoverDelete() {
        // 注入 CSS：让删除按钮/菜单始终可见
        const style = document.createElement('style');
        style.textContent = `
            /* 让会话项的操作按钮始终可见 */
            [class*="session"] [class*="more"],
            [class*="session"] [class*="action"],
            [class*="conversation"] [class*="more"],
            [class*="conversation"] [class*="action"],
            [class*="chat-item"] [class*="more"],
            [class*="list-item"] [class*="more"] {
                opacity: 1 !important;
                visibility: visible !important;
                display: flex !important;
            }

            /* 删除按钮直接显示，不需要 hover */
            [class*="session"]:hover [class*="delete"],
            [class*="conversation"]:hover [class*="delete"],
            [class*="chat-item"]:hover [class*="delete"] {
                display: inline-flex !important;
            }
        `;
        document.head.appendChild(style);

        // 同时用 JS 兜底：为每个会话项注入删除按钮
        const observer = new MutationObserver(() => {
            const sessionItems = findSessionItems();
            for (const item of sessionItems) {
                if (item.dataset.__yhDeleteInjected) continue;
                item.dataset.__yhDeleteInjected = '1';

                // 创建直接删除按钮
                const delBtn = document.createElement('button');
                delBtn.textContent = '×';
                delBtn.title = '删除会话';
                delBtn.style.cssText = `
                    margin-left: 8px;
                    background: transparent;
                    border: none;
                    color: #999;
                    cursor: pointer;
                    font-size: 16px;
                    line-height: 1;
                    padding: 0 4px;
                    flex-shrink: 0;
                `;
                delBtn.onmouseenter = () => { delBtn.style.color = '#ff4d4f'; };
                delBtn.onmouseleave = () => { delBtn.style.color = '#999'; };
                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    deleteSession(item);
                };

                // 尝试插入到会话项末尾
                const target = item.querySelector('[class*="title"]')
                    || item.querySelector('[class*="name"]')
                    || item;
                if (target.style.display === 'flex' || getComputedStyle(target).display === 'flex') {
                    target.appendChild(delBtn);
                } else {
                    // 如果目标不是 flex 容器，创建一个 flex 包装
                    const wrapper = document.createElement('div');
                    wrapper.style.cssText = 'display:flex;align-items:center;justify-content:space-between;width:100%;';
                    while (target.firstChild) wrapper.appendChild(target.firstChild);
                    wrapper.appendChild(delBtn);
                    target.appendChild(wrapper);
                }
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
        log('hover 直接删除按钮已启用');
    }

    function findSessionItems() {
        // 多种策略查找会话列表项
        const selectors = [
            '[class*="session-item"]',
            '[class*="conversation-item"]',
            '[class*="chat-item"]',
            '[class*="list-item"]',
            '[class*="session"]',
            '[class*="conversation"]',
        ];
        for (const sel of selectors) {
            const items = document.querySelectorAll(sel);
            if (items.length > 0) {
                log('找到会话项选择器:', sel, '数量:', items.length);
                return Array.from(items);
            }
        }
        return [];
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
            || item.querySelector('button[title*="删除"]');

        if (existingDelete) {
            existingDelete.click();
            log('点击了已有删除按钮');
            return;
        }

        // 策略2：查找更多操作菜单（三个点）
        const moreBtn = item.querySelector('[class*="more"]')
            || item.querySelector('button[class*="menu"]')
            || item.querySelector('[aria-label*="更多"]');

        if (moreBtn) {
            moreBtn.click();
            // 菜单弹出后点击删除
            setTimeout(() => {
                const menuDelete = document.querySelector('[class*="menu"] [class*="delete"]')
                    || [...document.querySelectorAll('[class*="menu"] *, [class*="dropdown"] *')]
                        .find(el => el.textContent.includes('删除'));
                if (menuDelete) {
                    menuDelete.click();
                    log('通过菜单删除了会话');
                }
            }, 100);
            return;
        }

        // 策略3：模拟右键菜单（部分网站支持）
        const event = new MouseEvent('contextmenu', { bubbles: true });
        item.dispatchEvent(event);
        log('尝试右键菜单删除');
    }

    function isProtectedSession(item) {
        // 保护最近新建的会话
        const now = Date.now();
        if (now - lastNewChatTime < NEW_CHAT_PROTECT_MS) {
            // 检查是否是当前活跃会话（通常新建后会被选中）
            const isActive = item.classList.contains('active')
                || item.classList.contains('selected')
                || item.getAttribute('aria-selected') === 'true'
                || item.style.backgroundColor !== ''
                || getComputedStyle(item).backgroundColor !== 'rgba(0, 0, 0, 0)'
                && getComputedStyle(item).backgroundColor !== 'transparent';
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
                    if (text.includes('删除') && text.includes('确认')) {
                        // 查找确认按钮并点击
                        const confirmBtn = node.querySelector('button[class*="primary"]')
                            || node.querySelector('button[class*="confirm"]')
                            || [...node.querySelectorAll('button')].find(b => b.textContent.includes('确认') || b.textContent.includes('确定'));
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
            const target = e.target.closest('button')
                || e.target.closest('a')
                || e.target.closest('[class*="new-chat"]')
                || e.target.closest('[class*="new-conversation"]');

            if (!target) return;

            const text = target.textContent || target.getAttribute('aria-label') || '';
            if (text.includes('新建') || text.includes('New') || text.includes('新建对话')) {
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

        console.log('[元宝助手] v1.1.0 已加载');

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
