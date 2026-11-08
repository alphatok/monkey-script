// ==UserScript==
// @name         扇贝单词助手 - Shanbay Words Helper
// @namespace    http://tampermonkey.net/
// @version      2.0.0
// @description  扇贝单词网页版：英文例句 / 引文 / 短语点击朗读（本地神经语音 Kokoro，WebGPU 加速，离线可用），右下角齿轮可换音色与语速；例句与引文字号放大
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

    // ========== 常量 ==========
    const KOKORO_CDN = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm';
    const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

    // Kokoro v1.0 的音色。af_ 美音女、am_ 美音男、bf_ 英音女、bm_ 英音男。
    const KOKORO_VOICES = [
        { id: 'af_heart', label: '美音 · 女 · Heart（默认）' },
        { id: 'af_bella', label: '美音 · 女 · Bella' },
        { id: 'af_sarah', label: '美音 · 女 · Sarah' },
        { id: 'af_nicole', label: '美音 · 女 · Nicole（轻）' },
        { id: 'am_michael', label: '美音 · 男 · Michael' },
        { id: 'am_adam', label: '美音 · 男 · Adam' },
        { id: 'bf_emma', label: '英音 · 女 · Emma' },
        { id: 'bm_george', label: '英音 · 男 · George' },
        { id: 'bm_lewis', label: '英音 · 男 · Lewis' }
    ];

    const RATE_MIN = 0.6;
    const RATE_MAX = 1.3;

    const DEFAULTS = {
        speak: true,        // 点击英文句子朗读
        big: true,          // 放大例句与引文
        engine: 'neural',   // neural = 本地神经语音；system = 浏览器内置
        voice: 'af_heart',  // Kokoro 音色
        sysVoice: '',       // 系统音色名
        rate: 0.9,
        prefetch: true,     // 悬停预生成
        modelCached: false  // 模型下载过一次，之后点句子直接加载，不再询问
    };

    const KEY = 'sb-helper.settings.v2';
    const OLD_KEY = 'sb-helper.settings.v1';
    const STYLE_ID = 'sb-helper-style';
    const UI_ID = 'sb-helper-ui';
    const DB_NAME = 'sb-helper';
    const DB_STORE = 'audio';

    // ========== 设置 ==========
    const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

    function readRaw(key) {
        try {
            return hasGM ? GM_getValue(key, null) : localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    function loadSettings() {
        let saved = {};
        [KEY, OLD_KEY].forEach((k) => {
            if (Object.keys(saved).length) return;
            const raw = readRaw(k);
            if (!raw) return;
            try {
                saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
            } catch (e) { /* 坏数据就当没存过 */ }
        });
        const out = Object.assign({}, DEFAULTS, saved);
        out.speak = out.speak !== false;
        out.big = out.big !== false;
        out.prefetch = out.prefetch !== false;
        if (out.engine !== 'system') out.engine = 'neural';
        if (!KOKORO_VOICES.some((v) => v.id === out.voice)) out.voice = DEFAULTS.voice;
        if (typeof out.sysVoice !== 'string') out.sysVoice = '';
        out.rate = Math.min(RATE_MAX, Math.max(RATE_MIN, Number(out.rate) || DEFAULTS.rate));
        return out;
    }

    let settings = loadSettings();

    function saveSettings() {
        try {
            const raw = JSON.stringify(settings);
            if (hasGM) GM_setValue(KEY, raw);
            else localStorage.setItem(KEY, raw);
        } catch (e) { /* 隐私模式写不进去就算了 */ }
    }

    // ========== 可朗读的元素 ==========
    // 扇贝用 CSS Modules，类名后面带构建哈希（index_exampleEn__3LyW-），
    // 所以只能用「包含」匹配，站点重新构建换哈希也不会失效。
    const SPEAK_SELECTORS = [
        '[class*="exampleEn"]',
        '[class*="exampleEN"]',
        '[class*="phraseContent"]',
        '[class*="index_quote"] [class*="index_content"]'
    ];
    const SPEAK_SELECTOR = SPEAK_SELECTORS.join(',');

    function speakRule(suffix) {
        return SPEAK_SELECTORS.map((s) => `html.sb-speak ${s}${suffix}`).join(',\n        ');
    }

    // ========== 页面样式 ==========
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
        html.sb-big [class*="phraseContent"] { font-size: 17px !important; }
        html.sb-big [class*="index_sense"] { font-size: 15px !important; line-height: 1.7 !important; }

        /* ========== 朗读提示 ========== */
        ${speakRule('')} { cursor: pointer; }
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
        ${speakRule(':hover::after')} { opacity: .85; }

        /* 正在朗读的句子：淡绿底，和站点的品牌色一致 */
        .sb-speaking {
            background: rgba(32, 158, 133, .14);
            border-radius: 4px;
            box-shadow: 0 0 0 3px rgba(32, 158, 133, .14);
        }
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

    // ========== IndexedDB：音频缓存 ==========
    let dbPromise = null;

    function openDB() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve) => {
            let req;
            try {
                req = indexedDB.open(DB_NAME, 1);
            } catch (e) {
                resolve(null);
                return;
            }
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
        return dbPromise;
    }

    async function idbGet(key) {
        const db = await openDB();
        if (!db) return null;
        return new Promise((resolve) => {
            try {
                const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            } catch (e) {
                resolve(null);
            }
        });
    }

    async function idbPut(key, blob) {
        const db = await openDB();
        if (!db) return;
        try {
            db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(blob, key);
        } catch (e) { /* 配额满了就只留内存 */ }
    }

    async function idbCount() {
        const db = await openDB();
        if (!db) return 0;
        return new Promise((resolve) => {
            try {
                const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).count();
                req.onsuccess = () => resolve(req.result || 0);
                req.onerror = () => resolve(0);
            } catch (e) {
                resolve(0);
            }
        });
    }

    async function idbClear() {
        const db = await openDB();
        if (!db) return;
        await new Promise((resolve) => {
            try {
                const req = db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).clear();
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
            } catch (e) {
                resolve();
            }
        });
    }

    // ========== 神经语音引擎 ==========
    let tts = null;              // KokoroTTS 实例
    let ttsPromise = null;       // 加载中的 promise
    let ttsState = 'idle';       // idle | loading | ready | error
    let ttsDevice = '';          // webgpu / wasm
    let loadPct = 0;
    let ttsError = '';
    let pendingAfterLoad = null; // 模型就绪后要补读的那句

    const blobCache = new Map(); // key -> objectURL（内存层，够快）
    const CACHE_LIMIT = 80;

    function cacheKey(text) {
        return settings.voice + '|' + settings.rate.toFixed(2) + '|' + text;
    }

    async function ensureModel() {
        if (tts) return tts;
        if (ttsPromise) return ttsPromise;

        ttsState = 'loading';
        loadPct = 0;
        ttsError = '';
        updateUI();

        ttsPromise = (async () => {
            const mod = await import(/* @vite-ignore */ KOKORO_CDN);

            // 有 WebGPU 就走 GPU（0.3s/句），否则退回 WASM（约 1.4x 实时，慢但能听）
            let device = 'wasm';
            let dtype = 'q8';
            if (navigator.gpu) {
                try {
                    const adapter = await navigator.gpu.requestAdapter();
                    if (adapter) {
                        device = 'webgpu';
                        dtype = 'fp16';
                    }
                } catch (e) { /* 没 GPU 就用 CPU */ }
            }

            const progress = (p) => {
                if (p && p.status === 'progress' && typeof p.progress === 'number') {
                    loadPct = Math.max(loadPct, Math.round(p.progress));
                    updateUI();
                }
            };

            try {
                tts = await mod.KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype, device, progress_callback: progress });
                ttsDevice = device;
            } catch (e) {
                if (device !== 'webgpu') throw e;
                // GPU 初始化失败（驱动/显存）时退回 WASM 再来一次
                device = 'wasm';
                dtype = 'q8';
                loadPct = 0;
                tts = await mod.KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype, device, progress_callback: progress });
                ttsDevice = device;
            }

            ttsState = 'ready';
            loadPct = 100;
            settings.modelCached = true;
            saveSettings();
            updateUI();
            refreshCacheCount();
            toast('高质量语音已就绪（' + ttsDevice + '）');
            return tts;
        })();

        try {
            return await ttsPromise;
        } catch (e) {
            ttsState = 'error';
            ttsError = String((e && e.message) || e).slice(0, 120);
            ttsPromise = null;
            updateUI();
            throw e;
        }
    }

    async function synth(text) {
        const key = cacheKey(text);
        const hit = blobCache.get(key);
        if (hit) return hit;

        const saved = await idbGet(key);
        if (saved) {
            const url = URL.createObjectURL(saved);
            remember(key, url);
            return url;
        }

        const model = await ensureModel();
        const audio = await model.generate(text, { voice: settings.voice, speed: settings.rate });
        const blob = audio.toBlob();
        const url = URL.createObjectURL(blob);
        remember(key, url);
        idbPut(key, blob);
        refreshCacheCount();
        return url;
    }

    function remember(key, url) {
        const prev = blobCache.get(key);
        if (prev && prev !== url) URL.revokeObjectURL(prev);
        blobCache.set(key, url);
        if (blobCache.size > CACHE_LIMIT) {
            const first = blobCache.keys().next().value;
            const old = blobCache.get(first);
            blobCache.delete(first);
            if (old) URL.revokeObjectURL(old);
        }
    }

    // 模型是不是已经在浏览器缓存里（transformers.js 存在 Cache Storage）
    async function modelInCache() {
        try {
            const names = await caches.keys();
            for (const name of names) {
                const cache = await caches.open(name);
                const keys = await cache.keys();
                if (keys.some((r) => r.url.indexOf('Kokoro-82M') >= 0)) return true;
            }
        } catch (e) { /* 不支持 Cache API 就当没有 */ }
        return false;
    }

    // 模型已经在本地缓存过的话，空闲时先热一下，首次点击就不用等 1 秒
    async function warmUp() {
        if (settings.engine !== 'neural' || ttsState !== 'idle' || !settings.modelCached) return;
        if (!(await modelInCache())) return; // 缓存没了就别偷偷重下 155MB
        ensureModel().catch(() => {});
    }

    // ========== 播放 ==========
    const audioEl = new Audio();
    audioEl.preload = 'auto';
    let currentEl = null;
    let gen = 0;

    function clearHighlight() {
        if (currentEl) {
            currentEl.classList.remove('sb-speaking');
            currentEl = null;
        }
    }

    function stopAll() {
        gen += 1;
        clearHighlight();
        try {
            audioEl.pause();
            audioEl.currentTime = 0;
        } catch (e) { /* ignore */ }
        try {
            window.speechSynthesis.cancel();
        } catch (e) { /* ignore */ }
    }

    function playUrl(url, el, myGen) {
        audioEl.pause();
        audioEl.src = url;
        audioEl.onended = () => {
            if (myGen === gen) clearHighlight();
        };
        const p = audioEl.play();
        if (p && p.catch) p.catch(() => {});
        if (el) {
            currentEl = el;
            el.classList.add('sb-speaking');
        }
    }

    // ========== 系统语音 ==========
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

    const SYS_PREFERRED = ['Samantha', 'Ava', 'Allison', 'Susan', 'Serena', 'Daniel', 'Karen',
        'Google US English'];

    function pickSysVoice() {
        const list = englishVoices();
        if (!list.length) return null;
        if (settings.sysVoice) {
            const hit = list.find((v) => v.name === settings.sysVoice);
            if (hit) return hit;
        }
        for (const name of SYS_PREFERRED) {
            const hit = list.find((v) => v.name === name || v.name.indexOf(name) === 0);
            if (hit) return hit;
        }
        return list.find((v) => v.lang === 'en-US') || list[0];
    }

    function speakSystem(text, el) {
        const synth = window.speechSynthesis;
        if (!synth) {
            toast('当前浏览器不支持语音合成');
            return;
        }
        stopAll();
        const myGen = gen;
        const voice = pickSysVoice();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = (voice && voice.lang) || 'en-US';
        if (voice) u.voice = voice;
        u.rate = settings.rate;
        u.onstart = () => {
            if (myGen !== gen) return;
            if (el) {
                currentEl = el;
                el.classList.add('sb-speaking');
            }
        };
        u.onend = u.onerror = () => {
            if (myGen === gen) clearHighlight();
        };
        synth.speak(u);
    }

    // ========== 统一入口 ==========
    async function speak(text, el) {
        if (!text) return;

        // 再点同一句 = 停止
        if (el && el === currentEl) {
            stopAll();
            return;
        }
        stopAll();
        const myGen = gen;

        if (settings.engine === 'system') {
            speakSystem(text, el);
            return;
        }

        // 神经语音：模型还没就绪
        if (ttsState !== 'ready') {
            if (settings.modelCached) {
                // 之前下过，浏览器里有缓存，直接从缓存加载，不再打断用户
                setBusy(true);
                ensureModel().then(() => {
                    setBusy(false);
                    if (ttsState === 'ready') speak(text, el);
                }).catch(() => {
                    setBusy(false);
                    pendingAfterLoad = { text, el };
                    openPanel();
                    updateUI();
                });
                return;
            }
            // 从没下过：别悄悄拉 155MB，弹面板等用户点「下载并试听」
            pendingAfterLoad = { text, el };
            openPanel();
            updateUI();
            return;
        }

        if (el) {
            currentEl = el;
            el.classList.add('sb-speaking');
        }
        setBusy(true);
        try {
            const url = await synth(text);
            if (myGen !== gen) return;
            playUrl(url, el, myGen);
        } catch (e) {
            ttsState = 'error';
            ttsError = String((e && e.message) || e).slice(0, 120);
            updateUI();
            toast('语音生成失败，已切回系统语音');
            settings.engine = 'system';
            saveSettings();
            updateUI();
            speakSystem(text, el);
        } finally {
            setBusy(false);
        }
    }

    // 试听按钮同时也是「首次下载」的入口：点它才真正去拉模型，
    // 免得用户只是点了个句子就被偷偷下 155MB。
    const SAMPLE = 'The only way to do great work is to love what you do.';

    async function preview() {
        const pending = pendingAfterLoad;
        const text = pending ? pending.text : SAMPLE;
        const el = pending ? pending.el : null;
        pendingAfterLoad = null;
        stopAll();

        if (settings.engine === 'neural' && ttsState !== 'ready') {
            setBusy(true);
            try {
                await ensureModel();
            } catch (e) {
                // ensureModel 里已经记了状态，这里只负责兜底切回系统语音
                if (ttsState !== 'ready') {
                    settings.engine = 'system';
                    saveSettings();
                    updateUI();
                    toast('模型加载失败，已切回系统语音');
                    speakSystem(text, el);
                    return;
                }
            } finally {
                setBusy(false);
            }
        }
        if (settings.engine === 'neural' && ttsState !== 'ready') return;
        speak(text, el);
    }

    // 悬停预生成：让点击几乎零等待
    let prefetchTimer = null;
    function prefetch(text) {
        if (!settings.prefetch || settings.engine !== 'neural' || ttsState !== 'ready') return;
        if (!text || blobCache.has(cacheKey(text))) return;
        clearTimeout(prefetchTimer);
        prefetchTimer = setTimeout(() => {
            synth(text).catch(() => {});
        }, 220);
    }

    // ========== 点击 / 悬停 ==========
    function installEvents() {
        document.addEventListener('click', (e) => {
            if (!settings.speak) return;
            if (!(e.target instanceof Element)) return;
            if (e.target.closest('a, button, input, textarea, select, [contenteditable="true"]')) return;

            // 划词选择时不朗读
            const sel = window.getSelection();
            if (sel && String(sel).trim()) return;

            const el = e.target.closest(SPEAK_SELECTOR);
            if (!el) return;
            const text = (el.textContent || '').trim();
            if (!/[a-zA-Z]/.test(text)) return;
            speak(text, el);
        }, true);

        document.addEventListener('pointerover', (e) => {
            if (!settings.speak || !(e.target instanceof Element)) return;
            const el = e.target.closest(SPEAK_SELECTOR);
            if (!el) return;
            const text = (el.textContent || '').trim();
            if (/[a-zA-Z]/.test(text)) prefetch(text);
        }, true);

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') stopAll();
        });
    }

    // ========== 右下角面板（Shadow DOM，站点样式进不来） ==========
    const PANEL_CSS = `
        :host { all: initial; }
        * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }

        .gear {
            position: fixed; right: 20px; bottom: 20px; z-index: 2147483001;
            width: 42px; height: 42px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            background: #fff; border: 1px solid #e2eae7;
            box-shadow: 0 4px 16px rgba(0, 0, 0, .12);
            cursor: pointer; transition: transform .15s ease, box-shadow .15s ease;
        }
        .gear:hover { transform: rotate(30deg); box-shadow: 0 6px 20px rgba(0, 0, 0, .18); }
        .gear svg { width: 20px; height: 20px; stroke: #147864; }

        .panel {
            position: fixed; right: 20px; bottom: 72px; z-index: 2147483002;
            width: 300px; padding: 14px 16px 12px;
            background: #fff; border: 1px solid #e2eae7; border-radius: 12px;
            box-shadow: 0 12px 36px rgba(0, 0, 0, .16);
            color: #111; font-size: 13px; line-height: 1.5;
            display: none;
        }
        .panel.open { display: block; }

        .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
        .title { font-size: 14px; font-weight: 700; color: #147864; }
        .close { border: 0; background: transparent; font-size: 18px; line-height: 1; color: #999; cursor: pointer; padding: 0 2px; }
        .close:hover { color: #333; }

        .row { margin: 10px 0; }
        .row > .label { display: flex; justify-content: space-between; color: #666; font-size: 12px; margin-bottom: 5px; }
        .label b { color: #147864; font-weight: 600; }

        .seg { display: flex; border: 1px solid #e2eae7; border-radius: 8px; overflow: hidden; }
        .seg button {
            flex: 1; border: 0; background: #fff; color: #555;
            padding: 7px 0; font-size: 12px; cursor: pointer;
        }
        .seg button + button { border-left: 1px solid #e2eae7; }
        .seg button.on { background: #147864; color: #fff; }

        select {
            width: 100%; padding: 7px 8px; font-size: 12px; color: #111;
            border: 1px solid #e2eae7; border-radius: 8px; background: #fff;
            outline: none;
        }
        select:focus { border-color: #147864; }

        input[type=range] { width: 100%; accent-color: #147864; }

        .checks { display: flex; flex-direction: column; gap: 6px; }
        .checks label { display: flex; align-items: center; gap: 6px; color: #333; font-size: 12px; cursor: pointer; }
        .checks input { accent-color: #147864; }

        .status {
            margin-top: 10px; padding: 8px 10px; border-radius: 8px;
            background: #f5f9f8; color: #555; font-size: 12px; line-height: 1.45;
        }
        .status.err { background: #fff4f4; color: #c0392b; }
        .bar { height: 4px; border-radius: 2px; background: #e2eae7; margin-top: 6px; overflow: hidden; display: none; }
        .bar.show { display: block; }
        .bar i { display: block; height: 100%; width: 0; background: #147864; transition: width .2s ease; }

        .actions { display: flex; gap: 8px; margin-top: 10px; }
        .actions button {
            flex: 1; padding: 8px 0; font-size: 12px; border-radius: 8px; cursor: pointer;
            border: 1px solid #e2eae7; background: #fff; color: #147864;
        }
        .actions button:hover { background: #f2f9f7; }
        .actions button.primary { background: #147864; border-color: #147864; color: #fff; }
        .actions button.primary:hover { background: #0f6455; }

        .hint { margin-top: 8px; color: #999; font-size: 11px; line-height: 1.5; }

        /* 深色主题 */
        :host(.dark) { color-scheme: dark; }
        :host(.dark) .gear { background: #1e2624; border-color: #2e3a37; }
        :host(.dark) .gear svg { stroke: #6fd3b8; }
        :host(.dark) .panel { background: #1b2220; border-color: #2e3a37; color: #d8e1dc; }
        :host(.dark) .close { color: #7c8b86; }
        :host(.dark) .row > .label { color: #8fa39d; }
        :host(.dark) .checks label { color: #b9c7c2; }
        :host(.dark) .seg { border-color: #2e3a37; }
        :host(.dark) .seg button { background: #1b2220; color: #b9c7c2; }
        :host(.dark) .seg button.on { background: #147864; color: #fff; }
        :host(.dark) select { background: #222b29; border-color: #2e3a37; color: #d8e1dc; }
        :host(.dark) .status { background: #222b29; color: #a8b8b3; }
        :host(.dark) .status.err { background: #33201f; color: #ff9a8f; }
        :host(.dark) .bar { background: #2e3a37; }
        :host(.dark) input[type=range]::-webkit-slider-runnable-track {
            height: 4px; border-radius: 2px; background: #2e3a37;
        }
        :host(.dark) input[type=range]::-webkit-slider-thumb {
            -webkit-appearance: none; width: 14px; height: 14px; margin-top: -5px;
            border-radius: 50%; background: #2fbf9f; border: 0;
        }
        :host(.dark) .actions button { background: #222b29; border-color: #2e3a37; color: #6fd3b8; }
        :host(.dark) .actions button.primary { background: #147864; color: #fff; }
        :host(.dark) .hint { color: #7c8b86; }
    `;

    let host = null;
    let shadow = null;
    let ui = {};

    function buildUI() {
        if (host) return;
        host = document.createElement('div');
        host.id = UI_ID;
        shadow = host.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = PANEL_CSS;

        const wrap = document.createElement('div');
        wrap.innerHTML = `
            <div class="gear" part="gear" title="扇贝助手设置">
                <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="3"></circle>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                </svg>
            </div>
            <div class="panel">
                <div class="head">
                    <span class="title">扇贝助手</span>
                    <button class="close" title="关闭">×</button>
                </div>

                <div class="row">
                    <div class="label"><span>朗读引擎</span></div>
                    <div class="seg">
                        <button data-engine="neural">神经语音</button>
                        <button data-engine="system">系统语音</button>
                    </div>
                </div>

                <div class="row">
                    <div class="label"><span>音色</span></div>
                    <select class="voice"></select>
                </div>

                <div class="row">
                    <div class="label"><span>语速</span><b class="rateVal">0.9x</b></div>
                    <input type="range" class="rate" min="${RATE_MIN}" max="${RATE_MAX}" step="0.05">
                </div>

                <div class="row checks">
                    <label><input type="checkbox" class="big"> 放大例句与引文</label>
                    <label><input type="checkbox" class="prefetch"> 悬停预生成（点击更快）</label>
                </div>

                <div class="status">未加载</div>
                <div class="bar"><i></i></div>

                <div class="actions">
                    <button class="test">试听</button>
                    <button class="clear">清空音频缓存</button>
                </div>
                <div class="hint"></div>
            </div>
        `;

        shadow.appendChild(style);
        shadow.appendChild(wrap);
        (document.body || document.documentElement).appendChild(host);

        ui = {
            gear: shadow.querySelector('.gear'),
            panel: shadow.querySelector('.panel'),
            close: shadow.querySelector('.close'),
            seg: shadow.querySelectorAll('.seg button'),
            voice: shadow.querySelector('.voice'),
            rate: shadow.querySelector('.rate'),
            rateVal: shadow.querySelector('.rateVal'),
            big: shadow.querySelector('.big'),
            prefetch: shadow.querySelector('.prefetch'),
            status: shadow.querySelector('.status'),
            bar: shadow.querySelector('.bar'),
            barFill: shadow.querySelector('.bar i'),
            test: shadow.querySelector('.test'),
            clear: shadow.querySelector('.clear'),
            hint: shadow.querySelector('.hint')
        };

        ui.gear.addEventListener('click', () => {
            ui.panel.classList.toggle('open');
            if (ui.panel.classList.contains('open')) refreshCacheCount();
        });
        ui.close.addEventListener('click', () => ui.panel.classList.remove('open'));

        ui.seg.forEach((btn) => {
            btn.addEventListener('click', () => {
                settings.engine = btn.dataset.engine;
                saveSettings();
                updateUI();
                if (settings.engine === 'neural' && ttsState === 'idle') {
                    // 不自动下载，等用户按「下载」
                }
            });
        });

        ui.voice.addEventListener('change', () => {
            if (settings.engine === 'system') settings.sysVoice = ui.voice.value;
            else settings.voice = ui.voice.value;
            saveSettings();
            updateUI();
            preview();
        });

        ui.rate.addEventListener('input', () => {
            settings.rate = Number(ui.rate.value);
            ui.rateVal.textContent = settings.rate.toFixed(2).replace(/0$/, '') + 'x';
        });
        ui.rate.addEventListener('change', () => {
            saveSettings();
            refreshCacheCount();
        });

        ui.big.addEventListener('change', () => {
            settings.big = ui.big.checked;
            saveSettings();
            apply();
        });
        ui.prefetch.addEventListener('change', () => {
            settings.prefetch = ui.prefetch.checked;
            saveSettings();
        });

        ui.test.addEventListener('click', preview);

        ui.clear.addEventListener('click', async () => {
            blobCache.forEach((url) => URL.revokeObjectURL(url));
            blobCache.clear();
            await idbClear();
            toast('已清空音频缓存');
            refreshCacheCount();
        });
    }

    function openPanel() {
        buildUI();
        ui.panel.classList.add('open');
        updateUI();
    }

    function setBusy(on) {
        if (!ui.gear) return;
        ui.gear.style.opacity = on ? '.6' : '1';
    }

    let cacheCount = 0;

    async function refreshCacheCount() {
        cacheCount = await idbCount();
        updateUI();
    }

    function updateUI() {
        if (!ui.status) return;
        const html = document.documentElement;
        if (host) host.classList.toggle('dark', html.getAttribute('data-theme') === 'dark');

        // 引擎
        ui.seg.forEach((b) => b.classList.toggle('on', b.dataset.engine === settings.engine));

        // 音色列表
        const want = settings.engine === 'system' ? 'sys' : 'neural';
        if (ui.voice.dataset.kind !== want) {
            ui.voice.dataset.kind = want;
            ui.voice.innerHTML = '';
            if (want === 'neural') {
                KOKORO_VOICES.forEach((v) => {
                    const o = document.createElement('option');
                    o.value = v.id;
                    o.textContent = v.label;
                    ui.voice.appendChild(o);
                });
            } else {
                const list = englishVoices();
                if (!list.length) {
                    const o = document.createElement('option');
                    o.value = '';
                    o.textContent = '（未检测到英文音色）';
                    ui.voice.appendChild(o);
                }
                list.forEach((v) => {
                    const o = document.createElement('option');
                    o.value = v.name;
                    o.textContent = v.name + ' · ' + v.lang;
                    ui.voice.appendChild(o);
                });
            }
        }
        if (settings.engine === 'system') {
            const v = pickSysVoice();
            ui.voice.value = v ? v.name : '';
        } else {
            ui.voice.value = settings.voice;
        }

        // 语速
        ui.rate.value = String(settings.rate);
        ui.rateVal.textContent = settings.rate.toFixed(2).replace(/0$/, '') + 'x';

        ui.big.checked = settings.big;
        ui.prefetch.checked = settings.prefetch;

        // 状态
        ui.status.classList.toggle('err', ttsState === 'error');
        ui.bar.classList.toggle('show', ttsState === 'loading');
        ui.barFill.style.width = loadPct + '%';

        if (settings.engine === 'system') {
            ui.status.textContent = '使用浏览器内置语音，零下载、即点即读。音质一般，胜在快。';
            ui.hint.textContent = '神经语音更自然，但首次需下载模型。';
        } else if (ttsState === 'ready') {
            ui.status.textContent = '神经语音已就绪 · ' + (ttsDevice === 'webgpu' ? 'WebGPU 加速' : 'CPU（较慢）')
                + ' · 已缓存 ' + cacheCount + ' 句';
            ui.hint.textContent = '生成的音频会存本地，重复播放零等待。';
        } else if (ttsState === 'loading') {
            ui.status.textContent = '正在下载语音模型 ' + loadPct + '% …（首次约 155MB，之后离线可用）';
            ui.hint.textContent = '下载期间可以继续用系统语音。';
        } else if (ttsState === 'error') {
            ui.status.textContent = '模型加载失败：' + ttsError;
            ui.hint.textContent = '可以点「试听」重试，或切到系统语音。';
        } else if (settings.modelCached) {
            ui.status.textContent = '模型已下载 · 点句子会自动加载（约 1 秒）';
            ui.hint.textContent = '浏览器清过缓存的话会重新下载一次。';
        } else {
            ui.status.textContent = '神经语音未下载 · 首次约 155MB，之后离线可用';
            ui.hint.textContent = '点「下载并试听」开始下载。';
        }
        syncPrimaryLabel();
    }

    // 首次点朗读但模型没下载：面板里的「试听」就是下载入口，
    // 这里给个更明确的按钮文案
    function syncPrimaryLabel() {
        if (!ui.test) return;
        const needDownload = settings.engine === 'neural' && ttsState === 'idle' && !settings.modelCached;
        ui.test.classList.toggle('primary', settings.engine === 'neural' && ttsState !== 'ready');
        ui.test.textContent = needDownload ? '下载并试听' : '试听';
    }

    // ========== 轻提示 ==========
    let toastEl = null;
    let toastTimer = null;

    function toast(msg) {
        if (!toastEl) {
            toastEl = document.createElement('div');
            toastEl.style.cssText = 'position:fixed;right:20px;bottom:76px;z-index:2147483003;'
                + 'max-width:300px;padding:9px 13px;border-radius:8px;'
                + 'background:rgba(20,120,100,.96);color:#fff;font:13px/1.5 -apple-system,"PingFang SC",sans-serif;'
                + 'box-shadow:0 6px 20px rgba(0,0,0,.18);opacity:0;transform:translateY(6px);'
                + 'transition:opacity .2s ease,transform .2s ease;pointer-events:none;';
            (document.body || document.documentElement).appendChild(toastEl);
        }
        toastEl.textContent = msg;
        toastEl.style.opacity = '1';
        toastEl.style.transform = 'translateY(0)';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toastEl.style.opacity = '0';
            toastEl.style.transform = 'translateY(6px)';
        }, 2000);
    }

    // ========== 应用设置 ==========
    function apply() {
        ensureStyle();
        const html = document.documentElement;
        if (!html) return;
        html.classList.toggle('sb-speak', settings.speak);
        html.classList.toggle('sb-big', settings.big);
        if (host) host.classList.toggle('dark', html.getAttribute('data-theme') === 'dark');
    }

    function commit() {
        saveSettings();
        apply();
        updateUI();
    }

    // ========== 菜单（保留快捷入口，主要操作在面板里） ==========
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
        });
        add('⚙ 打开设置面板', openPanel);
        add((settings.big ? '✓ ' : '　') + '放大例句与引文', () => {
            settings.big = !settings.big;
            commit();
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
        buildUI();
        apply();
        installEvents();
        registerMenus();
        updateUI();

        // 下载进度是异步回调驱动的，面板开着时补刷一下进度条
        setInterval(() => {
            if (ttsState === 'loading' && ui.panel && ui.panel.classList.contains('open')) updateUI();
        }, 400);

        // 之前用过神经语音的话，页面空闲时把模型预热起来
        setTimeout(warmUp, 1500);

        if (window.speechSynthesis) {
            window.speechSynthesis.onvoiceschanged = () => {
                ui.voice.dataset.kind = ''; // 强制重建音色列表
                updateUI();
            };
        }

        // 站点切深色主题时跟着变
        new MutationObserver(() => {
            if (host) host.classList.toggle('dark', document.documentElement.getAttribute('data-theme') === 'dark');
        }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

        console.log('[扇贝助手] v2.0.0 已加载：' + settings.engine + ' / ' + settings.rate + 'x');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    } else {
        bootstrap();
    }
})();
