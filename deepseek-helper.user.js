// ==UserScript==
// @name         DeepSeek 助手 - DeepSeek Helper
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  DeepSeek 聊天页面增强：会话一键静默删除、多关键词批量删除、双击复制
// @author       You
// @match        https://chat.deepseek.com/*
// @grant        none
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
    let batchRoot = null;

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
        try {
            const raw = localStorage.getItem('userToken');
            if (!raw) return null;
            const v = JSON.parse(raw);
            return (v && v.value) || null;
        } catch (e) {
            return null;
        }
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
            /* 三点菜单按钮是绝对定位（right:4px, 宽 28），我们的按钮同样绝对定位到它左侧 */
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
            }
            .ds-del-btn:hover { color: #ff4d4f; background: rgba(255,77,79,0.12); }
            .ds-conv-row:hover .ds-del-btn { display: flex; }
        `;
        document.head.appendChild(style);

        const injectAll = () => {
            for (const row of collectRows()) {
                if (row.querySelector('.ds-del-btn')) continue;   // 已注入（含被 React 重建后补注入）

                const btn = document.createElement('button');
                btn.className = 'ds-del-btn';
                btn.textContent = '×';
                btn.title = '删除会话';
                row.classList.add('ds-conv-row');

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
        btn.disabled = true;
        row.style.opacity = '0.4';
        const ok = await deleteSessions([id]);
        if (ok) {
            row.style.display = 'none';   // 不 remove，避免 React 卸载时报错
            showToast('已删除');
        } else {
            row.style.opacity = '';
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

    // ========== 功能 3：批量删除悬浮面板 ==========
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

    function initBatchPanel() {
        const style = document.createElement('style');
        style.textContent = `
            .ds-batch {
                position: fixed; right: 20px; bottom: 96px; z-index: 999998;
                font-size: 13px; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
                color: #333;
            }
            .ds-batch-bubble {
                width: 46px; height: 46px; border-radius: 50%;
                background: #4d6bfe; color: #fff;
                display: flex; align-items: center; justify-content: center;
                font-size: 12px; font-weight: 600; letter-spacing: 1px;
                cursor: pointer; user-select: none;
                box-shadow: 0 2px 10px rgba(0,0,0,0.22);
            }
            .ds-batch-body {
                display: none; width: 252px; padding: 12px;
                background: #fff; border-radius: 10px;
                box-shadow: 0 6px 24px rgba(0,0,0,0.18);
                border: 1px solid #eee;
            }
            .ds-batch--open .ds-batch-bubble { display: none; }
            .ds-batch--open .ds-batch-body { display: block; }

            .ds-batch-head {
                display: flex; align-items: center; justify-content: space-between;
                font-weight: 600; font-size: 13px; margin-bottom: 10px;
            }
            .ds-batch-x {
                width: 20px; height: 20px; padding: 0; line-height: 1;
                border: none; background: transparent; color: #999;
                font-size: 16px; cursor: pointer; border-radius: 4px;
            }
            .ds-batch-x:hover { background: #f2f2f2; color: #333; }

            .ds-batch-row {
                display: flex; align-items: center; gap: 8px;
                margin-bottom: 8px; font-size: 12px; color: #555;
            }
            .ds-batch-row input[type="number"] {
                width: 52px; padding: 3px 6px; font-size: 12px;
                border: 1px solid #ddd; border-radius: 4px; outline: none;
            }
            .ds-batch-row input[type="number"]:focus { border-color: #4d6bfe; }

            .ds-kw-list { display: flex; flex-wrap: wrap; gap: 5px; margin: 2px 0 8px; }
            .ds-kw-chip {
                display: inline-flex; align-items: center; gap: 2px;
                padding: 2px 3px 2px 8px; border-radius: 11px;
                background: #eef1ff; color: #4d6bfe; border: 1px solid #c9d2ff;
                font-size: 12px; line-height: 1.5; cursor: pointer; user-select: none;
            }
            .ds-kw-chip.off {
                background: #f4f4f4; color: #aaa; border-color: #e2e2e2;
                text-decoration: line-through;
            }
            .ds-kw-del {
                width: 15px; height: 15px; padding: 0; line-height: 1;
                border: none; background: transparent; color: inherit;
                font-size: 13px; cursor: pointer; border-radius: 50%; opacity: 0.6;
            }
            .ds-kw-del:hover { background: rgba(0,0,0,0.08); opacity: 1; }

            .ds-kw-input {
                flex: 1; min-width: 0; padding: 3px 6px; font-size: 12px;
                border: 1px solid #ddd; border-radius: 4px; outline: none;
            }
            .ds-kw-input:focus { border-color: #4d6bfe; }
            .ds-kw-add {
                flex-shrink: 0; padding: 3px 8px; font-size: 12px;
                border: 1px solid #4d6bfe; background: #fff; color: #4d6bfe;
                border-radius: 4px; cursor: pointer;
            }
            .ds-kw-add:hover { background: #4d6bfe; color: #fff; }

            .ds-batch-status {
                margin: 8px 0; padding: 6px 8px; font-size: 12px;
                background: #f6f6f6; border-radius: 5px; color: #666;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            }
            .ds-batch-run {
                width: 100%; padding: 8px; border: none; border-radius: 6px;
                background: #4d6bfe; color: #fff; font-size: 13px; cursor: pointer;
            }
            .ds-batch-run:hover { background: #3f59d9; }
            .ds-batch-run.running { background: #ff4d4f; }
            .ds-batch-run.running:hover { background: #e63f41; }
        `;
        document.head.appendChild(style);

        const root = document.createElement('div');
        root.className = 'ds-batch';
        root.innerHTML = `
            <div class="ds-batch-bubble">批删</div>
            <div class="ds-batch-body">
                <div class="ds-batch-head">
                    <span>批量删除会话</span>
                    <button class="ds-batch-x" title="最小化">×</button>
                </div>
                <div class="ds-kw-list"></div>
                <div class="ds-batch-row">
                    <input type="text" class="ds-kw-input" placeholder="添加关键词，回车确认">
                    <button class="ds-kw-add">添加</button>
                </div>
                <div class="ds-batch-row">
                    <span>最近</span>
                    <input type="number" class="ds-limit" value="10" min="1" max="100">
                    <span>个</span>
                </div>
                <div class="ds-batch-row">
                    <span>间隔</span>
                    <input type="number" class="ds-min" value="2" min="1" max="60">
                    <span>-</span>
                    <input type="number" class="ds-max" value="5" min="1" max="60">
                    <span>秒</span>
                </div>
                <div class="ds-batch-status">匹配 0 个</div>
                <button class="ds-batch-run">开始批量删除</button>
            </div>
        `;
        document.body.appendChild(root);
        batchRoot = root;

        const statusEl = root.querySelector('.ds-batch-status');
        const runBtn = root.querySelector('.ds-batch-run');
        const limitEl = root.querySelector('.ds-limit');
        const minEl = root.querySelector('.ds-min');
        const maxEl = root.querySelector('.ds-max');
        const kwListEl = root.querySelector('.ds-kw-list');
        const kwInputEl = root.querySelector('.ds-kw-input');

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

        root.querySelector('.ds-kw-add').addEventListener('click', (e) => {
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

        root.addEventListener('mouseenter', () => root.classList.add('ds-batch--open'));
        root.addEventListener('mouseleave', () => {
            if (batchState.running) return;
            root.classList.remove('ds-batch--open');
        });
        root.querySelector('.ds-batch-x').addEventListener('click', (e) => {
            e.stopPropagation();
            root.classList.remove('ds-batch--open');
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

        let pending = false;
        new MutationObserver(() => {
            if (pending) return;
            pending = true;
            requestAnimationFrame(() => { pending = false; refresh(); });
        }).observe(document.body, { childList: true, subtree: true });

        renderKeywords();
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
        if (batchRoot) batchRoot.classList.add('ds-batch--open');

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

                row.style.display = 'none';
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
        console.log('[DeepSeek助手] v1.1.0 已加载');

        initHoverDelete();
        initCopyOnDblclick();
        initBatchPanel();
        installDiagnostics();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }
})();
