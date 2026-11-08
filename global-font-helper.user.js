// ==UserScript==
// @name         全局字体与文字颜色 - Global Font Helper
// @namespace    http://tampermonkey.net/
// @version      1.3.2
// @description  给所有网页统一设置字体与文字颜色：内置 8 套中英文友好字体栈（含 HarmonyOS Sans、MiSans、思源黑体、普惠体、霞鹜文楷），颜色默认 #0b214a，可在 Tampermonkey 菜单里随时切换，设置跨站持久生效；自动跳过页面里的深色区域（如元宝隐身模式的输入框）；可开启报纸模式（纸色底 + 衬线字 + 鼠标暖光）
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
    // 字体：优先用本机已安装的字体，不加载网络字体。
    // 中英混排顺序：西文放前面（Inter 有就用 Inter，没有则回退到中文字体自带的西文），
    // 中文字体放在 -apple-system 之前，否则中文会被苹方抢先接管。
    // probe 用于检测本机是否真的装了这款字，未安装的会在菜单里标注。
    //
    // 官方获取渠道（均免费商用）：
    //   HarmonyOS Sans  https://developer.harmonyos.com/cn/design/resource
    //   MiSans          https://hyperos.mi.com/font
    //   思源黑体         https://github.com/adobe-fonts/source-han-sans
    //   阿里巴巴普惠体    https://www.alibabafonts.com
    //   霞鹜文楷         https://github.com/lxgw/LxgwWenKai
    const FONTS = [
        {
            id: 'apple',
            label: '苹果系统默认',
            stack: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Helvetica Neue", "Microsoft YaHei", sans-serif',
            probe: null // 系统字体，恒可用
        },
        {
            id: 'harmony',
            label: 'HarmonyOS Sans SC（中英同源·综合首选）',
            stack: '"Inter", "HarmonyOS Sans SC", "HarmonyOS Sans", -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
            probe: 'HarmonyOS Sans SC'
        },
        {
            id: 'misans',
            label: 'MiSans（现代 UI·数字清晰）',
            stack: '"Inter", "MiSans", "MiSans VF", -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
            probe: 'MiSans'
        },
        {
            id: 'source',
            label: '思源黑体 / Noto Sans SC（开源通用）',
            stack: '"Inter", "Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
            probe: 'Source Han Sans SC'
        },
        {
            id: 'alibaba',
            label: '阿里巴巴普惠体 3.0（字重最全）',
            stack: '"Inter", "Alibaba PuHuiTi 3.0", "Alibaba PuHuiTi", -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
            probe: 'Alibaba PuHuiTi 3.0'
        },
        {
            id: 'wenkai',
            label: '霞鹜文楷（长文阅读向）',
            stack: '"LXGW WenKai", "LXGW WenKai Screen", "Inter", "PingFang SC", "Songti SC", serif',
            probe: 'LXGW WenKai'
        },
        {
            id: 'pingfang',
            label: '苹方 PingFang SC',
            stack: '"PingFang SC", "Hiragino Sans GB", -apple-system, "Microsoft YaHei", sans-serif',
            probe: 'PingFang SC'
        },
        {
            id: 'yahei',
            label: '微软雅黑',
            stack: '"Microsoft YaHei", "PingFang SC", -apple-system, sans-serif',
            probe: 'Microsoft YaHei'
        }
    ];

    // 颜色：默认第一个
    const COLORS = [
        { hex: '#0b214a', label: '深海军蓝', rgb: '11, 33, 74' },
        { hex: '#0a2240', label: '藏青', rgb: '10, 34, 64' },
        { hex: '#002336', label: '墨蓝', rgb: '0, 35, 54' },
        { hex: '#002f78', label: '宝蓝', rgb: '0, 47, 120' }
    ];

    // 报纸模式：纸色（新闻纸那种偏黄的暖白，不是纯白）
    // 后三个取自实拍旧报纸的纸面色，比纯色更接近「翻出来的旧报纸」
    const PAPER_COLORS = [
        { hex: '#f3ead8', label: '新闻纸（米黄）' },
        { hex: '#fbf7ee', label: '象牙白' },
        { hex: '#e8dac7', label: '复古报纸' },
        { hex: '#e6daba', label: '泛黄报纸' },
        { hex: '#eece9b', label: '旧报纸（深黄）' },
        { hex: '#f1f1ec', label: '冷灰纸' },
        { hex: '#e2d3b6', label: '牛皮纸' }
    ];

    // 纸纹：一层极淡的噪点，叠在纸色上，避免大面积纯色看着像 PPT 底色
    const PAPER_GRAIN = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E"
        + "%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E"
        + "%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E"
        + "%3Crect width='160' height='160' filter='url(%23n)' opacity='0.05'/%3E%3C/svg%3E\")";

    // 报纸字体：西文用 Times/Georgia 这类印刷衬线，中文落到思源宋体 / 宋体
    const PAPER_FONT = '"Iowan Old Style", "Georgia", "Times New Roman", "Source Han Serif SC", "Noto Serif SC", "Songti SC", "SimSun", serif';

    const DEFAULTS = {
        enabled: true,
        font: 'apple',
        color: '#0b214a',
        scope: 'smart', // smart = 跳过链接/按钮/代码等；all = 所有文字
        paper: true,    // 报纸模式：纸色底 + 衬线字
        paperColor: PAPER_COLORS[0].hex,
        glow: true      // 鼠标跟随暖光
    };

    const KEY = 'gfc.settings.v1';
    const STYLE_ID = 'gfc-style';
    const TOAST_ID = 'gfc-toast';
    const PAPER_LAYER_ID = 'gfc-paper-layer';
    const GLOW_ID = 'gfc-glow';

    // 图标字体常见类名，命中后不动它的 font-family，否则图标会变成方块
    const ICON_SELECTOR = ':not(i):not(svg):not(svg *):not([class~="fa"]):not([class*="fa-"]):not([class*="icon"]):not([class*="glyphicon"]):not([class*="material-symbols"]):not([class*="material-icons"]):not([class~="bi"]):not([class*="ri-"])';
    // 等宽内容保持等宽，改比例字体后代码会错位
    const MONO_SELECTOR = ':not(code):not(pre):not(kbd):not(samp):not(tt)';
    // 智能模式下不染色的元素：链接、按钮、表单、代码、图标
    // 注意 `:not(a *)`：链接内部的 h3/span 也必须排除。
    // Google 搜索结果的标题就是 <a><h3>…</h3></a>，只排除 a 本身会让标题被染成正文色，
    // 结果就是整页看不出哪条是链接。按钮、role=link 同理。
    const SMART_SELECTOR = ':not(a):not(a *):not([role="link"]):not([role="link"] *):not(button):not(button *):not([role="button"]):not([role="button"] *):not(input):not(textarea):not(select):not(option):not(code):not(pre):not(kbd):not(samp):not(mark):not(svg):not(svg *):not([class*="btn"]):not([class*="button"]):not([class*="badge"]):not([class*="chip"]):not([class*="tag"]):not([class*="icon"])';

    // 深色容器：整页浅色但局部是深色底（元宝隐身模式输入框 #303030、临时对话 #1D1D1D），
    // 深蓝字压上去就看不清了。运行时给这类容器打 .gfc-dark，这里连同子孙一起放过。
    const DARK_SELECTOR = ':not(.gfc-dark):not(.gfc-dark *)';
    // 自带的 toast 是深底白字，别被染色
    const SELF_SELECTOR = ':not(#gfc-toast):not(#gfc-toast *)';

    const CSS = `
        /* ========== 字体 ========== */
        html.gfc-font body,
        html.gfc-font body ${ICON_SELECTOR}${MONO_SELECTOR} {
            font-family: var(--gfc-font) !important;
        }

        /* ========== 文字颜色 ========== */
        /* 智能模式：只染正文，链接/按钮/表单/代码/图标保留站点原色 */
        html.gfc-color[data-gfc-scope="smart"] body,
        html.gfc-color[data-gfc-scope="smart"] body ${SMART_SELECTOR}${DARK_SELECTOR}${SELF_SELECTOR} {
            color: var(--gfc-color) !important;
        }
        /* 全部模式：除了 svg 图标，其他文字一律染色 */
        html.gfc-color[data-gfc-scope="all"] body,
        html.gfc-color[data-gfc-scope="all"] body :not(svg):not(svg *)${DARK_SELECTOR}${SELF_SELECTOR} {
            color: var(--gfc-color) !important;
        }

        /* ========== 报纸模式 ========== */
        /* 报纸字体：写在普通字体规则之后，同时开启时以衬线为准 */
        html.gfc-paper body,
        html.gfc-paper body ${ICON_SELECTOR}${MONO_SELECTOR} {
            font-family: var(--gfc-paper-font) !important;
        }
        /* 纸色用 multiply 叠层铺满视口：白底变纸色，图片自然带一点旧纸调，
           不动站点任何布局；深色页面由 JS 跳过（叠上去只会发闷）。
           纸纹是一层极淡噪点，重复平铺，避免大面积纯色像 PPT 底色。 */
        #gfc-paper-layer {
            position: fixed; inset: 0; pointer-events: none;
            z-index: 2147483000; mix-blend-mode: multiply;
            background-image: var(--gfc-paper-grain);
            background-repeat: repeat;
            background-size: 160px 160px;
        }
        /* 跟随鼠标的暖光。它挂在 #gfc-paper-layer 内部，不是压在最上层：
           外层是 multiply，光晕在里面把纸色提亮到接近白，乘下去就等于「原样透出」，
           于是纸面被擦亮、而压在下面的墨字完全不受影响——这是唯一能做到
           「提亮纸、绝不给文字蒙白」的写法（overlay / screen 都会把字冲淡）。
           注意：光晕只能活在纸层里，没有纸层就没有光。 */
        #gfc-glow {
            position: absolute; left: 0; top: 0; width: 860px; height: 860px;
            margin: -430px 0 0 -430px; border-radius: 50%;
            pointer-events: none;
            background: radial-gradient(circle 300px at 50% 50%,
                rgba(255, 250, 236, 0.80) 0%,
                rgba(255, 250, 236, 0.40) 55%,
                rgba(255, 250, 236, 0) 100%);
            opacity: 0; transition: opacity 0.35s ease;
            will-change: transform;
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
        if (!PAPER_COLORS.some((p) => p.hex === out.paperColor)) out.paperColor = DEFAULTS.paperColor;
        out.enabled = out.enabled !== false;
        out.paper = out.paper !== false;
        out.glow = out.glow !== false;
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

    // ========== 字体可用性检测 ==========
    // 浏览器没有字体枚举 API，用 canvas 量文字宽度对比通用字体来反推：
    // 若 "某字体, monospace" 的宽度和纯 monospace 不同，说明该字体确实被用上了。
    const FONT_PROBE_TEXT = 'mmmmmmmmmmlli 中文字体测试 ABCabc0123';
    const fontAvailCache = new Map();

    function isFontAvailable(family) {
        if (!family) return true;
        if (fontAvailCache.has(family)) return fontAvailCache.get(family);

        let ok = true;
        try {
            const ctx = document.createElement('canvas').getContext('2d');
            if (ctx) {
                const bases = ['monospace', 'serif', 'sans-serif'];
                const measure = (font) => {
                    ctx.font = `72px ${font}`;
                    return ctx.measureText(FONT_PROBE_TEXT).width;
                };
                const baseWidths = bases.map((b) => measure(b));
                ok = bases.some((b, i) => Math.abs(measure(`"${family}", ${b}`) - baseWidths[i]) > 0.1);
            }
        } catch (e) {
            ok = true; // 检测失败就当可用，避免误报
        }

        fontAvailCache.set(family, ok);
        return ok;
    }

    const isFontReady = (font) => isFontAvailable(font.probe);

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
        html.style.setProperty('--gfc-paper-font', PAPER_FONT);
        html.style.setProperty('--gfc-paper-grain', PAPER_GRAIN);
        html.style.setProperty('--gfc-color', settings.color);
        html.dataset.gfcScope = settings.scope;

        const light = !pageIsDark();
        const wantColor = settings.enabled && light;
        const paperOn = settings.enabled && settings.paper && light;
        html.classList.toggle('gfc-font', settings.enabled);
        html.classList.toggle('gfc-color', wantColor);
        html.classList.toggle('gfc-paper', paperOn);

        syncPaperLayer(paperOn);
        syncGlow(paperOn && settings.glow);

        // 记下自己改完后的状态，属性观察器据此忽略自身引起的变动
        lastHtmlSnapshot = htmlSnapshot();
        scheduleScan();
    }

    // ========== 报纸模式：纸色叠层 + 鼠标暖光 ==========
    let glowEl = null;
    let glowTracking = false;
    let glowActive = false;

    function syncPaperLayer(on) {
        let el = document.getElementById(PAPER_LAYER_ID);
        if (!on) {
            if (el) el.remove();
            return;
        }
        if (!el) {
            el = document.createElement('div');
            el.id = PAPER_LAYER_ID;
            (document.documentElement || document.body).appendChild(el);
        }
        el.style.backgroundColor = settings.paperColor;
    }

    function syncGlow(on) {
        glowActive = on;
        if (!on) {
            if (glowEl) glowEl.style.opacity = '0';
            return;
        }
        // 光晕是「把纸擦亮」，必须挂在纸层里面；没有纸层就没什么可擦的
        const layer = document.getElementById(PAPER_LAYER_ID);
        if (!layer) {
            if (glowEl) glowEl.style.opacity = '0';
            return;
        }
        if (!glowEl || glowEl.parentNode !== layer) {
            if (!glowEl) {
                glowEl = document.createElement('div');
                glowEl.id = GLOW_ID;
            }
            layer.appendChild(glowEl);
        }
        startGlowTracking();
    }

    // 和参考站一样：0.12 的缓动追着鼠标跑，别一帧贴上去。
    // 开了「减少动态效果」就不做缓动、直接贴到光标上——效果还在，只是不动画。
    function startGlowTracking() {
        if (glowTracking) return;
        glowTracking = true;

        const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        let mx = 0, my = 0, gx = 0, gy = 0, raf = null, shown = false;

        const place = () => {
            glowEl.style.transform = 'translate3d(' + gx + 'px,' + gy + 'px,0)';
        };

        const step = () => {
            gx += (mx - gx) * 0.12;
            gy += (my - gy) * 0.12;
            place();
            if (Math.abs(mx - gx) > 0.5 || Math.abs(my - gy) > 0.5) raf = requestAnimationFrame(step);
            else raf = null;
        };

        document.addEventListener('pointermove', (e) => {
            if (e.pointerType === 'touch') return; // 手指跟着跑没意义，还挡内容
            mx = e.clientX;
            my = e.clientY;
            if (!shown || calm) { // 首次出现直接定位，避免从左上角飞过来
                shown = true;
                gx = mx;
                gy = my;
                place();
            }
            if (glowActive && glowEl) glowEl.style.opacity = '1';
            if (!calm && !raf) raf = requestAnimationFrame(step);
        }, { passive: true });

        const hide = () => { if (glowEl) glowEl.style.opacity = '0'; };
        document.addEventListener('pointerleave', hide);
        window.addEventListener('blur', hide);
    }

    // ========== 局部深色区域 ==========
    // pageIsDark() 只看整页底色。站点常见另一种情况：整页浅色，但某个容器自带深色底，
    // 比如元宝「隐身模式」的输入框（--background-container:#303030、page:#1D1D1D）。
    // 深蓝字压在这种底上等于看不见，所以给这类容器打 .gfc-dark，让颜色规则放过它和它的子孙。
    const DARK_CLASS = 'gfc-dark';
    const DARK_LUM = 0.45;     // 与 pageIsDark 的阈值保持一致
    const SCAN_LIMIT = 20000;  // 节点太多就别扫了，免得拖慢页面（2 万节点约 15ms）
    const SCAN_GAP = 1500;     // 两次扫描的最小间隔
    const SCAN_DELAY = 500;

    let darkMarked = new Set();
    let scanTimer = null;
    let lastScan = 0;

    function scanDarkRegions() {
        if (!document.body) return;
        const nodes = document.body.querySelectorAll('*');
        if (nodes.length > SCAN_LIMIT) return;

        const next = new Set();
        for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i];
            // 只看自身底色：半透明/无底色的返回 null，直接跳过
            const lum = luminance(getComputedStyle(el).backgroundColor);
            if (lum === null || lum >= DARK_LUM) continue;
            next.add(el);
            if (!el.classList.contains(DARK_CLASS)) el.classList.add(DARK_CLASS);
        }
        // 切回浅色主题/退出隐身模式后，把过期的标记摘掉
        darkMarked.forEach((el) => {
            if (!next.has(el)) el.classList.remove(DARK_CLASS);
        });
        darkMarked = next;
    }

    function scheduleScan() {
        if (scanTimer) return;
        const wait = Math.max(SCAN_DELAY, SCAN_GAP - (Date.now() - lastScan));
        scanTimer = setTimeout(() => {
            scanTimer = null;
            lastScan = Date.now();
            scanDarkRegions();
        }, wait);
    }

    let lastHtmlSnapshot = '';

    function htmlSnapshot() {
        const html = document.documentElement;
        return (html.getAttribute('class') || '') + '|' + (html.getAttribute('style') || '');
    }

    // 页面是 SPA：新挂载的深色容器要重新识别，主题切换要重新判断整页深浅
    function observePage() {
        if (!document.body) return;

        new MutationObserver(scheduleScan).observe(document.body, {
            childList: true,
            subtree: true
        });

        // 底色多半是换 class / 内联 style 换出来的（切主题、进/退隐身模式），
        // 这类改动不产生 childList，得单独盯属性
        new MutationObserver(scheduleScan).observe(document.body, {
            attributes: true,
            attributeFilter: ['class', 'style'],
            subtree: true
        });

        new MutationObserver(() => {
            if (htmlSnapshot() === lastHtmlSnapshot) return; // 自己改的，忽略
            apply();
        }).observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'style', 'data-theme', 'yb-theme-mode']
        });
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
            const ready = isFontReady(f);
            const mark = settings.font === f.id ? '✓ ' : '　';
            const suffix = ready ? '' : '（未安装）';
            add(
                mark + '字体：' + f.label + suffix,
                change(
                    () => { settings.font = f.id; },
                    ready ? '字体：' + f.label : `未检测到「${f.label.split('（')[0]}」，已回退到系统字体`
                )
            );
        });

        add('🔍 检测本机字体可用性', () => {
            const missing = FONTS.filter((f) => !isFontReady(f)).map((f) => f.label.split('（')[0]);
            toast(missing.length
                ? `缺少 ${missing.length} 款：${missing.join('、')}`
                : '当前字体全部已安装');
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

        add(
            (settings.paper ? '✓ ' : '　') + '报纸模式（纸色底 + 衬线字）',
            change(() => { settings.paper = !settings.paper; },
                settings.paper ? '已关闭报纸模式' : '已开启报纸模式')
        );

        PAPER_COLORS.forEach((p) => {
            add(
                (settings.paperColor === p.hex ? '✓ ' : '　') + `纸张：${p.label} ${p.hex}`,
                change(() => { settings.paperColor = p.hex; }, `纸张：${p.label}`)
            );
        });

        add(
            (settings.glow ? '✓ ' : '　') + '鼠标光晕（悬浮跟随）',
            change(() => { settings.glow = !settings.glow; },
                settings.glow ? '已关闭鼠标光晕' : '已开启鼠标光晕')
        );

        add('↺ 恢复默认设置', change(() => {
            settings = Object.assign({}, DEFAULTS);
        }, '已恢复默认设置'));

        add('ⓘ 当前设置：' + fontOf(settings.font).label + ' / ' + colorOf(settings.color).hex, () => {
            toast(`${fontOf(settings.font).label} · ${colorOf(settings.color).hex} · 范围：${settings.scope === 'smart' ? '智能' : '全部'} · 报纸${settings.paper ? '开' : '关'}`);
        });
    }

    // ========== 启动 ==========
    function bootstrap() {
        ensureStyle();
        apply();
        registerMenus();

        // document-start 时还没有 body，颜色深色判断和菜单提示都等 DOM 就绪再来一次
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                apply();
                observePage();
            }, { once: true });
        } else {
            apply();
            observePage();
        }

        console.log('[全局字体] v1.3.1 已加载：' + fontOf(settings.font).label + ' / ' + settings.color
            + (settings.paper ? ' / 报纸模式' : ''));
    }

    bootstrap();
})();
