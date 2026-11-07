// ==UserScript==
// @name         DeepSeek 助手 - DeepSeek Helper
// @namespace    http://tampermonkey.net/
// @version      1.3.0
// @description  DeepSeek 聊天页面增强：聊天区加宽（原生 1.5 倍，居中）、会话一键静默删除、多关键词批量删除、双击复制
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

    // ========== 功能 4：聊天区加宽 ==========
    // 站点把聊天区的宽度收在一个 CSS 变量里：
    //   :root { --message-list-max-width: 840px }   （<1024px 时 712px）
    // 消息列表容器的内联样式是
    //   padding-left/right: calc((100% - var(--message-list-max-width)) / 2)
    // 输入区 ._871cbca 的 padding、输入框 ._9f86274 的 max-width 也都用这个变量。
    // 所以只改这一个变量，消息列和输入框会一起变宽，而且居中逻辑是站点自己算的，
    // 不用碰任何 DOM，也不会被 React 重渲染冲掉。
    const WIDE_STORE = 'dsh-helper.wide.v1';
    // width = 0 表示「自动」：按原生宽度 ×1.5
    const WIDE_DEFAULTS = { wide: true, width: 0 };
    const WIDE_SCALE = 1.5;
    const WIDE_STEP = 40;
    // 加宽后左右各留的空白，避免贴到侧栏 / 窗口边缘
    const WIDE_GAP = 64;

    let wideSettings = Object.assign({}, WIDE_DEFAULTS, loadWideSettings());
    let widePanel = null;
    let wideBtn = null;
    let wideCloseTimer = null;
    let wideScroller = null;
    let wideRO = null;

    const WIDE_CSS = `
        html.dsh-wide {
            --message-list-max-width: var(--dsh-width, 840px);
        }
        /* 新对话页的居中容器把 840px 写死了，跟变量无关，顺手一起放宽。
           类名是站点构建产物（CSS Module 哈希），改版后会失效，失效也只是保持原样。 */
        html.dsh-wide ._9a2f8e4 {
            max-width: var(--dsh-width, 840px);
        }

        /* ========== 悬浮按钮 & 设置面板 ========== */
        #dsh-wide-ui, #dsh-wide-ui * { box-sizing: border-box; }
        #dsh-wide-ui {
            position: fixed; right: 20px; bottom: 152px; width: 40px; height: 40px;
            z-index: 2147483647;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
            font-size: 13px; line-height: 1.4; text-align: left;
        }
        #dsh-wide-btn {
            width: 40px; height: 40px; padding: 0; border-radius: 999px; cursor: pointer;
            border: 1px solid rgba(0,0,0,.08);
            background: rgba(255,255,255,.94); color: #4d6bfe;
            display: flex; align-items: center; justify-content: center;
            font-size: 15px; font-weight: 700; line-height: 1;
            box-shadow: 0 2px 10px rgba(0,0,0,.12);
            opacity: .55; transition: opacity .15s, background .15s, color .15s;
        }
        #dsh-wide-ui:hover #dsh-wide-btn { opacity: 1; }
        #dsh-wide-btn.dsh-on { background: #4d6bfe; border-color: #4d6bfe; color: #fff; opacity: .95; }
        #dsh-wide-panel {
            position: absolute; right: 0; bottom: 44px; width: 218px; padding: 6px;
            display: none; color: #333; background: #fff;
            border: 1px solid rgba(0,0,0,.08); border-radius: 12px;
            box-shadow: 0 8px 28px rgba(0,0,0,.16);
        }
        #dsh-wide-panel.dsh-open { display: block; }
        #dsh-wide-ui .dsh-row {
            display: flex; align-items: center; justify-content: space-between; gap: 10px;
            padding: 7px 8px; border-radius: 8px; cursor: pointer; user-select: none;
        }
        #dsh-wide-ui .dsh-row:hover { background: rgba(0,0,0,.04); }
        #dsh-wide-ui .dsh-sw {
            position: relative; flex: 0 0 auto; width: 32px; height: 18px;
            border-radius: 999px; background: #d9d9d9; transition: background .15s;
        }
        #dsh-wide-ui .dsh-sw::after {
            content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
            border-radius: 50%; background: #fff; transition: transform .15s;
            box-shadow: 0 1px 2px rgba(0,0,0,.15);
        }
        #dsh-wide-ui .dsh-row.dsh-on .dsh-sw { background: #4d6bfe; }
        #dsh-wide-ui .dsh-row.dsh-on .dsh-sw::after { transform: translateX(14px); }

        #dsh-wide-ui .dsh-stepper { display: flex; align-items: center; gap: 4px; cursor: default; }
        #dsh-wide-ui .dsh-stepper button {
            width: 22px; height: 22px; padding: 0; border-radius: 6px; cursor: pointer;
            border: 1px solid rgba(0,0,0,.1); background: #f7f7f7; color: #333;
            font-size: 14px; line-height: 1; font-family: inherit;
        }
        #dsh-wide-ui .dsh-stepper button:hover { background: #efefef; }
        #dsh-wide-ui .dsh-stepper button:disabled { opacity: .35; cursor: not-allowed; }
        #dsh-wide-ui .dsh-stepper b {
            min-width: 52px; text-align: center; font-weight: 600; font-size: 12px; color: #4d6bfe;
        }
        #dsh-wide-ui .dsh-auto {
            display: none; margin-left: 4px; padding: 0 3px; font-style: normal; font-size: 10px;
            line-height: 14px; color: #4d6bfe; border: 1px solid currentColor; border-radius: 3px;
        }
        #dsh-wide-ui .dsh-auto.dsh-show { display: inline-block; }
        #dsh-wide-ui .dsh-tip {
            padding: 6px 8px 4px; font-size: 11px; color: #999;
            border-top: 1px solid rgba(0,0,0,.06); margin-top: 4px;
        }
    `;

    function injectWideCSS() {
        if (document.getElementById('dsh-wide-style')) return;
        const style = document.createElement('style');
        style.id = 'dsh-wide-style';
        style.textContent = WIDE_CSS;
        (document.head || document.documentElement).appendChild(style);
    }

    function loadWideSettings() {
        try {
            const raw = localStorage.getItem(WIDE_STORE);
            return raw ? (JSON.parse(raw) || {}) : {};
        } catch (e) {
            return {};
        }
    }

    function saveWideSettings() {
        try {
            localStorage.setItem(WIDE_STORE, JSON.stringify(wideSettings));
        } catch (e) { /* 忽略隐私模式写入失败 */ }
    }

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
        if (!wideSettings.width) return autoWidth();
        const n = Math.round(Number(wideSettings.width) / WIDE_STEP) * WIDE_STEP;
        if (!isFinite(n)) return autoWidth();
        return Math.min(wideCap(), Math.max(nativeMaxWidth(), n));
    }

    function applyWide() {
        const html = document.documentElement;
        if (!html) return;
        observeScroller();
        html.classList.toggle('dsh-wide', !!wideSettings.wide);
        const w = effectiveWidth() + 'px';
        if (html.style.getPropertyValue('--dsh-width') !== w) {
            html.style.setProperty('--dsh-width', w);
        }
        syncWideUI();
    }

    // 侧栏展开 / 收起会改变可用宽度，跟着重算一次上限
    function observeScroller() {
        const el = findScroller();
        if (el === wideScroller) return;
        if (wideRO) { wideRO.disconnect(); wideRO = null; }
        wideScroller = el;
        if (!el || typeof ResizeObserver === 'undefined') return;
        wideRO = new ResizeObserver(() => applyWide());
        wideRO.observe(el);
    }

    function toggleWide() {
        wideSettings.wide = !wideSettings.wide;
        saveWideSettings();
        applyWide();
        showToast(wideSettings.wide
            ? `聊天区已加宽（${effectiveWidth()}px）`
            : '聊天区已恢复原宽');
    }

    // 点 ± 后从「自动」切换成手动宽度
    function stepWide(dir) {
        const cur = effectiveWidth();
        const next = Math.min(wideCap(), Math.max(nativeMaxWidth(), cur + dir * WIDE_STEP));
        if (next === cur) return;
        wideSettings.wide = true;
        wideSettings.width = next;
        saveWideSettings();
        applyWide();
        showToast(`聊天区宽度 ${next}px`);
    }

    function buildWideUI() {
        if (document.getElementById('dsh-wide-ui')) return;

        const root = document.createElement('div');
        root.id = 'dsh-wide-ui';

        const panel = document.createElement('div');
        panel.id = 'dsh-wide-panel';
        panel.innerHTML = `
            <div class="dsh-row" data-k="wide"><span>聊天区加宽</span><i class="dsh-sw"></i></div>
            <div class="dsh-row">
                <span>宽度<i class="dsh-auto">自动</i></span>
                <span class="dsh-stepper">
                    <button type="button" data-step="-1" title="变窄">−</button>
                    <b data-val>0px</b>
                    <button type="button" data-step="1" title="变宽">+</button>
                </span>
            </div>
            <div class="dsh-tip">Alt + W 快速切换</div>
        `;

        const btn = document.createElement('button');
        btn.id = 'dsh-wide-btn';
        btn.type = 'button';
        btn.textContent = '宽';
        btn.title = 'DeepSeek 助手：点击切换聊天区加宽（Alt+W）';

        root.appendChild(panel);
        root.appendChild(btn);
        // 挂到 <html> 上，避免被 React 重渲染清掉
        document.documentElement.appendChild(root);

        widePanel = panel;
        wideBtn = btn;

        root.addEventListener('mouseenter', () => {
            clearTimeout(wideCloseTimer);
            panel.classList.add('dsh-open');
        });
        root.addEventListener('mouseleave', () => {
            wideCloseTimer = setTimeout(() => panel.classList.remove('dsh-open'), 300);
        });

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleWide();
        });

        panel.addEventListener('click', (e) => {
            const stepBtn = e.target.closest('button[data-step]');
            if (stepBtn) {
                e.stopPropagation();
                stepWide(Number(stepBtn.getAttribute('data-step')));
                return;
            }
            const row = e.target.closest('.dsh-row[data-k]');
            if (!row) return;
            e.stopPropagation();
            toggleWide();
        });

        syncWideUI();
    }

    function syncWideUI() {
        if (!wideBtn || !widePanel) return;
        const w = effectiveWidth();
        wideBtn.classList.toggle('dsh-on', !!wideSettings.wide);
        wideBtn.title = wideSettings.wide
            ? `DeepSeek 助手：聊天区已加宽至 ${w}px（Alt+W 切换）`
            : 'DeepSeek 助手：点击加宽聊天区（Alt+W）';

        widePanel.querySelectorAll('.dsh-row[data-k]').forEach((row) => {
            row.classList.toggle('dsh-on', !!wideSettings[row.getAttribute('data-k')]);
        });

        const val = widePanel.querySelector('[data-val]');
        if (val) val.textContent = w + 'px';

        const autoTag = widePanel.querySelector('.dsh-auto');
        if (autoTag) autoTag.classList.toggle('dsh-show', !wideSettings.width);

        const minus = widePanel.querySelector('button[data-step="-1"]');
        const plus = widePanel.querySelector('button[data-step="1"]');
        if (minus) minus.disabled = w <= nativeMaxWidth();
        if (plus) plus.disabled = w >= wideCap();
    }

    function initWideChat() {
        buildWideUI();

        document.addEventListener('keydown', (e) => {
            if (!e.altKey || e.ctrlKey || e.metaKey) return;
            if (e.code !== 'KeyW' && e.key.toLowerCase() !== 'w') return;
            e.preventDefault();
            e.stopPropagation();
            toggleWide();
        }, true);

        window.addEventListener('resize', applyWide);
        // 聊天页是异步挂载的，滚动容器出现后再补算一次上限
        [600, 1500, 3000].forEach((t) => setTimeout(applyWide, t));
        applyWide();
        log('聊天区加宽已启用，宽度：' + effectiveWidth() + 'px');
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
        console.log('[DeepSeek助手] v1.3.0 已加载');

        initHoverDelete();
        initCopyOnDblclick();
        initBatchPanel();
        initWideChat();
        installDiagnostics();
    }

    // 宽度变量要在首屏渲染前就位，否则会先看到原生宽度再跳变
    injectWideCSS();
    if (document.documentElement) applyWide();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }
})();
