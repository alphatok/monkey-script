// ==UserScript==
// @name         元宝助手 - Yuanbao Helper
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  腾讯元宝聊天页面增强：快捷键发送、自动聚焦、界面精简
// @author       You
// @match        https://yuanbao.tencent.com/chat/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/yourname/yuanbao-helper/main/yuanbao-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/yourname/yuanbao-helper/main/yuanbao-helper.user.js
// ==/UserScript==

(function () {
    'use strict';

    const DEBUG = false;
    const log = (...args) => DEBUG && console.log('[元宝助手]', ...args);

    // ========== 功能 1：快捷键发送消息 ==========
    function initShortcutSend() {
        document.addEventListener('keydown', (e) => {
            // 目标：输入框内按 Enter 发送（Shift+Enter 换行）
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
        // 通过 aria-label 定位发送按钮（元宝使用此属性）
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

        // 页面加载后聚焦
        setTimeout(tryFocus, 800);

        // 每次发送消息后重新聚焦
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
            /* 隐藏底部"下载元宝电脑版"横幅 */
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

        console.log('[元宝助手] v1.0.0 已加载');

        initShortcutSend();
        initAutoFocus();
        initCleanUI();
        initCopyOnDblclick();
        showLoadedBadge();
    }

    // 等待页面就绪
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }
})();
