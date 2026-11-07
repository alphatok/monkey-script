// ==UserScript==
// @name         小红书助手 - XHS Helper
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  小红书笔记详情弹窗增强：正文文本区域加宽（默认 560px，可调），Alt+W 一键切换，设置本地保存
// @author       You
// @match        https://www.xiaohongshu.com/*
// @match        https://xiaohongshu.com/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/alphatok/monkey-script/main/xhs-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/alphatok/monkey-script/main/xhs-helper.user.js
// ==/UserScript==

(function () {
    'use strict';

    const DEBUG = true;
    const log = (...args) => DEBUG && console.log('[小红书助手]', ...args);

    // 设置持久化（@grant none 下 localStorage 与站点同源可用）
    const STORE_KEY = 'xhs-helper.settings.v1';
    const DEFAULTS = { wide: true, width: 560 };

    // 站点原生正文列宽度：视口 ≥1424px 为 440px，1192-1423 为 400px，960-1191 为 360px
    const MIN_WIDTH = 360;
    const MAX_WIDTH = 900;
    const STEP = 40;

    let settings = Object.assign({}, DEFAULTS, loadSettings());

    // ========== 样式 ==========
    // 正文列（.interaction-container）的宽度由站点的 CSS 变量控制：
    //   :root { --interaction-width: 440px }（断点 440 / 400 / 360）
    //   .interaction-container { width: var(--interaction-width) }
    // 但整个弹窗的宽度是 JS 内联算出来的，写死在 #noteContainer 的 style 上：
    //   --undertake-container-width: calc(--undertake-media-width + --undertake-interaction-width)
    //   width: var(--undertake-container-width)
    // 所以两个变量必须一起改，否则正文列变宽后会把内容挤出弹窗外框。
    // 内联样式里的 calc 引用的是元素自身的变量，因此在 #noteContainer 上重新声明即可生效，
    // 不需要改动站点 DOM，也不会被 React 重渲染冲掉。
    //
    // 只作用于桌面布局：<960px 时站点是整屏移动端排版，变量值本身是 100vw，强行改会错位。
    // 再按视口兜底一次（min(...)），保证弹窗最宽不超过一屏，避免小屏上右侧被裁掉。
    const CSS = `
        @media (min-width: 960px) {
            html.xhs-wide #noteContainer {
                --xhs-w: min(var(--xhs-note-width, ${DEFAULTS.width}px), calc((100vw - 160px) / 2));
                --interaction-width: var(--xhs-w);
                --undertake-interaction-width: var(--xhs-w);
            }
        }

        /* ========== 悬浮按钮 & 设置面板 ========== */
        #xhs-ui, #xhs-ui * { box-sizing: border-box; }
        #xhs-ui {
            position: fixed; right: 14px; bottom: 96px; width: 40px; height: 40px;
            z-index: 2147483647;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
            font-size: 13px; line-height: 1.4; text-align: left;
        }
        #xhs-btn {
            width: 40px; height: 40px; padding: 0; border-radius: 999px; cursor: pointer;
            border: 1px solid rgba(0,0,0,.08);
            background: rgba(255,255,255,.92); color: #ff2442;
            display: flex; align-items: center; justify-content: center;
            font-size: 15px; font-weight: 700; line-height: 1;
            box-shadow: 0 2px 10px rgba(0,0,0,.12);
            opacity: .55; transition: opacity .15s, background .15s, color .15s;
        }
        #xhs-ui:hover #xhs-btn { opacity: 1; }
        #xhs-btn.xhs-on { background: #ff2442; border-color: #ff2442; color: #fff; opacity: .95; }
        #xhs-panel {
            position: absolute; right: 0; bottom: 44px; width: 218px; padding: 6px;
            display: none; color: #333; background: #fff;
            border: 1px solid rgba(0,0,0,.08); border-radius: 12px;
            box-shadow: 0 8px 28px rgba(0,0,0,.16);
        }
        #xhs-panel.xhs-open { display: block; }
        .xhs-row {
            display: flex; align-items: center; justify-content: space-between; gap: 10px;
            padding: 7px 8px; border-radius: 8px; cursor: pointer; user-select: none;
        }
        .xhs-row:hover { background: rgba(0,0,0,.04); }
        .xhs-sw {
            position: relative; flex: 0 0 auto; width: 32px; height: 18px;
            border-radius: 999px; background: #d9d9d9; transition: background .15s;
        }
        .xhs-sw::after {
            content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
            border-radius: 50%; background: #fff; transition: transform .15s;
            box-shadow: 0 1px 2px rgba(0,0,0,.15);
        }
        .xhs-row.xhs-on .xhs-sw { background: #ff2442; }
        .xhs-row.xhs-on .xhs-sw::after { transform: translateX(14px); }

        /* 宽度调节行 */
        .xhs-stepper { display: flex; align-items: center; gap: 4px; cursor: default; }
        .xhs-stepper button {
            width: 22px; height: 22px; padding: 0; border-radius: 6px; cursor: pointer;
            border: 1px solid rgba(0,0,0,.1); background: #f7f7f7; color: #333;
            font-size: 14px; line-height: 1; font-family: inherit;
        }
        .xhs-stepper button:hover { background: #efefef; }
        .xhs-stepper button:disabled { opacity: .35; cursor: not-allowed; }
        .xhs-stepper b {
            min-width: 52px; text-align: center; font-weight: 600; font-size: 12px; color: #ff2442;
        }
        .xhs-tip {
            padding: 2px 8px 4px; font-size: 11px; color: #999;
            border-top: 1px solid rgba(0,0,0,.06); margin-top: 4px; padding-top: 6px;
        }
        #xhs-toast {
            position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%);
            z-index: 2147483647; padding: 8px 16px; border-radius: 8px;
            background: rgba(0,0,0,.82); color: #fff; font-size: 13px;
            pointer-events: none; opacity: 0; transition: opacity .2s;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
        }
        #xhs-toast.xhs-show { opacity: 1; }
    `;

    function injectCSS() {
        if (document.getElementById('xhs-style')) return;
        const style = document.createElement('style');
        style.id = 'xhs-style';
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

    // ========== 核心：打状态类 + 写入目标宽度 ==========
    // 宽度值写在 <html> 的行内变量上，CSS 里的 var(--xhs-note-width) 读它，
    // 这样调宽度不需要重建样式表，也不会被 React 重渲染冲掉。
    function apply() {
        const html = document.documentElement;
        html.classList.toggle('xhs-wide', !!settings.wide);
        html.style.setProperty('--xhs-note-width', effectiveWidth() + 'px');
        syncUI();
    }

    function clampWidth(w) {
        const n = Math.round(Number(w) / STEP) * STEP;
        if (!isFinite(n)) return DEFAULTS.width;
        return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
    }

    // 弹窗总宽 = 图片列 + 正文列，而图片列最小也等于正文列宽，
    // 所以正文列最多占到半屏左右，再宽右侧就会被裁掉（站点只用 transform 平移，不做缩放）。
    // 这里按当前视口算一个实际上限，让面板上的「+」在到顶时能正确置灰。
    function viewportMax() {
        const byScreen = Math.floor((window.innerWidth - 160) / 2 / STEP) * STEP;
        return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, byScreen));
    }

    function effectiveWidth() {
        return Math.min(clampWidth(settings.width), viewportMax());
    }

    function setSetting(key, value) {
        settings[key] = value;
        saveSettings();
        apply();
    }

    function toggleWide() {
        setSetting('wide', !settings.wide);
        toast(settings.wide ? `正文区域已加宽（${effectiveWidth()}px）` : '正文区域已恢复原宽');
    }

    function stepWidth(dir) {
        const cur = effectiveWidth();
        const next = Math.min(viewportMax(), Math.max(MIN_WIDTH, cur + dir * STEP));
        if (next === cur) return;
        settings.wide = true;
        setSetting('width', next);
        toast(`正文宽度 ${next}px`);
    }

    // ========== 悬浮 UI ==========
    let panelEl = null;
    let btnEl = null;
    let closeTimer = null;

    function buildUI() {
        if (document.getElementById('xhs-ui')) return;

        const root = document.createElement('div');
        root.id = 'xhs-ui';

        const panel = document.createElement('div');
        panel.id = 'xhs-panel';
        panel.innerHTML = `
            <div class="xhs-row" data-k="wide"><span>正文区域加宽</span><i class="xhs-sw"></i></div>
            <div class="xhs-row">
                <span>宽度</span>
                <span class="xhs-stepper">
                    <button type="button" data-step="-1" title="变窄">−</button>
                    <b data-val>${effectiveWidth()}px</b>
                    <button type="button" data-step="1" title="变宽">+</button>
                </span>
            </div>
            <div class="xhs-tip">Alt + W 快速切换</div>
        `;

        const btn = document.createElement('button');
        btn.id = 'xhs-btn';
        btn.type = 'button';
        btn.textContent = '宽';
        btn.title = '小红书助手：点击切换正文区域加宽（Alt+W）';

        root.appendChild(panel);
        root.appendChild(btn);
        // 挂到 <html> 上，避免被 React 重渲染清掉
        document.documentElement.appendChild(root);

        panelEl = panel;
        btnEl = btn;

        // 鼠标移入展开面板，移出收起（留 300ms 缓冲，方便移到面板上）
        root.addEventListener('mouseenter', () => {
            clearTimeout(closeTimer);
            panel.classList.add('xhs-open');
        });
        root.addEventListener('mouseleave', () => {
            closeTimer = setTimeout(() => panel.classList.remove('xhs-open'), 300);
        });

        // 点按钮 = 直接切换加宽
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleWide();
        });

        panel.addEventListener('click', (e) => {
            const stepBtn = e.target.closest('button[data-step]');
            if (stepBtn) {
                e.stopPropagation();
                stepWidth(Number(stepBtn.getAttribute('data-step')));
                return;
            }
            const row = e.target.closest('.xhs-row[data-k]');
            if (!row) return;
            e.stopPropagation();
            const k = row.getAttribute('data-k');
            setSetting(k, !settings[k]);
        });

        syncUI();
    }

    function syncUI() {
        if (!btnEl || !panelEl) return;
        const w = effectiveWidth();
        btnEl.classList.toggle('xhs-on', !!settings.wide);
        btnEl.title = settings.wide
            ? `小红书助手：正文已加宽至 ${w}px（Alt+W 切换）`
            : '小红书助手：点击加宽正文区域（Alt+W）';

        panelEl.querySelectorAll('.xhs-row[data-k]').forEach((row) => {
            row.classList.toggle('xhs-on', !!settings[row.getAttribute('data-k')]);
        });

        const val = panelEl.querySelector('[data-val]');
        if (val) val.textContent = w + 'px';

        const minus = panelEl.querySelector('button[data-step="-1"]');
        const plus = panelEl.querySelector('button[data-step="1"]');
        if (minus) minus.disabled = w <= MIN_WIDTH;
        if (plus) plus.disabled = w >= viewportMax();
    }

    let toastEl = null;
    let toastTimer = null;
    function toast(msg) {
        if (!toastEl) {
            toastEl = document.createElement('div');
            toastEl.id = 'xhs-toast';
            document.documentElement.appendChild(toastEl);
        }
        toastEl.textContent = msg;
        toastEl.classList.add('xhs-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.remove('xhs-show'), 1400);
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
        // 窗口尺寸变化会改变可用宽度上限，重新算一次
        window.addEventListener('resize', apply);
        apply();
        log('已启用，加宽：' + settings.wide + '，宽度：' + effectiveWidth() + 'px');
    }
})();
