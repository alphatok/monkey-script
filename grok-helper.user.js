// ==UserScript==
// @name         Grok 助手 - Grok Helper
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Grok 聊天页面增强：布局密度（标准/紧凑/宽松）、页面加宽到原生 1.5 倍、宽度可微调
// @author       You
// @match        https://grok.com/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/alphatok/monkey-script/main/grok-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/alphatok/monkey-script/main/grok-helper.user.js
// ==/UserScript==

(function () {
    'use strict';

    const DEBUG = true;
    const log = (...args) => DEBUG && console.log('[Grok助手]', ...args);

    // ========== 站点布局的实际情况 ==========
    // 聊天正文列宽、新对话页列宽都由 CSS 变量控制：
    //   --content-max-width           聊天消息列（原生 clamp(32rem, 100cqw - 3rem, 44rem)，宽屏即 704px）
    //   --content-breakout-max-width  表格 / 代码块的突破宽度（原生 880px）
    //   --grok-page-max-width         新对话页居中列（原生 800px）
    // 这些变量被 stylex 以 `.grok-xxxx:not(#\#):not(#\#):not(#\#)` 这种带 3 个 id 的特异性写死，
    // 普通选择器盖不住，只能 !important。变量本身只是数值，盖掉不会破坏站点布局逻辑，
    // 站点自己的 `w-full` / `calc(100% - …)` 仍然保证窄屏不溢出。
    const NATIVE_CHAT_REM = 44;      // 44rem
    const NATIVE_PAGE = 800;         // px

    // 消息列表容器是 `flex flex-col items-center gap-2`（gap 8px）。
    // 列表 → 消息行 → 气泡是固定结构，但气泡外面是否还包一层 .user-message
    // 在不同视图下不一样，所以两种深度都写上，命中哪个都不影响（行本身是单列，gap 无副作用）。
    const LIST_SELECTOR = ':is(div:has(> div > .message-bubble), div:has(> div > div > .message-bubble))';
    const USER_BUBBLE = '.message-bubble[class*="bg-surface-user-bubble"]';

    // ========== 设置 ==========
    const SETTINGS_KEY = 'grok-helper.settings.v1';
    const DENSITY_LIST = ['standard', 'compact', 'loose'];
    const DENSITY_LABEL = { standard: '标准', compact: '紧凑', loose: '宽松' };

    const DEFAULTS = { wide: true, width: 0, density: 'standard' };

    const WIDE_SCALE = 1.5;
    const WIDE_STEP = 40;
    const WIDE_GAP = 96;             // 加宽后两侧留白，避免贴边 / 贴侧栏

    let settings = loadSettings();
    let panelEl = null;
    let closeTimer = null;

    // ========== 通用工具 ==========
    function showToast(msg) {
        const toast = document.createElement('div');
        toast.textContent = msg;
        toast.style.cssText = `
            position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
            background: rgba(0,0,0,0.82); color: #fff; padding: 8px 16px;
            border-radius: 6px; font-size: 13px; z-index: 2147483647;
            pointer-events: none; transition: opacity 0.3s;
            font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
        `;
        document.body.appendChild(toast);
        setTimeout(() => { toast.style.opacity = '0'; }, 1200);
        setTimeout(() => toast.remove(), 1600);
    }

    function loadSettings() {
        let saved = {};
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (raw) saved = JSON.parse(raw) || {};
        } catch (e) {
            saved = {};
        }
        const s = Object.assign({}, DEFAULTS, saved);
        if (DENSITY_LIST.indexOf(s.density) < 0) s.density = DEFAULTS.density;
        return s;
    }

    function saveSettings() {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (e) { /* 隐私模式写入失败，忽略 */ }
    }

    // ========== 宽度计算 ==========
    function rootPx() {
        const v = parseFloat(getComputedStyle(document.documentElement).fontSize);
        return isFinite(v) && v > 0 ? v : 16;
    }

    // 站点原生聊天列宽（宽屏 44rem，小屏 clamp 会更窄，这里只取宽屏值当基准）
    function nativeChat() {
        return Math.round(NATIVE_CHAT_REM * rootPx());
    }

    // 加宽上限：不超过视口，也不低于原生宽度
    function wideCap() {
        const raw = Math.floor((window.innerWidth - WIDE_GAP) / WIDE_STEP) * WIDE_STEP;
        return Math.max(nativeChat(), raw);
    }

    function autoChat() {
        return Math.min(Math.round(nativeChat() * WIDE_SCALE), wideCap());
    }

    function effectiveChat() {
        if (!settings.width) return autoChat();
        const n = Math.round(Number(settings.width));
        if (!isFinite(n)) return autoChat();
        return Math.min(wideCap(), Math.max(nativeChat(), n));
    }

    // 新对话页列宽跟着聊天列宽等比例放大：704 → 800，1056 → 1200
    function effectivePage(chatWidth) {
        return Math.round(chatWidth * NATIVE_PAGE / nativeChat());
    }

    // ========== 样式 ==========
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
        /* ========== 页面加宽 ========== */
        /* 变量定义在 html 和带 grok-* 的包装元素上，且带 3 个 :not(#\\#)，
           所以这里必须 !important，并把作用域铺到所有可能声明它的元素。 */
        body.gk-wide,
        body.gk-wide [class*="grok-"],
        body.gk-wide [class*="--content-"] {
            --content-max-width: var(--gk-chat-w, 1056px) !important;
            --content-breakout-max-width: calc(var(--gk-chat-w, 1056px) + 3rem) !important;
            --grok-page-max-width: var(--gk-page-w, 1200px) !important;
        }

        /* ========== 布局密度：紧凑 ========== */
        /* 消息气泡自带 .prose，段落 / 列表间距全由这几个变量控制 */
        body.gk-density-compact .message-bubble {
            --paragraph-margin: .55em;
            --list-margin-top: .3em;
            --list-margin-bottom: .55em;
            --list-item-margin: .25em;
            line-height: 1.45;
        }
        body.gk-density-compact ${LIST_SELECTOR} { row-gap: 4px; }
        body.gk-density-compact ${USER_BUBBLE} { padding: 5px 12px; }

        /* ========== 布局密度：宽松 ========== */
        body.gk-density-loose .message-bubble {
            --paragraph-margin: 1.5em;
            --list-margin-top: .8em;
            --list-margin-bottom: 1.5em;
            --list-item-margin: .8em;
            line-height: 1.7;
        }
        body.gk-density-loose ${LIST_SELECTOR} { row-gap: 20px; }
        body.gk-density-loose ${USER_BUBBLE} { padding: 11px 20px; }

        /* ========== 悬浮球 & 面板 ========== */
        #gk-ui, #gk-ui * { box-sizing: border-box; }
        #gk-ui {
            position: fixed; right: 20px; bottom: 96px; z-index: 2147483647;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
            font-size: 13px; line-height: 1.4; text-align: left; color: #1a1a1a;
        }
        #gk-btn {
            width: 46px; height: 46px; padding: 0; border-radius: 50%; cursor: pointer;
            border: none; background: #111; color: #fff;
            display: flex; align-items: center; justify-content: center;
            box-shadow: 0 0 0 1.5px rgba(255,255,255,.22), 0 2px 10px rgba(0,0,0,.28);
            transition: transform .2s ease, background .15s;
        }
        #gk-btn:hover { background: #2b2b2b; transform: rotate(45deg); }
        #gk-btn svg { display: block; }

        #gk-panel {
            position: absolute; right: 0; bottom: 56px; width: 264px;
            display: none; background: #fff; border: 1px solid rgba(0,0,0,.08);
            border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.16);
            overflow: hidden;
        }
        #gk-panel.gk-open { display: block; }

        #gk-ui .gk-head {
            padding: 10px 12px 8px; font-size: 12px; font-weight: 600; color: #111;
            border-bottom: 1px solid rgba(0,0,0,.06);
        }
        #gk-ui .gk-pane { padding: 6px; }

        #gk-ui .gk-row {
            display: flex; align-items: center; justify-content: space-between; gap: 10px;
            padding: 7px 8px; border-radius: 8px; font-size: 12.5px;
        }
        #gk-ui .gk-row[data-k] { cursor: pointer; user-select: none; }
        #gk-ui .gk-row[data-k]:hover { background: rgba(0,0,0,.04); }

        #gk-ui .gk-sw {
            position: relative; flex: 0 0 auto; width: 32px; height: 18px;
            border-radius: 999px; background: #d9d9d9; transition: background .15s;
        }
        #gk-ui .gk-sw::after {
            content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
            border-radius: 50%; background: #fff; transition: transform .15s;
            box-shadow: 0 1px 2px rgba(0,0,0,.15);
        }
        #gk-ui .gk-row.gk-on .gk-sw { background: #111; }
        #gk-ui .gk-row.gk-on .gk-sw::after { transform: translateX(14px); }

        #gk-ui .gk-seg {
            display: flex; gap: 2px; padding: 2px; background: #f4f5f7; border-radius: 8px;
        }
        #gk-ui .gk-seg button {
            padding: 3px 8px; border: none; border-radius: 6px; cursor: pointer;
            background: transparent; color: #666; font: inherit; font-size: 12px;
        }
        #gk-ui .gk-seg button:hover { color: #111; }
        #gk-ui .gk-seg button.gk-active {
            background: #fff; color: #111; font-weight: 600;
            box-shadow: 0 1px 3px rgba(0,0,0,.12);
        }

        #gk-ui .gk-stepper { display: flex; align-items: center; gap: 4px; }
        #gk-ui .gk-stepper button {
            width: 22px; height: 22px; padding: 0; border-radius: 6px; cursor: pointer;
            border: 1px solid rgba(0,0,0,.1); background: #f7f7f7; color: #333;
            font-size: 14px; line-height: 1; font-family: inherit;
        }
        #gk-ui .gk-stepper button:hover { background: #efefef; }
        #gk-ui .gk-stepper button:disabled { opacity: .35; cursor: not-allowed; }
        #gk-ui .gk-stepper b {
            min-width: 52px; text-align: center; font-weight: 600; font-size: 12px; color: #111;
        }
        #gk-ui .gk-auto {
            display: none; margin-left: 4px; padding: 0 3px; font-style: normal; font-size: 10px;
            line-height: 14px; color: #111; border: 1px solid currentColor; border-radius: 3px;
        }
        #gk-ui .gk-auto.gk-show { display: inline-block; }
        #gk-ui .gk-tip {
            padding: 6px 8px 4px; font-size: 11px; color: #999;
            border-top: 1px solid rgba(0,0,0,.06); margin-top: 4px;
        }
    `;

    function injectCSS() {
        if (document.getElementById('gk-style')) return;
        const style = document.createElement('style');
        style.id = 'gk-style';
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);
    }

    // ========== 应用状态 ==========
    // class 放在 <body>：Grok 用 next-themes 管理 <html> 的 className，
    // 放 html 上有被整体覆盖的风险。
    function apply() {
        const body = document.body;
        if (!body) return;

        const chatW = effectiveChat();
        const pageW = effectivePage(chatW);

        body.classList.toggle('gk-wide', !!settings.wide);
        body.classList.toggle('gk-density-compact', settings.density === 'compact');
        body.classList.toggle('gk-density-loose', settings.density === 'loose');

        body.style.setProperty('--gk-chat-w', chatW + 'px');
        body.style.setProperty('--gk-page-w', pageW + 'px');
        document.documentElement.style.setProperty('--gk-chat-w', chatW + 'px');
        document.documentElement.style.setProperty('--gk-page-w', pageW + 'px');

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
            ? `页面已加宽（${effectiveChat()}px）`
            : '页面已恢复原宽');
    }

    // 点 ± 后从「自动」切换成手动宽度
    function stepWide(dir) {
        const cur = effectiveChat();
        const next = Math.min(wideCap(), Math.max(nativeChat(), cur + dir * WIDE_STEP));
        if (next === cur) return;
        settings.wide = true;
        settings.width = next;
        saveSettings();
        apply();
        showToast(`页面宽度 ${next}px`);
    }

    function setDensity(name) {
        if (DENSITY_LIST.indexOf(name) < 0 || settings.density === name) return;
        setSetting('density', name);
        showToast(`布局密度：${DENSITY_LABEL[name]}`);
    }

    // ========== 悬浮面板 ==========
    function openPanel() {
        clearTimeout(closeTimer);
        if (panelEl) panelEl.classList.add('gk-open');
    }

    function closePanel(delay) {
        clearTimeout(closeTimer);
        closeTimer = setTimeout(() => {
            if (panelEl) panelEl.classList.remove('gk-open');
        }, delay || 0);
    }

    function initSettingsUI() {
        if (document.getElementById('gk-ui')) return;

        const root = document.createElement('div');
        root.id = 'gk-ui';
        root.innerHTML = `
            <div id="gk-panel">
                <div class="gk-head">Grok 助手</div>
                <div class="gk-pane">
                    <div class="gk-row">
                        <span>布局密度</span>
                        <span class="gk-seg">
                            <button type="button" data-density="standard">标准</button>
                            <button type="button" data-density="compact">紧凑</button>
                            <button type="button" data-density="loose">宽松</button>
                        </span>
                    </div>
                    <div class="gk-row" data-k="wide"><span>页面加宽</span><i class="gk-sw"></i></div>
                    <div class="gk-row">
                        <span>宽度<i class="gk-auto">自动</i></span>
                        <span class="gk-stepper">
                            <button type="button" data-step="-1" title="变窄">−</button>
                            <b data-val>0px</b>
                            <button type="button" data-step="1" title="变宽">+</button>
                        </span>
                    </div>
                    <div class="gk-tip">Alt + W 快速切换加宽</div>
                </div>
            </div>
            <button type="button" id="gk-btn" title="Grok 助手设置">${GEAR_SVG}</button>
        `;

        document.body.appendChild(root);
        panelEl = root.querySelector('#gk-panel');

        // 鼠标移入展开，移出收起（留 300ms 缓冲，方便移到面板上）
        root.addEventListener('mouseenter', () => openPanel());
        root.addEventListener('mouseleave', () => closePanel(300));

        root.querySelector('#gk-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            if (panelEl.classList.contains('gk-open')) closePanel();
            else openPanel();
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
            const row = e.target.closest('.gk-row[data-k]');
            if (!row) return;
            e.stopPropagation();
            toggleWide();
        });

        syncUI();
    }

    function syncUI() {
        if (!panelEl) return;
        const w = effectiveChat();

        panelEl.querySelectorAll('.gk-row[data-k]').forEach((row) => {
            row.classList.toggle('gk-on', !!settings[row.getAttribute('data-k')]);
        });
        panelEl.querySelectorAll('[data-density]').forEach((btn) => {
            btn.classList.toggle('gk-active', btn.getAttribute('data-density') === settings.density);
        });

        const val = panelEl.querySelector('[data-val]');
        if (val) val.textContent = w + 'px';

        const autoTag = panelEl.querySelector('.gk-auto');
        if (autoTag) autoTag.classList.toggle('gk-show', !settings.width);

        const minus = panelEl.querySelector('button[data-step="-1"]');
        const plus = panelEl.querySelector('button[data-step="1"]');
        if (minus) minus.disabled = w <= nativeChat();
        if (plus) plus.disabled = w >= wideCap();

        const btn = document.getElementById('gk-btn');
        if (btn) {
            btn.title = settings.wide
                ? `Grok 助手设置：页面已加宽至 ${w}px（Alt+W 切换）`
                : 'Grok 助手设置：点击加宽页面（Alt+W）';
        }
    }

    // ========== 快捷键 ==========
    function initShortcut() {
        document.addEventListener('keydown', (e) => {
            if (!e.altKey || e.ctrlKey || e.metaKey) return;
            if (e.code !== 'KeyW' && e.key.toLowerCase() !== 'w') return;
            e.preventDefault();
            e.stopPropagation();
            toggleWide();
        }, true);
    }

    // ========== 启动 ==========
    function bootstrap() {
        if (window.__grokHelperLoaded) return;
        window.__grokHelperLoaded = true;
        console.log('[Grok助手] v1.0.0 已加载');

        injectCSS();
        initSettingsUI();
        initShortcut();

        window.addEventListener('resize', apply);
        apply();
        // 聊天页是异步挂载的，容器出现后再补算一次上限
        [600, 1500, 3000].forEach((t) => setTimeout(apply, t));
        log('已启用，密度：' + settings.density + '，宽度：' + effectiveChat() + 'px');
    }

    // 样式要在首屏渲染前就位，否则会先看到原生布局再跳变
    injectCSS();
    if (document.body) apply();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }
})();
