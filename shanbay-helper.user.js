// ==UserScript==
// @name         扇贝单词助手 - Shanbay Words Helper
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  扇贝单词网页版：英文例句 / 引文 / 短语点击朗读（浏览器本地语音，离线可用，可切音色与语速），并把过小的例句（14px 灰字）和引文（14px）放大
// @author       You
// @match        *://web.shanbay.com/*
// @match        *://*.shanbay.com/wordsweb/*
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @noframes
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ========== 设置 ==========
    const DEFAULTS = {
        speak: true,      // 点击英文句子朗读
        big: true,        // 放大例句与引文
        voice: '',        // 音色名，空 = 自动挑一个
        rate: 0.9         // 语速
    };
    const RATES = [0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2];
    const KEY = 'sb-helper.settings.v1';
    const STYLE_ID = 'sb-helper-style';
    const TOAST_ID = 'sb-helper-toast';

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
        out.speak = out.speak !== false;
        out.big = out.big !== false;
        if (typeof out.voice !== 'string') out.voice = '';
        if (RATES.indexOf(out.rate) < 0) out.rate = DEFAULTS.rate;
        return out;
    }

    function saveSettings() {
        const raw = JSON.stringify(settings);
        try {
            if (hasGM) GM_setValue(KEY, raw);
            else localStorage.setItem(KEY, raw);
        } catch (e) { /* 隐私模式下写不进去就算了 */ }
    }

    let settings = loadSettings();

    // ========== 可朗读的元素 ==========
    // 扇贝用的是 CSS Modules，类名后面带构建哈希（index_exampleEn__3LyW-），
    // 所以只能用「包含」匹配，哈希变了也不影响。
    //   exampleEn / exampleEN  → 短语例句、词典例句
    //   phraseContent          → 短语本体
    //   index_quote 下的 content → 每日一句的英文引文
    const SPEAK_SELECTORS = [
        '[class*="exampleEn"]',
        '[class*="exampleEN"]',
        '[class*="phraseContent"]',
        '[class*="index_quote"] [class*="index_content"]'
    ];
    const SPEAK_SELECTOR = SPEAK_SELECTORS.join(',');

    // 给每个选择器加上 html.sb-speak 前缀和伪类后缀，拼成一条规则
    function speakRule(suffix) {
        return SPEAK_SELECTORS.map((s) => `html.sb-speak ${s}${suffix}`).join(',\n        ');
    }

    // ========== 样式 ==========
    const SPEAKER_ICON = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'"
        + " fill='none' stroke='%23888888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E"
        + "%3Cpath d='M11 5 6 9H2v6h4l5 4V5z'/%3E%3Cpath d='M15.5 8.5a5 5 0 0 1 0 7'/%3E%3C/svg%3E\")";

    const CSS = `
        /* ========== 字号 ========== */
        /* 例句：站点原生 14px + #666，灰且小。颜色用站点变量，深色主题下自动跟着变。 */
        html.sb-big [class*="exampleEn"],
        html.sb-big [class*="exampleEN"] {
            font-size: 17px !important;
            line-height: 1.7 !important;
            color: var(--sb-color-text-level-2, #333) !important;
        }
        /* 例句译文：13~15px / #999 太小，同步放大一档 */
        html.sb-big [class*="exampleCn"],
        html.sb-big [class*="exampleCN"] {
            font-size: 15px !important;
            line-height: 1.7 !important;
            color: var(--sb-color-text-level-3, #666) !important;
        }
        /* 每日一句的引文：原生 14px / 行高 1.3，放大后行高一起放开 */
        html.sb-big [class*="index_quote"] [class*="index_content"] {
            font-size: 18px !important;
            line-height: 1.6 !important;
        }
        html.sb-big [class*="index_quote"] [class*="index_translation"] {
            font-size: 15px !important;
            line-height: 1.7 !important;
        }
        /* 短语本体与释义顺带放大一档，否则例句比短语还大，看着别扭 */
        html.sb-big [class*="phraseContent"] { font-size: 17px !important; }
        html.sb-big [class*="index_sense"] { font-size: 15px !important; line-height: 1.7 !important; }

        /* ========== 朗读提示 ========== */
        ${speakRule('')} {
            cursor: pointer;
        }
        /* 喇叭图标用伪元素：不进 textContent，朗读时不会被念成「喇叭」，
           React 重渲染也不会把它冲掉 */
        ${speakRule('::after')} {
            content: "";
            display: inline-block;
            width: 15px; height: 15px;
            margin-left: 6px;
            vertical-align: -2px;
            background: ${SPEAKER_ICON} center / contain no-repeat;
            opacity: .35;
            transition: opacity .15s ease;
        }
        ${speakRule(':hover::after')} {
            opacity: .85;
        }
        /* 正在朗读的句子：淡绿底，和站点的品牌色一致 */
        .sb-speaking {
            background: rgba(32, 158, 133, .14);
            border-radius: 4px;
            box-shadow: 0 0 0 3px rgba(32, 158, 133, .14);
        }

        /* ========== 轻提示 ========== */
        #${TOAST_ID} {
            position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
            max-width: 320px; padding: 10px 14px;
            background: rgba(20, 120, 100, .96); color: #fff;
            font: 13px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
            border-radius: 8px; box-shadow: 0 6px 20px rgba(0, 0, 0, .18);
            opacity: 0; transform: translateY(6px);
            transition: opacity .2s ease, transform .2s ease;
            pointer-events: none;
        }
        #${TOAST_ID}.sb-show { opacity: 1; transform: translateY(0); }
    `;

    function ensureStyle() {
        let el = document.getElementById(STYLE_ID);
        if (!el) {
            el = document.createElement('style');
            el.id = STYLE_ID;
            (document.head || document.documentElement).appendChild(el);
        }
        if (el.textContent !== CSS) el.textContent = CSS;
    }

    // ========== 提示条 ==========
    let toastTimer = null;

    function toast(msg) {
        let el = document.getElementById(TOAST_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = TOAST_ID;
            (document.body || document.documentElement).appendChild(el);
        }
        el.textContent = msg;
        el.classList.add('sb-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('sb-show'), 1800);
    }

    // ========== 音色 ==========
    function allVoices() {
        try {
            return window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
        } catch (e) {
            return [];
        }
    }

    function englishVoices() {
        return allVoices().filter((v) => /^en([-_]|$)/i.test(v.lang));
    }

    // 自动挑选：优先 macOS 上听起来最自然的几个，再退到第一个美音
    const PREFERRED = ['Samantha', 'Ava', 'Allison', 'Susan', 'Serena', 'Daniel', 'Karen',
        'Google US English', 'Microsoft Aria Online (Natural) - English (United States)'];

    function pickVoice() {
        const list = englishVoices();
        if (!list.length) return null;
        if (settings.voice) {
            const hit = list.find((v) => v.name === settings.voice);
            if (hit) return hit;
        }
        for (const name of PREFERRED) {
            const hit = list.find((v) => v.name === name || v.name.indexOf(name) === 0);
            if (hit) return hit;
        }
        return list.find((v) => v.lang === 'en-US') || list[0];
    }

    function voiceLabel() {
        const v = pickVoice();
        if (!v) return '无可用英文音色';
        // macOS 的音色名带 "(English (United States))" 后缀，截短一点
        const short = v.name.replace(/\s*\(.*?\)\s*/g, '').trim() || v.name;
        return short + ' / ' + v.lang;
    }

    function cycleVoice() {
        const list = englishVoices();
        if (!list.length) {
            toast('没有找到英文音色');
            return;
        }
        // 过滤掉 Bells / Boing 这类特效音，只留正常说话的
        const usable = list.filter((v) => !/Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox/i.test(v.name));
        const pool = usable.length ? usable : list;
        const cur = pickVoice();
        const idx = cur ? pool.findIndex((v) => v.name === cur.name) : -1;
        const next = pool[(idx + 1) % pool.length];
        settings.voice = next.name;
        commit();
        toast('音色：' + voiceLabel());
        speakSample('This is how I sound.', null);
    }

    function cycleRate() {
        const idx = RATES.indexOf(settings.rate);
        settings.rate = RATES[(idx + 1) % RATES.length];
        commit();
        toast('语速：' + settings.rate.toFixed(1) + 'x');
        speakSample('Reading speed is now ' + settings.rate.toFixed(1) + '.', null);
    }

    // ========== 朗读 ==========
    let currentEl = null;
    let pending = 0;
    // 每次朗读递增。cancel() 之后旧 utterance 的 onend 还会补发，
    // 靠这个代号把上一轮的收尾逻辑挡掉，免得把新一轮的高亮提前摘了。
    let gen = 0;

    // 英文里能自然停顿的地方切段。Chrome 对超长 utterance 会中途哑掉，切段更稳。
    function chunk(text) {
        const t = String(text).replace(/\s+/g, ' ').trim();
        if (!t) return [];
        if (t.length <= 180) return [t];
        const parts = t.match(/[^.!?;:]+[.!?;:]?\s*/g) || [t];
        const out = [];
        let buf = '';
        for (const p of parts) {
            if ((buf + p).length > 180 && buf) {
                out.push(buf.trim());
                buf = p;
            } else {
                buf += p;
            }
        }
        if (buf.trim()) out.push(buf.trim());
        return out;
    }

    function stopSpeak() {
        gen += 1;
        pending = 0;
        if (currentEl) {
            currentEl.classList.remove('sb-speaking');
            currentEl = null;
        }
        try {
            window.speechSynthesis.cancel();
        } catch (e) { /* ignore */ }
    }

    function speakSample(text) {
        speak(text, null);
    }

    function speak(text, el) {
        const synth = window.speechSynthesis;
        if (!synth) {
            toast('当前浏览器不支持语音合成');
            return;
        }
        // 再点同一句 = 停止
        if (el && el === currentEl && (synth.speaking || synth.pending)) {
            stopSpeak();
            return;
        }
        const wasBusy = synth.speaking || synth.pending;
        stopSpeak();

        const parts = chunk(text);
        if (!parts.length) return;

        const myGen = gen;

        const run = () => {
            if (myGen !== gen) return;
            const voice = pickVoice();
            pending = parts.length;
            parts.forEach((part, i) => {
                const u = new SpeechSynthesisUtterance(part);
                u.lang = (voice && voice.lang) || 'en-US';
                if (voice) u.voice = voice;
                u.rate = settings.rate;
                u.pitch = 1;
                u.volume = 1;
                u.onstart = () => {
                    if (i === 0 && el && myGen === gen) {
                        currentEl = el;
                        el.classList.add('sb-speaking');
                    }
                };
                const done = () => {
                    if (myGen !== gen) return;
                    pending -= 1;
                    if (pending <= 0) {
                        pending = 0;
                        if (el) el.classList.remove('sb-speaking');
                        if (currentEl === el) currentEl = null;
                    }
                };
                u.onend = done;
                u.onerror = done;
                synth.speak(u);
            });
        };

        // Chrome 的坑：cancel() 之后立刻 speak() 有时不出声，隔一帧再说
        if (wasBusy) setTimeout(run, 60);
        else run();
    }

    // ========== 点击朗读 ==========
    function installClick() {
        document.addEventListener('click', (e) => {
            if (!settings.speak) return;
            if (!(e.target instanceof Element)) return;

            // 链接、按钮、输入框不抢
            if (e.target.closest('a, button, input, textarea, select, [contenteditable="true"]')) return;

            // 用户正在划词选择时不要读
            const sel = window.getSelection();
            if (sel && String(sel).trim()) return;

            const el = e.target.closest(SPEAK_SELECTOR);
            if (!el) return;

            const text = el.textContent || '';
            if (!/[a-zA-Z]/.test(text)) return;
            speak(text, el);
        }, true);

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') stopSpeak();
        });
    }

    // ========== 应用设置 ==========
    function apply() {
        ensureStyle();
        const html = document.documentElement;
        if (!html) return;
        html.classList.toggle('sb-speak', settings.speak);
        html.classList.toggle('sb-big', settings.big);
    }

    function commit() {
        saveSettings();
        apply();
        registerMenus();
    }

    // ========== 菜单 ==========
    let menuIds = [];

    function registerMenus() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        menuIds.forEach((id) => {
            try {
                GM_unregisterMenuCommand(id);
            } catch (e) { /* ignore */ }
        });
        menuIds = [];

        const add = (label, fn) => {
            const id = GM_registerMenuCommand(label, fn);
            if (id !== undefined) menuIds.push(id);
        };

        add((settings.speak ? '✓ ' : '　') + '点击英文句子朗读', () => {
            settings.speak = !settings.speak;
            commit();
            toast(settings.speak ? '已开启点击朗读' : '已关闭点击朗读');
        });

        add('🔊 音色：' + voiceLabel(), cycleVoice);
        add('⏩ 语速：' + settings.rate.toFixed(1) + 'x', cycleRate);

        add((settings.big ? '✓ ' : '　') + '放大例句与引文', () => {
            settings.big = !settings.big;
            commit();
            toast(settings.big ? '已放大例句与引文' : '已恢复站点原字号');
        });

        add('↺ 恢复默认设置', () => {
            settings = Object.assign({}, DEFAULTS);
            commit();
            toast('已恢复默认设置');
        });
    }

    // ========== 启动 ==========
    function bootstrap() {
        ensureStyle();
        apply();
        installClick();
        registerMenus();

        // 音色列表是异步加载的，加载完刷新一下菜单里的音色名
        if (window.speechSynthesis) {
            window.speechSynthesis.onvoiceschanged = () => registerMenus();
            // 有些浏览器不触发 voiceschanged，轮询几次兜底
            let tries = 0;
            const timer = setInterval(() => {
                tries += 1;
                if (englishVoices().length || tries > 10) {
                    clearInterval(timer);
                    registerMenus();
                }
            }, 300);
        }

        console.log('[扇贝助手] v1.0.0 已加载：朗读 ' + (settings.speak ? '开' : '关')
            + ' / 字号 ' + (settings.big ? '放大' : '原始')
            + ' / 音色 ' + voiceLabel());
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    } else {
        bootstrap();
    }
})();
