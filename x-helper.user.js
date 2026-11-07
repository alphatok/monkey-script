// ==UserScript==
// @name         X 助手 - X Helper
// @namespace    http://tampermonkey.net/
// @version      1.2.0
// @description  X (x.com) 页面增强：隐藏右侧看板（搜索框 / 趋势 / 推荐关注 / 页脚）、时间线居中、时间线加宽 1.5 倍、紧凑模式收紧推文行距，Alt+S 一键切换
// @author       You
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/alphatok/monkey-script/main/x-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/alphatok/monkey-script/main/x-helper.user.js
// ==/UserScript==

(function () {
    'use strict';

    const DEBUG = true;
    const log = (...args) => DEBUG && console.log('[X助手]', ...args);

    // 设置持久化（x.com 同源，localStorage 可用；@grant none 下直接用）
    const STORE_KEY = 'x-helper.settings.v1';
    const DEFAULTS = { hideSidebar: true, centerTimeline: true, wideTimeline: true, compact: false };

    // 时间线缺口宽度：X 原生 max-width 600px，×1.5 ≈ 900px
    const WIDE_WIDTH = 900;
    const NARROW_WIDTH_MIN = 500;
    const NARROW_WIDTH_MAX = 620;

    let settings = Object.assign({}, DEFAULTS, loadSettings());

    // ========== 样式 ==========
    // 纯 CSS 生效，SPA 路由切换（React 重渲染）也不会失效
    const CSS = `
        /* 1. 隐藏右侧看板整列：搜索框 / 趋势 / 推荐关注 / 页脚都在这一列里
              旧版是 [data-testid="sidebarColumn"]；
              新版（Tailwind 布局）里主列 <main> 和侧栏 <aside> 是同一个 grid 的两个子元素 */
        html.xh-hide-sidebar [data-testid="sidebarColumn"],
        html.xh-hide-sidebar [data-xh-sidebar="1"] {
            display: none !important;
        }
        html.xh-hide-sidebar div:has(> main) > aside {
            display: none !important;
        }
        /* 侧栏那 380px 的栅格列也要让出来，否则主列还是被挤窄 */
        html.xh-hide-sidebar div:has(> main) {
            grid-template-columns: minmax(0, 1fr) !important;
        }

        /* 2. 看板消失后右侧留白，把主时间线拉回视觉中央
              旧版 primaryColumn 本身 max-width:600px，margin:auto 即可居中；
              新版 <main> 自带 mx-auto，不用管 */
        html.xh-hide-sidebar.xh-center [data-testid="primaryColumn"] {
            margin-left: auto !important;
            margin-right: auto !important;
        }

        /* 3. 加宽主时间线：600px → 900px（约 1.5 倍）
              data-xh-wide 由 JS 打在内部同样被限宽的浅层容器上 */
        html.xh-wide [data-testid="primaryColumn"] {
            max-width: ${WIDE_WIDTH}px !important;
        }
        html.xh-wide [data-xh-wide="1"] {
            max-width: ${WIDE_WIDTH}px !important;
        }
        /* 新版：列宽由 main 的 max-w-[602px] + --x-timeline-max-width 两层限制 */
        html.xh-wide main[class*="max-w-"] {
            max-width: ${WIDE_WIDTH}px !important;
        }
        html.xh-wide {
            --x-timeline-max-width: ${WIDE_WIDTH}px;
        }

        /* 4. 紧凑模式：推文上下留白 12px → 6px，正文行高与操作栏间距一起收紧
              X 原生没有紧凑视图了（老版有），这里按原生数值折半还原 */
        /* 旧版结构：article[data-testid="tweet"] 自带 padding，正文是 tweetText */
        html.xh-compact article[data-testid="tweet"] {
            padding-top: 6px !important;
            padding-bottom: 6px !important;
        }
        html.xh-compact [data-testid="tweetText"] {
            line-height: 1.25 !important;
        }
        html.xh-compact article[data-testid="tweet"] [role="group"] {
            margin-top: 6px !important;
        }
        /* 新版结构：padding 在 article 的父 div 上，正文是 .text-lead（17px / 24px），
           操作栏是 -mx-2 + min-h-5 那一行（margin-top:12px） */
        html.xh-compact div:has(> article[class~="group/post"]) {
            padding-top: 6px !important;
            padding-bottom: 6px !important;
        }
        html.xh-compact article[class~="group/post"] [class*="text-lead"] {
            line-height: 1.3 !important;
        }
        html.xh-compact article[class~="group/post"] [class*="-mx-2"][class*="min-h-5"] {
            margin-top: 6px !important;
        }

        /* ========== 悬浮按钮 & 设置面板 ========== */
        #xh-ui, #xh-ui * { box-sizing: border-box; }
        #xh-ui {
            position: fixed; right: 14px; bottom: 96px; width: 40px; height: 40px;
            z-index: 2147483647;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
            font-size: 13px; line-height: 1.4; text-align: left;
        }
        #xh-btn {
            width: 40px; height: 40px; padding: 0; border-radius: 999px; cursor: pointer;
            border: 1px solid rgba(255,255,255,.14);
            background: rgba(15,20,25,.86); color: #fff;
            display: flex; align-items: center; justify-content: center;
            font-size: 15px; line-height: 1;
            -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
            opacity: .5; transition: opacity .15s, background .15s, border-color .15s;
        }
        #xh-ui:hover #xh-btn { opacity: 1; }
        #xh-btn.xh-on { background: #1d9bf0; border-color: #1d9bf0; opacity: .9; }
        #xh-panel {
            position: absolute; right: 0; bottom: 44px; width: 210px; padding: 6px;
            display: none; color: #e7e9ea; background: rgba(15,20,25,.96);
            border: 1px solid rgba(255,255,255,.12); border-radius: 12px;
            box-shadow: 0 8px 28px rgba(0,0,0,.45);
            -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
        }
        #xh-panel.xh-open { display: block; }
        .xh-row {
            display: flex; align-items: center; justify-content: space-between; gap: 10px;
            padding: 7px 8px; border-radius: 8px; cursor: pointer; user-select: none;
        }
        .xh-row:hover { background: rgba(255,255,255,.07); }
        .xh-sw {
            position: relative; flex: 0 0 auto; width: 32px; height: 18px;
            border-radius: 999px; background: #3a444c; transition: background .15s;
        }
        .xh-sw::after {
            content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
            border-radius: 50%; background: #fff; transition: transform .15s;
        }
        .xh-row.xh-on .xh-sw { background: #1d9bf0; }
        .xh-row.xh-on .xh-sw::after { transform: translateX(14px); }
        .xh-tip {
            padding: 2px 8px 4px; font-size: 11px; color: #8b98a5;
            border-top: 1px solid rgba(255,255,255,.08); margin-top: 4px; padding-top: 6px;
        }
        #xh-toast {
            position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%);
            z-index: 2147483647; padding: 8px 16px; border-radius: 8px;
            background: rgba(15,20,25,.92); color: #fff; font-size: 13px;
            pointer-events: none; opacity: 0; transition: opacity .2s;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
        }
        #xh-toast.xh-show { opacity: 1; }
    `;

    function injectCSS() {
        if (document.getElementById('xh-style')) return;
        const style = document.createElement('style');
        style.id = 'xh-style';
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);
    }

    // ========== 设置读写 ==========
    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORE_KEY);
            return raw ? (JSON.parse(raw) || {}) : {};
        } catch (e) {
            return {};
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(settings));
        } catch (e) { /* 忽略隐私模式写入失败 */ }
    }

    // ========== 核心：给 <html> 打状态类 ==========
    function apply() {
        const cl = document.documentElement.classList;
        cl.toggle('xh-hide-sidebar', !!settings.hideSidebar);
        cl.toggle('xh-center', !!(settings.hideSidebar && settings.centerTimeline));
        cl.toggle('xh-wide', !!settings.wideTimeline);
        cl.toggle('xh-compact', !!settings.compact);
        if (settings.wideTimeline) relaxInnerWidth();
        syncUI();
    }

    function setSetting(key, value) {
        settings[key] = value;
        saveSettings();
        apply();
    }

    function toggleSidebar() {
        setSetting('hideSidebar', !settings.hideSidebar);
        toast(settings.hideSidebar ? '右侧看板已隐藏' : '右侧看板已恢复');
    }

    // ========== 兜底：万一 data-testid 改名，用「趋势/搜索框」反查整列 ==========
    // 思路：从趋势节点一路向上，直到它的父节点 == 主时间线的父节点，
    // 那个节点就是侧栏列（primaryColumn 的兄弟节点）
    function tagSidebarFallback() {
        if (document.querySelector('[data-testid="sidebarColumn"]')) return;

        const primary = document.querySelector('[data-testid="primaryColumn"]');
        if (!primary || !primary.parentElement) return;

        const anchor = document.querySelector('[aria-label="Timeline: Trending now"]')
            || document.querySelector('[data-testid="SearchBox"]')
            || document.querySelector('[aria-label="Search query"]');
        if (!anchor) return;

        let el = anchor;
        while (el && el.parentElement && el.parentElement !== primary.parentElement) {
            el = el.parentElement;
        }
        if (el && el !== primary && el !== document.documentElement && el !== document.body) {
            el.setAttribute('data-xh-sidebar', '1');
            log('已通过兜底选择器定位右侧看板');
        }
    }

    // ========== 加宽：放松时间线内部同样被 600px 限制的浅层容器 ==========
    // X 除了 primaryColumn 本身，内部还有若干 600px 上限的容器（导航条、列表外壳等），
    // 只改最外层会留下“内容比列窄”的空隙，这里按实际计算值逐个放行。
    function relaxInnerWidth() {
        const primary = document.querySelector('[data-testid="primaryColumn"]');
        if (!primary) return;

        const walk = (el, depth) => {
            if (depth > 3) return;
            for (const child of el.children) {
                if (child.tagName !== 'DIV') continue;
                const maxWidth = getComputedStyle(child).maxWidth;
                if (maxWidth.endsWith('px')) {
                    const px = parseFloat(maxWidth);
                    // 只处理接近原生 600px 的固定上限，避免误伤 100% / 图片等
                    if (px >= NARROW_WIDTH_MIN && px <= NARROW_WIDTH_MAX) {
                        child.setAttribute('data-xh-wide', '1');
                    }
                }
                walk(child, depth + 1);
            }
        };
        walk(primary, 0);
    }

    // ========== 悬浮 UI ==========
    let panelEl = null;
    let btnEl = null;
    let closeTimer = null;

    function buildUI() {
        if (document.getElementById('xh-ui')) return;

        const root = document.createElement('div');
        root.id = 'xh-ui';

        const panel = document.createElement('div');
        panel.id = 'xh-panel';
        panel.innerHTML = `
            <div class="xh-row" data-k="hideSidebar"><span>隐藏右侧看板</span><i class="xh-sw"></i></div>
            <div class="xh-row" data-k="centerTimeline"><span>时间线居中</span><i class="xh-sw"></i></div>
            <div class="xh-row" data-k="wideTimeline"><span>时间线加宽 ×1.5</span><i class="xh-sw"></i></div>
            <div class="xh-row" data-k="compact"><span>紧凑模式</span><i class="xh-sw"></i></div>
            <div class="xh-tip">Alt + S 快速切换</div>
        `;

        const btn = document.createElement('button');
        btn.id = 'xh-btn';
        btn.type = 'button';
        btn.textContent = '⇥';
        btn.title = 'X 助手：点击隐藏/显示右侧看板（Alt+S）';

        root.appendChild(panel);
        root.appendChild(btn);
        // 挂到 <html> 上，避免被 React 重渲染清掉
        document.documentElement.appendChild(root);

        panelEl = panel;
        btnEl = btn;

        // 鼠标移入展开面板，移出收起（留 300ms 缓冲，方便移到面板上）
        root.addEventListener('mouseenter', () => {
            clearTimeout(closeTimer);
            panel.classList.add('xh-open');
        });
        root.addEventListener('mouseleave', () => {
            closeTimer = setTimeout(() => panel.classList.remove('xh-open'), 300);
        });

        // 点按钮 = 直接切换看板显示
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleSidebar();
        });

        // 面板里的开关
        panel.addEventListener('click', (e) => {
            const row = e.target.closest('.xh-row');
            if (!row) return;
            const k = row.getAttribute('data-k');
            if (!k) return;
            e.stopPropagation();
            setSetting(k, !settings[k]);
        });

        syncUI();
    }

    function syncUI() {
        if (!btnEl || !panelEl) return;
        btnEl.classList.toggle('xh-on', !!settings.hideSidebar);
        btnEl.textContent = settings.hideSidebar ? '⇥' : '⇤';
        panelEl.querySelectorAll('.xh-row').forEach((row) => {
            const k = row.getAttribute('data-k');
            row.classList.toggle('xh-on', !!settings[k]);
        });
    }

    let toastEl = null;
    let toastTimer = null;
    function toast(msg) {
        if (!toastEl) {
            toastEl = document.createElement('div');
            toastEl.id = 'xh-toast';
            document.documentElement.appendChild(toastEl);
        }
        toastEl.textContent = msg;
        toastEl.classList.add('xh-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.remove('xh-show'), 1400);
    }

    // ========== 快捷键 ==========
    function initShortcut() {
        document.addEventListener('keydown', (e) => {
            if (!e.altKey || e.ctrlKey || e.metaKey) return;
            if (e.code !== 'KeyS' && e.key.toLowerCase() !== 's') return;
            e.preventDefault();
            e.stopPropagation();
            toggleSidebar();
        }, true);
    }

    // ========== 观察 DOM：SPA 切换 / 懒渲染时补打兜底标记 ==========
    let moTimer = null;
    function initObserver() {
        const mo = new MutationObserver(() => {
            if (moTimer) return;
            moTimer = setTimeout(() => {
                moTimer = null;
                tagSidebarFallback();
                if (settings.wideTimeline) relaxInnerWidth();
            }, 400);
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
    }

    // ========== 启动 ==========
    injectCSS();
    if (document.documentElement) apply();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }

    function boot() {
        buildUI();
        initShortcut();
        tagSidebarFallback();
        initObserver();
        apply();
        log('已启用，隐藏看板：' + settings.hideSidebar + '，紧凑模式：' + settings.compact);
    }
})();
