// ==UserScript==
// @name         小红书助手 - XHS Helper
// @namespace    http://tampermonkey.net/
// @version      1.1.1
// @description  小红书笔记详情弹窗增强：正文区域加宽（弹窗整体约原生 1.5 倍，宽度自适应且可手动微调），Alt+W 一键切换
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
    const STORE_KEY = 'xhs-helper.settings.v2';
    // width = 0 表示「自适应」：按屏幕算出能撑到的最大宽度（目标见 autoWidth）
    const DEFAULTS = { wide: true, width: 0 };

    // 站点原生正文列宽度：视口 ≥1424px 为 440px，1192-1423 为 400px，960-1191 为 360px
    const MIN_WIDTH = 360;
    const MAX_WIDTH = 900;
    const STEP = 40;

    // 自适应参数：弹窗整体按原生宽度的 1.5 倍，文字列不低于 660（原生 440 的 1.5 倍）
    const SCALE = 1.5;
    const MIN_TEXT = 660;
    // 站点 .note-detail-mask 的 --undertake-gap，用于复算原生图片列宽度
    const GAP = 24;

    let settings = Object.assign({}, DEFAULTS, loadSettings());

    // ========== 样式 ==========
    // 正文列（.interaction-container）的宽度由站点的 CSS 变量控制：
    //   :root { --interaction-width: 440px }（断点 440 / 400 / 360）
    //   .interaction-container { width: var(--interaction-width) }
    // 整个弹窗的宽度则是 JS 算的，写在 #noteContainer 的 style 上：
    //   --undertake-container-width: calc(--undertake-media-width + --undertake-interaction-width)
    //   width: var(--undertake-container-width)
    //   transform: translate((100vw - 容器宽) / 2, gap)   ← 靠这个水平居中
    // 但页面水合后 React 会把这三个值算成固定 px 写回内联样式，变量就不再被引用了，
    // 只改变量会出现"内容撑开了、外框和位移没跟上"，表现就是右边溢出屏幕。
    // 所以宽度、位移、变量三处一起用 !important 覆盖，两边都能对上。
    //
    // 坑：站点的图片列宽度是 max(正文列宽, ...)，正文一变宽图片列会被一起撑开，
    // 结果是"两列等宽"，图片只是在自己的框里居中留白。这里把「原生正文列宽」代进
    // 同一个公式锁住图片列，多出来的宽度才真正落到正文上。
    //
    // 只作用于桌面布局：<960px 时站点是整屏移动端排版，变量值本身是 100vw，强行改会错位。
    const CSS = `
        @media (min-width: 960px) {
            html.xhs-wide #noteContainer {
                /* 站点原生正文列宽，只用来推算原生弹窗有多宽，不直接生效 */
                --xhs-native-iw: 440px;
                --xhs-native-media: max(
                    var(--xhs-native-iw),
                    min(calc((100vh - 2 * var(--undertake-gap, 24px)) * 0.75),
                        calc(100vw - var(--xhs-native-iw) - 4 * var(--undertake-gap, 24px) - 80px))
                );

                /* 正文列：JS 写入目标值，同时兜底不超过一屏（左右各留 40px） */
                --xhs-w: min(var(--xhs-note-width, ${MIN_TEXT}px), calc(100vw - 80px - var(--xhs-native-media)));
                --xhs-total: calc(var(--xhs-native-media) + var(--xhs-w));

                /* 1) 外框宽度 */
                width: var(--xhs-total) !important;
                /* 2) 水平居中：站点只做平移不做缩放，位移必须按新宽度重算 */
                transform: translate(max(0px, calc((100vw - var(--xhs-total)) / 2)), var(--undertake-gap, 24px)) scale(1) !important;

                /* 3) 变量：内联样式还在引用变量时也保持一致 */
                --undertake-container-width: var(--xhs-total) !important;
                --undertake-media-width: var(--xhs-native-media) !important;
                --undertake-interaction-width: var(--xhs-w);
            }
            html.xhs-wide #noteContainer .interaction-container {
                width: var(--xhs-w) !important;
                /* 兜底：万一图片列实际比估算的宽，让正文列可以被压缩，不会顶出弹窗外框 */
                min-width: 0 !important;
                flex-shrink: 1 !important;
            }
        }
        @media (min-width: 960px) and (max-width: 1191.98px) {
            html.xhs-wide #noteContainer { --xhs-native-iw: 360px; }
        }
        @media (min-width: 1192px) and (max-width: 1423.98px) {
            html.xhs-wide #noteContainer { --xhs-native-iw: 400px; }
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
        .xhs-auto {
            display: none; margin-left: 4px; padding: 0 3px; font-style: normal; font-size: 10px;
            line-height: 14px; color: #ff2442; border: 1px solid currentColor; border-radius: 3px;
        }
        .xhs-auto.xhs-show { display: inline-block; }
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
        if (!isFinite(n)) return MIN_TEXT;
        return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
    }

    // 站点原生正文列宽（跟着断点走，见 CSS 里的 --xhs-native-iw）
    function nativeIW() {
        const vw = window.innerWidth;
        if (vw >= 1424) return 440;
        if (vw >= 1192) return 400;
        return 360;
    }

    // 复算站点算出的图片列宽度：竖图按高度撑（3:4），横图受剩余宽度限制
    function nativeMediaWidth() {
        const iw = nativeIW();
        const byHeight = (window.innerHeight - 2 * GAP) * 0.75;
        const byWidth = window.innerWidth - iw - 4 * GAP - 80;
        return Math.max(iw, Math.min(byHeight, byWidth));
    }

    // 正文列最多能占多宽：弹窗左右各留 40px，否则站点只做平移不缩放，右边会被裁掉
    function viewportCap() {
        return Math.floor((window.innerWidth - 80 - nativeMediaWidth()) / STEP) * STEP;
    }

    // 自适应：把弹窗整体做到原生宽度的 1.5 倍，多出来的宽度全给正文列
    function autoWidth() {
        const media = nativeMediaWidth();
        const target = SCALE * (media + nativeIW()) - media;
        const want = Math.max(MIN_TEXT, target);
        return Math.min(Math.round(want / STEP) * STEP, viewportCap());
    }

    function effectiveWidth() {
        if (!settings.width) return autoWidth();
        return Math.min(clampWidth(settings.width), viewportCap());
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

    // 点 ± 后从「自适应」切换成手动宽度
    function stepWidth(dir) {
        const cur = effectiveWidth();
        const next = Math.min(viewportCap(), Math.max(MIN_WIDTH, cur + dir * STEP));
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
                <span>宽度<i class="xhs-auto">自动</i></span>
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

        const autoTag = panelEl.querySelector('.xhs-auto');
        if (autoTag) autoTag.classList.toggle('xhs-show', !settings.width);

        const minus = panelEl.querySelector('button[data-step="-1"]');
        const plus = panelEl.querySelector('button[data-step="1"]');
        if (minus) minus.disabled = w <= MIN_WIDTH;
        if (plus) plus.disabled = w >= viewportCap();
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
