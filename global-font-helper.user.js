// ==UserScript==
// @name         全局字体与文字颜色 - Global Font Helper
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  给所有网页统一设置字体与文字颜色：字体默认苹果系统字体栈，颜色默认 #0b214a，可在 Tampermonkey 菜单里随时切换，设置跨站持久生效
// @author       You
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @noframes
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/alphatok/monkey-script/main/global-font-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/alphatok/monkey-script/main/global-font-helper.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ========== 可选项 ==========
    // 字体：优先用系统自带、屏幕显示清晰的字体栈，不加载网络字体
    const FONTS = [
        {
            id: 'apple',
            label: '苹果系统默认',
            stack: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Helvetica Neue", "Microsoft YaHei", sans-serif'
        },
        {
            id: 'pingfang',
            label: '苹方 PingFang SC',
            stack: '"PingFang SC", "Hiragino Sans GB", -apple-system, "Microsoft YaHei", sans-serif'
        },
        {
            id: 'source',
            label: '思源黑体 / Noto Sans SC',
            stack: '"Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif'
        },
        {
            id: 'yahei',
            label: '微软雅黑',
            stack: '"Microsoft YaHei", "PingFang SC", -apple-system, sans-serif'
        },
        {
            id: 'wenkai',
            label: '霞鹜文楷（阅读向）',
            stack: '"LXGW WenKai", "LXGW WenKai Screen", "PingFang SC", "Microsoft YaHei", serif'
        }
    ];

    // 颜色：默认第一个
    const COLORS = [
        { hex: '#0b214a', label: '深海军蓝', rgb: '11, 33, 74' },
        { hex: '#0a2240', label: '藏青', rgb: '10, 34, 64' },
        { hex: '#002336', label: '墨蓝', rgb: '0, 35, 54' },
        { hex: '#002f78', label: '宝蓝', rgb: '0, 47, 120' }
    ];

    const DEFAULTS = {
        enabled: true,
        font: 'apple',
        color: '#0b214a',
        scope: 'smart' // smart = 跳过链接/按钮/代码等；all = 所有文字
    };

    const KEY = 'gfc.settings.v1';
    const STYLE_ID = 'gfc-style';
    const TOAST_ID = 'gfc-toast';

    // 图标字体常见类名，命中后不动它的 font-family，否则图标会变成方块
    const ICON_SELECTOR = ':not(i):not(svg):not(svg *):not([class~="fa"]):not([class*="fa-"]):not([class*="icon"]):not([class*="glyphicon"]):not([class*="material-symbols"]):not([class*="material-icons"]):not([class~="bi"]):not([class*="ri-"])';
    // 等宽内容保持等宽，改比例字体后代码会错位
    const MONO_SELECTOR = ':not(code):not(pre):not(kbd):not(samp):not(tt)';
    // 智能模式下不染色的元素：链接、按钮、表单、代码、图标
    const SMART_SELECTOR = ':not(a):not(button):not([role="button"]):not(input):not(textarea):not(select):not(option):not(code):not(pre):not(kbd):not(samp):not(mark):not(svg):not(svg *):not([class*="btn"]):not([class*="button"]):not([class*="badge"]):not([class*="chip"]):not([class*="tag"]):not([class*="icon"])';

    const CSS = `
        /* ========== 字体 ========== */
        html.gfc-font body,
        html.gfc-font body ${ICON_SELECTOR}${MONO_SELECTOR} {
            font-family: var(--gfc-font) !important;
        }

        /* ========== 文字颜色 ========== */
        /* 智能模式：只染正文，链接/按钮/表单/代码/图标保留站点原色 */
        html.gfc-color[data-gfc-scope="smart"] body,
        html.gfc-color[data-gfc-scope="smart"] body ${SMART_SELECTOR} {
            color: var(--gfc-color) !important;
        }
        /* 全部模式：除了 svg 图标，其他文字一律染色 */
        html.gfc-color[data-gfc-scope="all"] body,
        html.gfc-color[data-gfc-scope="all"] body :not(svg):not(svg *) {
            color: var(--gfc-color) !important;
        }
    `;

    // ========== 设置读写（GM 存储，跨站生效） ==========
    const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

    function loadSettings() {
        let raw = null;
        try {
            raw = hasGM ? GM_getValue(KEY, null) : localStorage.getItem(KEY);
        } catch (e) {
            raw = null;
        }
        let saved = {};
        if (raw) {
            try {
                saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
            } catch (e) {
                saved = {};
            }
        }
        const out = Object.assign({}, DEFAULTS, saved);
        if (!FONTS.some((f) => f.id === out.font)) out.font = DEFAULTS.font;
        if (!COLORS.some((c) => c.hex === out.color)) out.color = DEFAULTS.color;
        if (out.scope !== 'smart' && out.scope !== 'all') out.scope = DEFAULTS.scope;
        out.enabled = out.enabled !== false;
        return out;
    }

    function saveSettings() {
        const raw = JSON.stringify(settings);
        try {
            if (hasGM) GM_setValue(KEY, raw);
            else localStorage.setItem(KEY, raw);
        } catch (e) {
            console.warn('[全局字体] 保存设置失败:', e);
        }
    }

    let settings = loadSettings();

    // ========== 样式注入 ==========
    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);
    }

    function fontOf(id) {
        return FONTS.find((f) => f.id === id) || FONTS[0];
    }

    function colorOf(hex) {
        return COLORS.find((c) => c.hex === hex) || COLORS[0];
    }

    // 深色页面上强行染成深蓝色会直接看不见，这种情况下自动不覆盖颜色
    function luminance(colorStr) {
        const m = String(colorStr).match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const parts = m[1].split(',').map((n) => parseFloat(n));
        const a = parts.length > 3 ? parts[3] : 1;
        if (!(a > 0.5)) return null; // 透明，判断不了
        return (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255;
    }

    function pageIsDark() {
        // 从某个元素往上找最近的实色背景
        const nearestBg = (el) => {
            let node = el;
            while (node) {
                const lum = luminance(getComputedStyle(node).backgroundColor);
                if (lum !== null) return lum;
                node = node.parentElement;
            }
            return null;
        };

        const fromBody = nearestBg(document.body || document.documentElement);
        if (fromBody !== null) return fromBody < 0.45;

        // 底色挂在某个容器 / 图片上时，直接取视口中心那块区域的实际背景
        const hit = document.elementFromPoint(
            Math.round(window.innerWidth / 2),
            Math.round(Math.min(window.innerHeight / 2, 400))
        );
        if (hit) {
            const sampled = nearestBg(hit);
            if (sampled !== null) return sampled < 0.45;
        }

        // 实在判断不了，就看默认文字色：浅色文字通常就是深色主题
        const textLum = document.body ? luminance(getComputedStyle(document.body).color) : null;
        return textLum !== null && textLum > 0.6;
    }

    function apply() {
        const html = document.documentElement;
        if (!html) return;

        html.style.setProperty('--gfc-font', fontOf(settings.font).stack);
        html.style.setProperty('--gfc-color', settings.color);
        html.dataset.gfcScope = settings.scope;

        const wantColor = settings.enabled && !pageIsDark();
        html.classList.toggle('gfc-font', settings.enabled);
        html.classList.toggle('gfc-color', wantColor);
    }

    // ========== 轻提示 ==========
    function toast(msg) {
        if (!document.body) return;
        let el = document.getElementById(TOAST_ID);
        if (el) el.remove();
        el = document.createElement('div');
        el.id = TOAST_ID;
        el.textContent = msg;
        el.style.cssText = [
            'position:fixed', 'left:50%', 'bottom:32px', 'transform:translateX(-50%)',
            'background:rgba(17,24,39,.9)', 'color:#fff', 'font-size:13px',
            'line-height:1.5', 'padding:8px 16px', 'border-radius:8px',
            'z-index:2147483647', 'pointer-events:none',
            'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
            'transition:opacity .25s'
        ].join(';');
        document.body.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; }, 1400);
        setTimeout(() => { el.remove(); }, 1750);
    }

    // ========== Tampermonkey 菜单 ==========
    let menuIds = [];

    function unregisterMenus() {
        if (typeof GM_unregisterMenuCommand !== 'function') return;
        menuIds.forEach((id) => {
            try { GM_unregisterMenuCommand(id); } catch (e) { /* 忽略 */ }
        });
        menuIds = [];
    }

    function registerMenus() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        unregisterMenus();

        const add = (title, fn) => {
            try {
                const id = GM_registerMenuCommand(title, fn);
                if (id !== undefined) menuIds.push(id);
            } catch (e) {
                console.warn('[全局字体] 注册菜单失败:', e);
            }
        };

        const change = (fn, msg) => () => {
            fn();
            saveSettings();
            apply();
            registerMenus(); // 重注册，让菜单里的 ✓ 和当前状态同步
            toast(msg);
        };

        add(
            settings.enabled ? '✅ 已启用（点击停用）' : '⛔ 已停用（点击启用）',
            change(() => { settings.enabled = !settings.enabled; },
                settings.enabled ? '已停用字体与颜色设置' : '已启用字体与颜色设置')
        );

        FONTS.forEach((f) => {
            add(
                (settings.font === f.id ? '✓ ' : '　') + '字体：' + f.label,
                change(() => { settings.font = f.id; }, '字体：' + f.label)
            );
        });

        COLORS.forEach((c) => {
            add(
                (settings.color === c.hex ? '✓ ' : '　') + `文字颜色：${c.label} ${c.hex}`,
                change(() => { settings.color = c.hex; }, `文字颜色：${c.label} ${c.hex}`)
            );
        });

        add(
            (settings.scope === 'smart' ? '✓ ' : '　') + '颜色范围：智能（跳过链接/按钮/代码）',
            change(() => { settings.scope = 'smart'; }, '颜色范围：智能')
        );
        add(
            (settings.scope === 'all' ? '✓ ' : '　') + '颜色范围：全部文字',
            change(() => { settings.scope = 'all'; }, '颜色范围：全部文字')
        );

        add('↺ 恢复默认设置', change(() => {
            settings = Object.assign({}, DEFAULTS);
        }, '已恢复默认设置'));

        add('ⓘ 当前设置：' + fontOf(settings.font).label + ' / ' + colorOf(settings.color).hex, () => {
            toast(`${fontOf(settings.font).label} · ${colorOf(settings.color).hex} · 范围：${settings.scope === 'smart' ? '智能' : '全部'}`);
        });
    }

    // ========== 启动 ==========
    function bootstrap() {
        ensureStyle();
        apply();
        registerMenus();

        // document-start 时还没有 body，颜色深色判断和菜单提示都等 DOM 就绪再来一次
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', apply, { once: true });
        } else {
            apply();
        }

        console.log('[全局字体] v1.0.0 已加载：' + fontOf(settings.font).label + ' / ' + settings.color);
    }

    bootstrap();
})();
