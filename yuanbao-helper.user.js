// ==UserScript==
// @name         元宝助手 - Yuanbao Helper
// @namespace    http://tampermonkey.net/
// @version      1.4.0
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

        const observer = new MutationObserver(() => {
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
        });

        observer.observe(document.body, { childList: true, subtree: true });
        log('删除按钮注入已启用');
    }

    // 收集所有会话行：普通最近列表 + Group 分组 + 其它容器
    function collectConvItems() {
        // 限定在左侧导航区内，避免把按钮注入到聊天正文
        const root = document.querySelector('.yb-nav__content')
            || document.querySelector('.yb-nav')
            || document.body;

        const set = new Set();

        // 1) 已知的最近会话列表项
        root.querySelectorAll('.yb-recent-conv-list__item').forEach((el) => set.add(el));

        // 2) 兜底：任何持有 data-conversation-id / dt-cid 的最内层元素
        root.querySelectorAll('[data-conversation-id], [dt-cid]').forEach((el) => {
            if (el.closest('.yb-recent-conv-list__item')) return;   // 已被 1) 覆盖
            if (el.querySelector('[data-conversation-id], [dt-cid]')) return; // 取最内层
            set.add(el);
        });

        return [...set];
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

    // ========== 功能 9：批量删除悬浮面板 ==========
    const batchState = { running: false, stop: false };
    let batchRoot = null;

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

    function getBatchKeywords() {
        if (!batchRoot) return [];
        return [...batchRoot.querySelectorAll('input[type="checkbox"]')]
            .filter((cb) => cb.checked)
            .map((cb) => cb.dataset.kw);
    }

    // 命中规则：会话行文本同时包含所有勾选的关键词（科技 / 摘要 / 或标签 chip 文本）
    function findBatchTargets() {
        const kws = getBatchKeywords();
        if (!kws.length) return [];
        const out = [];
        for (const item of collectConvItems()) {
            const text = (item.innerText || item.textContent || '').replace(/\s+/g, '');
            if (kws.every((k) => text.includes(k))) out.push(item);
        }
        return out;
    }

    function initBatchPanel() {
        const style = document.createElement('style');
        style.textContent = `
            .yh-batch {
                position: fixed; right: 20px; bottom: 96px; z-index: 999998;
                font-size: 13px; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
                color: #333;
            }
            .yh-batch-bubble {
                width: 46px; height: 46px; border-radius: 50%;
                background: #07c160; color: #fff;
                display: flex; align-items: center; justify-content: center;
                font-size: 12px; font-weight: 600; letter-spacing: 1px;
                cursor: pointer; user-select: none;
                box-shadow: 0 2px 10px rgba(0,0,0,0.22);
                transition: transform 0.15s;
            }
            .yh-batch-bubble:hover { transform: scale(1.06); }
            .yh-batch-body {
                display: none; width: 252px; padding: 12px;
                background: #fff; border-radius: 10px;
                box-shadow: 0 6px 24px rgba(0,0,0,0.18);
                border: 1px solid #eee;
            }
            .yh-batch--open .yh-batch-bubble { display: none; }
            .yh-batch--open .yh-batch-body { display: block; }

            .yh-batch-head {
                display: flex; align-items: center; justify-content: space-between;
                font-weight: 600; font-size: 13px; margin-bottom: 10px;
            }
            .yh-batch-x {
                width: 20px; height: 20px; padding: 0; line-height: 1;
                border: none; background: transparent; color: #999;
                font-size: 16px; cursor: pointer; border-radius: 4px;
            }
            .yh-batch-x:hover { background: #f2f2f2; color: #333; }

            .yh-batch-row {
                display: flex; align-items: center; gap: 8px;
                margin-bottom: 8px; font-size: 12px; color: #555;
            }
            .yh-batch-row label {
                display: inline-flex; align-items: center; gap: 4px;
                cursor: pointer; user-select: none;
            }
            .yh-batch-row input[type="number"] {
                width: 52px; padding: 3px 6px; font-size: 12px;
                border: 1px solid #ddd; border-radius: 4px; outline: none;
            }
            .yh-batch-row input[type="number"]:focus { border-color: #07c160; }

            .yh-batch-status {
                margin: 8px 0; padding: 6px 8px; font-size: 12px;
                background: #f6f6f6; border-radius: 5px; color: #666;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            }
            .yh-batch-run {
                width: 100%; padding: 8px; border: none; border-radius: 6px;
                background: #07c160; color: #fff; font-size: 13px;
                cursor: pointer; transition: background 0.15s;
            }
            .yh-batch-run:hover { background: #06ad56; }
            .yh-batch-run.running { background: #ff4d4f; }
            .yh-batch-run.running:hover { background: #e63f41; }
        `;
        document.head.appendChild(style);

        const root = document.createElement('div');
        root.className = 'yh-batch';
        root.innerHTML = `
            <div class="yh-batch-bubble">批删</div>
            <div class="yh-batch-body">
                <div class="yh-batch-head">
                    <span>批量删除会话</span>
                    <button class="yh-batch-x" title="最小化">×</button>
                </div>
                <div class="yh-batch-row">
                    <label><input type="checkbox" data-kw="科技" checked> 科技</label>
                    <label><input type="checkbox" data-kw="摘要" checked> 摘要</label>
                </div>
                <div class="yh-batch-row">
                    <span>最近</span>
                    <input type="number" class="yh-limit" value="10" min="1" max="100">
                    <span>个</span>
                </div>
                <div class="yh-batch-row">
                    <span>间隔</span>
                    <input type="number" class="yh-min" value="2" min="1" max="60">
                    <span>-</span>
                    <input type="number" class="yh-max" value="5" min="1" max="60">
                    <span>秒</span>
                </div>
                <div class="yh-batch-status">匹配 0 个</div>
                <button class="yh-batch-run">开始批量删除</button>
            </div>
        `;
        document.body.appendChild(root);
        batchRoot = root;

        const statusEl = root.querySelector('.yh-batch-status');
        const runBtn = root.querySelector('.yh-batch-run');
        const limitEl = root.querySelector('.yh-limit');
        const minEl = root.querySelector('.yh-min');
        const maxEl = root.querySelector('.yh-max');

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

        root.addEventListener('mouseenter', () => root.classList.add('yh-batch--open'));
        root.addEventListener('mouseleave', () => {
            if (batchState.running) return;
            root.classList.remove('yh-batch--open');
        });
        root.querySelector('.yh-batch-x').addEventListener('click', (e) => {
            e.stopPropagation();
            root.classList.remove('yh-batch--open');
        });

        root.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
            cb.addEventListener('change', refresh);
        });
        [limitEl, minEl, maxEl].forEach((el) => el.addEventListener('change', refresh));

        runBtn.addEventListener('click', () => {
            if (batchState.running) {
                batchState.stop = true;
                setStatus('正在停止…');
                return;
            }
            runBatchDelete({ limitEl, minEl, maxEl, runBtn, setStatus });
        });

        // 列表变化时刷新匹配数（rAF 节流）
        let pending = false;
        new MutationObserver(() => {
            if (pending) return;
            pending = true;
            requestAnimationFrame(() => { pending = false; refresh(); });
        }).observe(document.body, { childList: true, subtree: true });

        refresh();
        log('批量删除面板已启用');
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
        if (batchRoot) batchRoot.classList.add('yh-batch--open');

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
        badge.textContent = '元宝助手 v1.4.0';
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

        console.log('[元宝助手] v1.4.0 已加载');

        initShortcutSend();
        initAutoFocus();
        initCleanUI();
        initCopyOnDblclick();
        initAutoTempSession();
        initHoverDelete();
        initBatchPanel();
        initNewChatProtection();
        showLoadedBadge();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }
})();
