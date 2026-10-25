// ==UserScript==
// @name         元宝助手 - Yuanbao Helper
// @namespace    http://tampermonkey.net/
// @version      1.2.0
// @description  腾讯元宝聊天页面增强：快捷键发送、自动聚焦、界面精简、会话快速删除
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
        // 支持中英文界面多种选择器
        const btn = document.querySelector('[aria-label="发送"]')
            || document.querySelector('[aria-label="Send"]')
            || document.querySelector('button[class*="send"]')
            || document.querySelector('div[class*="SendButton"]')
            || [...document.querySelectorAll('button, div[role="button"]')]
                .find(b => {
                    const aria = b.getAttribute('aria-label') || '';
                    return aria.includes('发送') || aria.includes('Send');
                });
        if (btn) {
            btn.click();
            log('已触发发送');
        } else {
            log('未找到发送按钮');
        }
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
                navigator.clipboard.writeText(text).then(() => showToast('已复制到剪贴板'));
            }
        });
        log('双击复制已启用');
    }

    // ========== 功能 5：默认进入临时会话（尊重用户手动取消） ==========
    function initAutoTempSession() {
        const LS_KEY = 'yh_user_disabled_temp';

        // 检测用户是否手动取消了 temp 模式
        function detectUserCancelTemp() {
            const url = new URL(location.href);
            const wasTemp = sessionStorage.getItem('yh_last_was_temp') === '1';
            const isTemp = url.searchParams.get('chatMode') === 'temp';

            if (wasTemp && !isTemp) {
                // 用户从 temp 模式切回了普通模式
                localStorage.setItem(LS_KEY, '1');
                log('检测到用户手动取消临时会话，已记住偏好');
            }

            sessionStorage.setItem('yh_last_was_temp', isTemp ? '1' : '0');
        }

        // 页面加载时检测一次
        detectUserCancelTemp();

        // 如果用户手动取消过，不再自动进入 temp
        const userDisabled = localStorage.getItem(LS_KEY) === '1';
        if (userDisabled) {
            log('用户已手动取消临时会话，保持当前模式');
        }

        const tryEnterTemp = () => {
            if (userDisabled) return;

            const url = new URL(location.href);
            if (url.searchParams.get('chatMode') === 'temp') {
                log('当前已是临时会话模式');
                return;
            }

            const tempBtn = document.querySelector('[aria-label="Enter Temporary Chat"]');
            if (tempBtn) {
                tempBtn.click();
                log('已点击"进入临时会话"');
                return;
            }
        };

        // 首次进入时延迟尝试
        setTimeout(tryEnterTemp, 1000);

        // 监听 URL 变化
        let lastUrl = location.href;
        const urlObserver = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                detectUserCancelTemp();
                setTimeout(tryEnterTemp, 500);
            }
        });
        urlObserver.observe(document.body, { childList: true, subtree: true });

        // 拦截新建对话，改为临时模式（仅当用户未手动取消时）
        document.addEventListener('click', (e) => {
            if (localStorage.getItem(LS_KEY) === '1') return;

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

        log('自动进入临时会话已启用（尊重用户手动取消）');
    }

    // ========== 功能 6：会话列表注入删除按钮 ==========
    function initHoverDelete() {
        const style = document.createElement('style');
        style.textContent = `
            .yh-conv-item {
                position: relative !important;
            }
            .yh-delete-btn {
                display: none !important;
                align-items: center;
                justify-content: center;
                width: 24px;
                height: 24px;
                margin-right: 4px;
                background: rgba(255,255,255,0.9);
                border: none;
                border-radius: 4px;
                color: #999;
                cursor: pointer;
                font-size: 16px;
                line-height: 1;
                flex-shrink: 0;
                transition: color 0.15s;
            }
            .yh-delete-btn:hover {
                color: #ff4d4f;
                background: rgba(255,77,79,0.1);
            }
            .yh-conv-item:hover .yh-delete-btn {
                display: inline-flex !important;
            }
        `;
        document.head.appendChild(style);

        const observer = new MutationObserver(() => {
            const convList = document.querySelector('.yb-recent-conv-list');
            if (!convList) return;

            for (const item of convList.children) {
                if (item.dataset.__yhDeleteInjected) continue;
                item.dataset.__yhDeleteInjected = '1';
                item.classList.add('yh-conv-item');

                const delBtn = document.createElement('button');
                delBtn.className = 'yh-delete-btn';
                delBtn.textContent = '×';
                delBtn.title = '删除会话';

                const insertTarget = findInsertTarget(item);
                if (insertTarget) {
                    const lastChild = insertTarget.lastElementChild;
                    if (lastChild && (
                        lastChild.className?.includes('more') ||
                        lastChild.getAttribute('aria-label')?.includes('More') ||
                        lastChild.tagName === 'svg'
                    )) {
                        insertTarget.insertBefore(delBtn, lastChild);
                    } else {
                        insertTarget.appendChild(delBtn);
                    }
                } else {
                    item.appendChild(delBtn);
                }

                delBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    deleteSession(item);
                });

                log('已为会话项注入删除按钮');
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
        log('删除按钮注入已启用');
    }

    function findInsertTarget(item) {
        const flexContainers = item.querySelectorAll('*');
        for (const el of flexContainers) {
            const style = window.getComputedStyle(el);
            if (style.display === 'flex' || style.display === 'inline-flex') {
                const hasText = Array.from(el.children).some(c => c.textContent.trim().length > 0);
                const hasButton = el.querySelector('button, [role="button"], svg');
                if (hasText && hasButton) {
                    return el;
                }
            }
        }
        return item;
    }

    // ========== 功能 7：删除会话（无感知：看不到菜单和弹窗） ==========
    function deleteSession(item) {
        if (isProtectedSession(item)) {
            showToast('该会话为新建会话，已跳过删除');
            log('跳过删除：受保护的会话');
            return;
        }

        // 注入 CSS 隐藏菜单视觉
        const hideStyleId = 'yh-hide-menu-' + Date.now();
        const hideStyle = document.createElement('style');
        hideStyle.id = hideStyleId;
        hideStyle.textContent = `
            [class*="menu"], [class*="dropdown"], [class*="popup"], [class*="t-popup"],
            [class*="t-dropdown"], [class*="t-tooltip"] {
                opacity: 0 !important;
                pointer-events: auto !important;
            }
        `;
        document.head.appendChild(hideStyle);

        // 触发 mouseenter 让"三个点"按钮显示
        item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));

        // 找到"三个点"按钮
        const moreBtn = findMoreButton(item);
        if (!moreBtn) {
            log('未找到"三个点"按钮');
            cleanupHideStyle(hideStyleId);
            return;
        }

        log('找到"三个点"按钮，准备打开菜单');

        // 触发 mouseenter 让按钮可见
        moreBtn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));

        // 点击打开菜单（菜单已隐藏，用户看不到）
        setTimeout(() => {
            moreBtn.click();
            log('已打开菜单');

            // 等待菜单渲染后点击删除
            setTimeout(() => {
                clickDeleteInMenu();
                cleanupHideStyle(hideStyleId);
            }, 80);
        }, 30);
    }

    function findMoreButton(item) {
        const selectors = [
            '[class*="more"]',
            '[aria-label*="更多"]',
            '[aria-label*="More"]',
            'button[class*="menu"]',
            '[class*="action"]',
        ];
        for (const sel of selectors) {
            const btn = item.querySelector(sel);
            if (btn) return btn;
        }
        const buttons = item.querySelectorAll('button, [role="button"], svg');
        if (buttons.length > 0) return buttons[buttons.length - 1];
        return null;
    }

    function clickDeleteInMenu() {
        // 在页面中查找"删除"选项（菜单已打开但不可见）
        const candidates = document.querySelectorAll('button, div[role="button"], li, [class*="menu"] *, [class*="dropdown"] *');
        for (const el of candidates) {
            const text = el.textContent?.trim();
            if (text === '删除' || text === 'Delete') {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    el.click();
                    log('已点击菜单中的删除选项');
                    return true;
                }
            }
        }
        log('未找到菜单中的删除选项');
        return false;
    }

    function cleanupHideStyle(id) {
        setTimeout(() => {
            const s = document.getElementById(id);
            if (s) document.head.removeChild(s);
        }, 300);
    }

    function isProtectedSession(item) {
        const now = Date.now();
        if (now - lastNewChatTime < NEW_CHAT_PROTECT_MS) {
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

    // ========== 功能 8：跳过删除确认弹窗 ==========
    function initSkipConfirm() {
        const originalConfirm = window.confirm;
        window.confirm = function(message) {
            if (message && (
                message.includes('删除') ||
                message.includes('Delete') ||
                message.includes('confirm') ||
                message.includes('确认')
            )) {
                log('拦截确认弹窗:', message);
                return true;
            }
            return originalConfirm.apply(this, arguments);
        };

        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    const text = node.textContent || '';
                    if ((text.includes('删除') || text.includes('Delete')) &&
                        (text.includes('确认') || text.includes('Confirm') || text.includes('确定'))) {
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

    // ========== 功能 9：监听新建对话 ==========
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

    // ========== 通用工具 ==========
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

        console.log('[元宝助手] v1.2.0 已加载');

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
