// ==UserScript==
// @name         扇贝单词助手 - Shanbay Words Helper
// @namespace    http://tampermonkey.net/
// @version      2.4.0
// @description  扇贝单词页 + 阅读页：英文句子点击朗读（本地神经语音 Kokoro，WebGPU 加速、离线可用），句尾/段尾/顶部三级喇叭，全文可导出 MP3；阅读页按英文报刊重排，中文译文不朗读
// @author       You
// @match        *://web.shanbay.com/*
// @match        *://*.shanbay.com/wordsweb/*
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @noframes
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/alphatok/monkey-script/main/shanbay-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/alphatok/monkey-script/main/shanbay-helper.user.js
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

    // 音频缓存的「配方版本」。生成链路一变（换模型精度、换编码、换后处理）就 +1，
    // 老缓存全部作废。之前踩过的坑：fp16 那版模型生成的是宽带噪声（听感像刺刺的电流声），
    // 修好之后用户还是听到老声音——因为 cacheKey 只按 voice|rate|text 命中，
    // IndexedDB 里存着修复前的坏音频。版本号进 key，这类问题就不会再复发。
    const TTS_REV = 'v3';

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
    // 整段用的实心喇叭：和单句的空心喇叭并排时能一眼分开
    const SPEAKER_ICON_SOLID = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'"
        + " fill='%23888888' stroke='%23888888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E"
        + "%3Cpath d='M11 5 6 9H2v6h4l5 4V5z'/%3E%3Cpath d='M15.5 8.5a5 5 0 0 1 0 7' fill='none'/%3E%3C/svg%3E\")";

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

        /* ========== 阅读页正文排版 ========== */
        /* 扇贝阅读是另一个 SPA，类名同样是构建哈希，不能靠类名认正文，
           所以由 JS 按内容给段落打 .sb-block，这里只管排版。
           参考英文报刊：衬线正文、19px/1.72、段间距约一行、行长 40em（≈70 字符）。
           行高和段间距是「读得下去」的关键——原生 1.4 + 紧贴的段落读长文很累。 */
        html.sb-read .sb-block {
            font-family: "Charter", "Iowan Old Style", "Georgia", "Times New Roman", "Source Serif SC", "Songti SC", serif !important;
            font-size: 19px !important;
            line-height: 1.72 !important;
            letter-spacing: .003em !important;
            word-spacing: .05em !important;
            text-align: left !important;
            text-indent: 0 !important;
            hyphens: auto !important;
            -webkit-hyphens: auto !important;
            max-width: 40em;
            margin: 0 auto 1.05em !important;
        }
        /* 段落之间统一由上面的 margin-bottom 控制，别叠加站点自己的 margin-top */
        html.sb-read .sb-block + .sb-block { margin-top: 0 !important; }
        /* 站点把每句话渲染成独立 span，句与句之间不补空格，读起来像 "cup.Next year"。
           只补视觉间距，不动文本节点，React 重渲染也不会打架。 */
        html.sb-read .sb-sent-gap { margin-right: .32em; }
        /* 正文里的链接保持原色，但别用蓝色下划线打断阅读节奏 */
        html.sb-read .sb-block a { text-decoration-thickness: 1px; text-underline-offset: 2px; }

        /* ========== 三级小喇叭：全文 / 全段 / 单句 ========== */
        /* 用真实元素而不是 ::after，因为要单独接点击事件。
           宽度固定 18px，出现/消失不会让正文回流。 */
        .sb-ic {
            display: inline-block;
            width: 18px; height: 18px;
            margin: 0 2px;
            vertical-align: -3px;
            border-radius: 4px;
            cursor: pointer;
            background: ${SPEAKER_ICON} center / 13px 13px no-repeat;
            opacity: .28;
            transition: opacity .15s ease, background-color .15s ease;
            -webkit-user-select: none; user-select: none;
        }
        .sb-ic:hover { opacity: 1; background-color: rgba(32, 158, 133, .12); }
        /* 整段的图标挂在最后一个英文句子旁边：实心喇叭 + 大一号，和单句区分开 */
        .sb-ic-para {
            width: 20px; height: 20px;
            margin-left: 10px;
            background-image: ${SPEAKER_ICON_SOLID};
            background-size: 15px 15px;
            opacity: .34;
        }
        /* 正在读的那句/那段：图标跟着亮起来 */
        .sb-block.sb-speaking .sb-ic { opacity: .9; }

        /* 页面顶部工具条：全文阅读 + 导出音频。固定在右上角，不占正文流。 */
        .sb-bar {
            position: fixed; top: 14px; right: 20px; z-index: 2147483001;
            display: flex; gap: 8px;
        }
        .sb-bar-btn {
            display: inline-flex; align-items: center; gap: 6px;
            height: 34px; padding: 0 14px;
            border-radius: 17px;
            border: 1px solid #e2eae7;
            background: #fff; color: #147864;
            font: 600 13px/1 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
            cursor: pointer; white-space: nowrap;
            box-shadow: 0 4px 14px rgba(0, 0, 0, .10);
            transition: background-color .15s ease, border-color .15s ease;
        }
        .sb-bar-btn:hover { background: #f2f9f7; }
        .sb-bar-btn.on { background: #147864; border-color: #147864; color: #fff; }
        .sb-bar-btn.on .sb-bar-ic { filter: invert(1) brightness(2); }
        /* 全文阅读按钮上的小喇叭 */
        .sb-bar-ic {
            width: 14px; height: 14px;
            background: ${SPEAKER_ICON} center / contain no-repeat;
        }
        html[data-theme="dark"] .sb-bar-btn {
            background: #1c2422; border-color: #2e3a37; color: #6fd3b8;
        }
        html[data-theme="dark"] .sb-bar-btn:hover { background: #24302d; }
        html[data-theme="dark"] .sb-bar-btn.on { background: #147864; color: #fff; }

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

    // 清掉旧配方版本的音频（key 不以当前 TTS_REV 开头的一律删掉）
    async function idbPurgeOld() {
        const db = await openDB();
        if (!db) return 0;
        const prefix = TTS_REV + '|';
        return new Promise((resolve) => {
            let n = 0;
            try {
                const store = db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE);
                const req = store.openKeyCursor();
                req.onsuccess = () => {
                    const cur = req.result;
                    if (!cur) { resolve(n); return; }
                    if (typeof cur.key === 'string' && cur.key.indexOf(prefix) !== 0) {
                        store.delete(cur.key);
                        n++;
                    }
                    cur.continue();
                };
                req.onerror = () => resolve(n);
            } catch (e) {
                resolve(n);
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
        return TTS_REV + '|' + settings.voice + '|' + settings.rate.toFixed(2) + '|' + text;
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

            // 有 WebGPU 就走 GPU，否则退回 WASM。
            // 注意 dtype 必须是 fp32：fp16 在这套模型上会把声码器算坏，
            // 输出整段 0~12kHz 的宽带噪声（听感就是「刺刺声」），
            // 实测 fp32 和 q8 的频谱都干净。代价是模型 310MB vs 155MB。
            let device = 'wasm';
            let dtype = 'q8';
            if (navigator.gpu) {
                try {
                    const adapter = await navigator.gpu.requestAdapter();
                    if (adapter) {
                        device = 'webgpu';
                        dtype = 'fp32';
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
                // GPU 初始化失败（驱动/显存不够）时退回 WASM，慢但能听
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
            purgeStaleModels(ttsDevice === 'webgpu' ? 'model.onnx' : 'model_quantized.onnx');
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

    // 自己写 16bit PCM 的 WAV：库自带的 toBlob() 是 32bit float，
    // 体积翻倍，个别环境下播放器解码还会出怪声。16bit 到处都认，缓存也小一半。
    function encodeWav16(samples, sampleRate) {
        const len = samples.length;
        const buf = new ArrayBuffer(44 + len * 2);
        const view = new DataView(buf);
        const str = (off, s) => {
            for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
        };
        str(0, 'RIFF');
        view.setUint32(4, 36 + len * 2, true);
        str(8, 'WAVE');
        str(12, 'fmt ');
        view.setUint32(16, 16, true);        // fmt chunk 长度
        view.setUint16(20, 1, true);         // PCM
        view.setUint16(22, 1, true);         // 单声道
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true); // 字节率
        view.setUint16(32, 2, true);         // block align
        view.setUint16(34, 16, true);        // 位深
        str(36, 'data');
        view.setUint32(40, len * 2, true);
        let off = 44;
        for (let i = 0; i < len; i++) {
            const s = Math.max(-1, Math.min(1, samples[i]));
            view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
            off += 2;
        }
        return new Blob([buf], { type: 'audio/wav' });
    }

    async function synth(text, fresh) {
        const key = cacheKey(text);
        if (!fresh) {
            const hit = blobCache.get(key);
            if (hit) return hit;

            const saved = await idbGet(key);
            if (saved) {
                const url = URL.createObjectURL(saved);
                remember(key, url);
                return url;
            }
        }

        const model = await ensureModel();
        const audio = await model.generate(text, { voice: settings.voice, speed: settings.rate });
        const blob = encodeWav16(audio.audio, audio.sampling_rate);
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

    // 模型是否已缓存在浏览器里（transformers.js 存在 Cache Storage）
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

    // 换过 dtype 之后，旧精度的模型文件还赖在缓存里（fp16 那份 155MB）。
    // 只删明确没用到的变体，当前在用的那个不碰。
    async function purgeStaleModels(keep) {
        const stale = ['model_fp16.onnx', 'model_q8f16.onnx', 'model_q4.onnx', 'model_q4f16.onnx',
            'model_uint8.onnx', 'model_uint8f16.onnx', 'model_quantized.onnx', 'model.onnx']
            .filter((f) => f !== keep);
        try {
            const names = await caches.keys();
            for (const name of names) {
                const cache = await caches.open(name);
                const keys = await cache.keys();
                for (const req of keys) {
                    if (req.url.indexOf('Kokoro-82M') < 0) continue;
                    if (stale.some((f) => req.url.indexOf(f) >= 0)) await cache.delete(req);
                }
            }
        } catch (e) { /* 删不掉就算了 */ }
    }

    // 模型已经在本地缓存过的话，空闲时先热一下，首次点击就不用等 1 秒
    async function warmUp() {
        if (settings.engine !== 'neural' || ttsState !== 'idle' || !settings.modelCached) return;
        if (!(await modelInCache())) return; // 缓存没了就别偷偷重下整个模型
        ensureModel().catch(() => {});
    }

    // ========== 离线导入模型 ==========
    // 给「完全没网」的场景用：选一次模型文件夹，把文件按 transformers.js 的
    // 缓存键（就是 HuggingFace 的原始 URL）写进 Cache Storage，之后它直接命中缓存，
    // 一个字节的网络请求都不会发。不需要本地服务器，也不需要什么额外权限。
    const MODEL_BASE = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/';
    const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json'];
    const MODEL_DIRS = ['onnx/', 'voices/'];

    // 用户可能选中 model/、也可能选中它的上一层，所以从路径里截出真正的模型内路径
    function modelRelPath(path) {
        const parts = String(path || '').split('/');
        for (let i = 0; i < parts.length; i++) {
            const rest = parts.slice(i).join('/');
            if (MODEL_FILES.indexOf(rest) >= 0) return rest;
            if (MODEL_DIRS.some((d) => rest.indexOf(d) === 0)) return rest;
        }
        return null;
    }

    async function importModelFiles(fileList) {
        const main = await caches.open('transformers-cache');
        const voice = await caches.open('kokoro-voices');
        let n = 0;
        let bytes = 0;
        const names = [];
        for (const f of fileList) {
            const rel = modelRelPath(f.webkitRelativePath || f.name);
            if (!rel) continue;
            const cache = rel.indexOf('voices/') === 0 ? voice : main;
            await cache.put(MODEL_BASE + rel, new Response(f));
            n++;
            bytes += f.size;
            names.push(rel);
            if (ui.status) ui.status.textContent = '正在导入 ' + n + ' 个文件 · ' + (bytes / 1048576).toFixed(0) + 'MB';
        }
        return { n, bytes, names };
    }

    async function pickModelFolder() {
        const input = document.createElement('input');
        input.type = 'file';
        input.webkitdirectory = true;
        input.multiple = true;
        input.style.display = 'none';
        input.addEventListener('change', async () => {
            const files = [...(input.files || [])];
            input.remove();
            if (!files.length) return;
            setBusy(true);
            try {
                const r = await importModelFiles(files);
                if (!r.n) {
                    toast('这个文件夹里没找到模型文件');
                } else if (r.names.indexOf('onnx/model.onnx') < 0 && r.names.indexOf('onnx/model_quantized.onnx') < 0) {
                    toast('导入了 ' + r.n + ' 个文件，但缺少 onnx 模型本体');
                } else {
                    settings.modelCached = true;
                    saveSettings();
                    refreshCacheCount();
                    toast('已导入 ' + r.n + ' 个文件 · ' + (r.bytes / 1048576).toFixed(0) + 'MB，现在断网也能用');
                }
            } catch (e) {
                toast('导入失败：' + String((e && e.message) || e).slice(0, 60));
            } finally {
                setBusy(false);
                updateUI();
            }
        });
        (document.body || document.documentElement).appendChild(input);
        input.click();
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
            audioEl.removeAttribute('src');
            audioEl.load();   // 彻底放掉上一段 buffer，避免残留音轨
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
        u.volume = 1;
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
        // Chrome 的老毛病：cancel() 之后同一帧 speak()，新句子会从中间起播、
        // 或者叠着上一句的尾巴，听感就是「刺刺」的杂音。隔一帧再说话，
        // 顺便 resume() 一下——cancel 之后合成器有时会停在暂停态。
        setTimeout(() => {
            if (myGen !== gen) return;
            try {
                synth.resume();
            } catch (e) { /* ignore */ }
            synth.speak(u);
        }, 120);
    }

    // ========== 统一入口 ==========
    async function speak(text, el, opts) {
        // 唯一入口统一清洗：中文译文、全角标点一律剔掉，别念出来
        text = cleanForTTS(text);
        if (!text || !/[a-zA-Z]/.test(text)) return;

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
            // 从没下过：别悄悄拉几百 MB，弹面板等用户点「下载并试听」
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
            const url = await synth(text, !!(opts && opts.fresh));
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

    // ========== 阅读文章（/reading/） ==========
    // 阅读页要登录，拿不到固定类名，所以不猜类名，按内容找：
    // 页面上「叶子块级元素 + 主要是英文 + 够长」的那些就是正文段落。
    const ARTICLE_MIN_BLOCKS = 2;
    const ARTICLE_MIN_CHARS = 200;
    // 中日韩文字。阅读页每句后面挂着中文翻译，朗读时要整段剔掉
    const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;
    const CJK_RUN_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]+/g;
    const FULLWIDTH_RE = /[\u3000-\u303f\uff01-\uff5e]/g;

    let articleBlocks = [];
    let readingAll = false;
    let playResolve = null;
    let readProgress = { done: 0, total: 0 };

    // 朗读前统一清洗：剔掉中文翻译和全角标点，剩下的才是要念的英文。
    // 放在唯一入口上，无论从哪条路径（点句子 / 整段 / 全文 / 导出）进来都不会念到译文。
    function cleanForTTS(text) {
        return String(text || '')
            .replace(CJK_RUN_RE, ' ')
            .replace(FULLWIDTH_RE, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function isReadingPage() {
        return location.pathname.indexOf('/reading/') >= 0;
    }

    // 判断一块是不是英文正文。中英对照的段落里中文占比很高，
    // 按整段算比例会把正文判掉，所以先把中文剔掉再算。
    function looksEnglish(text) {
        if (!text) return false;
        const s = text.replace(CJK_RUN_RE, '');
        if (s.length < 15) return false;
        const letters = (s.match(/[A-Za-z]/g) || []).length;
        return letters / s.length >= 0.55;
    }

    function clearArticle() {
        articleBlocks.forEach((el) => {
            el.classList.remove('sb-block', 'sb-speaking');
            el.querySelectorAll('.sb-ic').forEach((ic) => ic.remove());
        });
        document.querySelectorAll('.sb-ic-sent').forEach((ic) => ic.remove());
        articleBlocks = [];
        document.documentElement.classList.remove('sb-read');
        syncReadBar();
    }

    // ---------- 三级小喇叭 ----------
    // 全文（页面顶部工具条）/ 全段（段尾）/ 单句（每个句子后面）
    // 用真实元素而不是 ::after：要单独接点击事件；宽度固定，出现消失不回流。
    let readBar = null;
    let readAllBtn = null;
    let exportBtn = null;
    let exporting = false;
    let exportProgress = 0;

    function makeIcon(kind, title) {
        const el = document.createElement('span');
        el.className = 'sb-ic sb-ic-' + kind;
        el.setAttribute('role', 'button');
        el.title = title;
        return el;
    }

    // 页面顶部的工具条：全文朗读 + 导出 MP3。
    // 阅读页才有，正文没扫到之前不出现，免得在别的页面上碍事。
    function syncReadBar() {
        const show = isReadingPage() && articleBlocks.length > 0;
        if (!show) {
            if (readBar) { readBar.remove(); readBar = null; readAllBtn = null; exportBtn = null; }
            return;
        }
        if (!readBar) {
            readBar = document.createElement('div');
            readBar.className = 'sb-bar';

            readAllBtn = document.createElement('button');
            readAllBtn.type = 'button';
            readAllBtn.className = 'sb-bar-btn sb-bar-read';
            readAllBtn.innerHTML = '<i class="sb-bar-ic"></i><span>全文阅读</span>';
            readAllBtn.addEventListener('click', readArticle);

            exportBtn = document.createElement('button');
            exportBtn.type = 'button';
            exportBtn.className = 'sb-bar-btn sb-bar-export';
            exportBtn.textContent = '导出音频';
            exportBtn.title = '把整篇文章合成一个 MP3 下载';
            exportBtn.addEventListener('click', exportAudio);

            readBar.appendChild(readAllBtn);
            readBar.appendChild(exportBtn);
            (document.body || document.documentElement).appendChild(readBar);
        }
        readAllBtn.classList.toggle('on', readingAll);
        readAllBtn.lastChild.textContent = readingAll
            ? '停止（' + readProgress.done + '/' + readProgress.total + '）'
            : '全文阅读';
        exportBtn.textContent = exporting
            ? '导出 ' + exportProgress + '%'
            : '导出音频';
    }

    // 给每个段落挂「整段」图标，给每个句子挂「单句」图标。
    // 只插在句子 span 之后，不碰文本节点；React 重渲染冲掉了就再补一次。
    function decorateArticle() {
        articleBlocks.forEach((block) => {
            const kids = block.children;
            for (let i = 0; i < kids.length; i++) {
                const el = kids[i];
                if (el.classList.contains('sb-ic') || isTranslation(el)) continue;
                const t = (el.textContent || '').trim();
                if (t.length < 2 || !/[.!?"'”’)\]]$/.test(t)) continue;
                const nx = el.nextElementSibling;
                if (nx && nx.classList.contains('sb-ic-sent')) continue;
                const ic = makeIcon('sent', '朗读这句');
                ic.__sbText = t;
                el.parentNode.insertBefore(ic, el.nextSibling);
            }
            // 整段图标跟最后一个英文句子待在一起，别掉到中文译文后面去
            if (!block.querySelector(':scope > .sb-ic-para')) {
                const kids2 = [...block.children];
                const sents = kids2.filter((el) => el.classList.contains('sb-ic-sent'));
                const anchor = sents.length
                    ? sents[sents.length - 1]
                    : kids2.reverse().find((el) => !isTranslation(el) && !el.classList.contains('sb-ic')) || null;
                const ic = makeIcon('para', '朗读整段');
                if (anchor) anchor.parentNode.insertBefore(ic, anchor.nextSibling);
                else block.appendChild(ic);
            }
        });
        syncReadBar();
    }

    // 站点把每句话渲染成独立的行内元素（<sent> → span），句间不补空格，
    // 于是 "…Pepsi in the cup.Next year…" 黏在一起。这里只加一个 class 补视觉间距：
    // 不动文本节点，React 重渲染不会把它冲掉，也不会把空格念进语音里。
    function fixSentenceSpacing(block) {
        const kids = block.children;
        for (let i = 0; i < kids.length - 1; i++) {
            const cur = kids[i];
            const next = kids[i + 1];
            const a = (cur.textContent || '');
            const b = (next.textContent || '');
            if (!a.trim() || !b) continue;
            if (/\s$/.test(a) || /^\s/.test(b)) continue;      // 两边谁带空格都不用补
            // 两个 span 之间夹着空白文本节点 → 站点已经补过空格，别再叠一层
            let hasGapNode = false;
            for (let n = cur.nextSibling; n && n !== next; n = n.nextSibling) {
                if (n.nodeType === 3 && /\s/.test(n.nodeValue || '')) { hasGapNode = true; break; }
            }
            if (hasGapNode) continue;
            if (!/[.!?"'”’)\]]\s*$/.test(a)) continue;          // 不是句子结尾
            if (!/^[A-Za-z0-9"'“‘(]/.test(b)) continue;         // 后面不是词的开始
            cur.classList.add('sb-sent-gap');
        }
    }

    function scanArticle() {
        if (!isReadingPage() || !document.body) return;
        const root = document.querySelector('article') || document.body;
        const nodes = root.querySelectorAll('p, li, div');
        const found = [];

        for (let i = 0; i < nodes.length && found.length < 400; i++) {
            const el = nodes[i];
            if (el.closest('nav, header, footer, aside, form, .sb-panel, #' + UI_ID)) continue;
            // 只要叶子块：内部还有块级元素说明是容器，不是段落
            if (el.querySelector('p, div, li, ul, ol, section, article, h1, h2, h3, h4, table')) continue;
            const t = (el.textContent || '').trim();
            if (t.length < 15 || t.length > 3000) continue;
            if (!looksEnglish(t)) continue;
            found.push(el);
        }

        const chars = found.reduce((n, el) => n + el.textContent.trim().length, 0);
        if (found.length < ARTICLE_MIN_BLOCKS || chars < ARTICLE_MIN_CHARS) {
            clearArticle();
            updateUI();
            return;
        }
        const same = found.length === articleBlocks.length && found.every((el, i) => el === articleBlocks[i]);
        if (!same) {
            clearArticle();
            articleBlocks = found;
            found.forEach((el) => {
                el.classList.add('sb-block');
                // 标成英文：断词（hyphens:auto）和读屏发音都靠它，站点默认是 zh-CN
                if (el.getAttribute('lang') !== 'en') el.setAttribute('lang', 'en');
                fixSentenceSpacing(el);
            });
            document.documentElement.classList.add('sb-read');
        }
        // 段落没变也要补图标：React 重渲染会把插进去的图标冲掉
        decorateArticle();
        updateUI();
    }

    // SPA 路由切换 / 正文异步渲染都要重扫，但别扫太勤
    let articleTimer = null;
    function scheduleArticle() {
        if (!isReadingPage()) return;
        clearTimeout(articleTimer);
        articleTimer = setTimeout(scanArticle, 400);
    }

    // 切句。不能只按句号切：「U.S.」「Mr.」「e.g.」都会把句子劈成两半，
    // 读出来就是「…a new U.S.」停一下再来「partnership on October 15.」。
    // 所以先粗切，再把「缩写结尾 / 下一句以小写开头」的碎片并回去。
    const ABBR_END = /(?:^|[\s(])(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|etc|Inc|Ltd|Co|Corp|No|Vol|Fig|approx|e\.g|i\.e|a\.m|p\.m)\.$/i;

    function splitSentences(text) {
        const parts = [];
        const re = /[^.!?]+[.!?]+["'”’)\]]*/g;
        let m;
        let last = 0;
        while ((m = re.exec(text))) {
            parts.push({ start: m.index, text: m[0] });
            last = re.lastIndex;
        }
        if (last < text.length) parts.push({ start: last, text: text.slice(last) });

        const out = [];
        parts.forEach((p) => {
            const prev = out[out.length - 1];
            if (prev) {
                const tail = prev.text.trimEnd();
                const head = p.text.trimStart();
                const abbr = ABBR_END.test(tail) || /(?:^|[\s(])[A-Z]\.$/.test(tail); // U.S. / J. K.
                if (abbr || /^[a-z]/.test(head)) {
                    prev.text += p.text;
                    return;
                }
            }
            out.push({ start: p.start, text: p.text });
        });
        return out;
    }

    // 取整段文本给语音用。不能直接 block.textContent：句子是独立 span，
    // textContent 拼出来是 "…October 15.Starting in January…"，念起来会黏在一起。
    // 按子节点取再补空格，行内标签（<b>）造成的多余空格由 \s+ 折叠掉。
    function blockText(block) {
        const parts = [];
        block.childNodes.forEach((n) => {
            if (n.nodeType === 3) parts.push(n.nodeValue || '');
            else if (n.nodeType === 1 && !n.classList.contains('sb-ic') && !isTranslation(n)) {
                parts.push(n.textContent || '');
            }
        });
        return parts.join(' ').replace(/\s+/g, ' ').trim();
    }

    // 中英对照里「中文翻译」那一块：中文字符占一半以上就当译文，
    // 整块跳过——既不给它挂喇叭，也不念。
    function isTranslation(node) {
        const t = (node.textContent || '').trim();
        if (!t) return false;
        const solid = t.replace(/\s/g, '');
        if (!solid) return false;
        const cjk = (t.match(CJK_RUN_RE) || []).join('').length;
        return cjk / solid.length >= 0.5;
    }

    // 点在哪一句就读哪一句：用 caretRangeFromPoint 拿到字符偏移，再按句切
    function sentenceAtPoint(block, x, y) {
        const full = block.textContent || '';
        let idx = -1;
        try {
            const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
            if (range && block.contains(range.startContainer)) {
                const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
                let acc = 0;
                let n;
                while ((n = walker.nextNode())) {
                    if (n === range.startContainer) {
                        acc += range.startOffset;
                        break;
                    }
                    acc += (n.nodeValue || '').length;
                }
                idx = acc;
            }
        } catch (e) { /* 拿不到偏移就整段读 */ }

        if (idx < 0) return full.trim();

        const parts = splitSentences(full);
        for (let i = 0; i < parts.length; i++) {
            const start = parts[i].start;
            const end = start + parts[i].text.length;
            if (idx >= start && idx <= end) return parts[i].text.trim();
        }
        return full.trim();
    }

    // 播一段并等它播完（中途 stopAll 会 resolve 掉，避免整篇循环卡死）
    function playWait(url) {
        return new Promise((resolve) => {
            let settled = false;
            const done = () => {
                if (settled) return;
                settled = true;
                playResolve = null;
                resolve();
            };
            playResolve = done;
            audioEl.onended = done;
            audioEl.onerror = done;
            audioEl.src = url;
            const p = audioEl.play();
            if (p && p.catch) p.catch(done);
        });
    }

    function speakSystemWait(text) {
        return new Promise((resolve) => {
            const synth = window.speechSynthesis;
            const u = new SpeechSynthesisUtterance(text);
            const voice = pickSysVoice();
            u.lang = (voice && voice.lang) || 'en-US';
            if (voice) u.voice = voice;
            u.rate = settings.rate;
            u.volume = 1;
            let settled = false;
            const done = () => {
                if (settled) return;
                settled = true;
                playResolve = null;
                resolve();
            };
            playResolve = done;
            u.onend = done;
            u.onerror = done;
            setTimeout(() => synth.speak(u), 60);
        });
    }

    async function readArticle() {
        if (readingAll) {
            stopAll();
            return;
        }
        scanArticle();
        const blocks = articleBlocks.slice();
        if (!blocks.length) {
            toast('没找到可朗读的段落');
            return;
        }

        stopAll();
        readingAll = true;
        const myGen = gen;
        readProgress = { done: 0, total: blocks.length };
        updateUI();

        const texts = blocks.map(blockText).map(cleanForTTS);

        try {
            if (settings.engine === 'system') {
                for (let i = 0; i < texts.length; i++) {
                    if (myGen !== gen) break;
                    readProgress = { done: i + 1, total: texts.length };
                    updateUI();
                    if (blocks[i]) {
                        currentEl = blocks[i];
                        blocks[i].classList.add('sb-speaking');
                    }
                    await speakSystemWait(texts[i]);
                    if (myGen !== gen) break;
                    if (blocks[i]) blocks[i].classList.remove('sb-speaking');
                }
            } else {
                if (ttsState !== 'ready') {
                    // 整篇要连续播，先把模型加载完再开始
                    setBusy(true);
                    await ensureModel();
                    setBusy(false);
                }
                if (ttsState !== 'ready') {
                    toast('语音模型未就绪，已切到系统语音');
                    settings.engine = 'system';
                    saveSettings();
                    updateUI();
                    readingAll = false;
                    readArticle();
                    return;
                }
                // 一边播一边预生成下一段，避免段间空档
                let nextUrl = synth(texts[0]).catch(() => null);
                for (let i = 0; i < texts.length; i++) {
                    if (myGen !== gen) break;
                    const url = await nextUrl;
                    if (myGen !== gen) break;
                    nextUrl = i + 1 < texts.length ? synth(texts[i + 1]).catch(() => null) : null;
                    readProgress = { done: i + 1, total: texts.length };
                    updateUI();
                    if (!url) continue;
                    if (blocks[i]) {
                        currentEl = blocks[i];
                        blocks[i].classList.add('sb-speaking');
                    }
                    await playWait(url);
                    if (blocks[i]) blocks[i].classList.remove('sb-speaking');
                }
            }
        } finally {
            // 中途 stopAll() 会 +gen，这时也要把状态收干净，
            // 否则按钮会永远卡在「停止」上，再点也开不了新的朗读
            readingAll = false;
            readProgress = { done: 0, total: 0 };
            if (myGen === gen) clearHighlight();
            updateUI();
        }
    }

    // ========== 导出整篇音频（MP3） ==========
    // 逐段合成 → 段间插 0.35s 静音 → 拼成一整条 → lamejs 编 MP3。
    // lamejs 走 CDN（150KB，浏览器会缓存）；拿不到就退回 WAV，别让功能直接死掉。
    const LAME_CDN = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
    let lamePromise = null;

    function loadLame() {
        if (window.lamejs) return Promise.resolve(window.lamejs);
        if (lamePromise) return lamePromise;
        lamePromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = LAME_CDN;
            s.onload = () => (window.lamejs ? resolve(window.lamejs) : reject(new Error('lamejs 未就绪')));
            s.onerror = () => reject(new Error('lamejs 下载失败'));
            (document.head || document.documentElement).appendChild(s);
        });
        lamePromise.catch(() => { lamePromise = null; });
        return lamePromise;
    }

    // 取一段音频的原始采样：缓存里解得出来就用缓存（快），否则现合成
    async function synthSamples(text) {
        const saved = await idbGet(cacheKey(text));
        if (saved) {
            try {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                const ac = new Ctx({ sampleRate: 24000 });
                const audio = await ac.decodeAudioData(await saved.arrayBuffer());
                const out = audio.getChannelData(0).slice();
                const rate = audio.sampleRate;
                ac.close();
                return { samples: out, sampleRate: rate };
            } catch (e) { /* 解不出来就重新合成 */ }
        }
        const model = await ensureModel();
        const audio = await model.generate(text, { voice: settings.voice, speed: settings.rate });
        return { samples: audio.audio, sampleRate: audio.sampling_rate };
    }

    function encodeMp3(samples, rate, lame) {
        const enc = new lame.Mp3Encoder(1, rate, 64);
        const block = 1152;
        const buf = new Int16Array(block);
        const out = [];
        for (let i = 0; i < samples.length; i += block) {
            const n = Math.min(block, samples.length - i);
            for (let j = 0; j < n; j++) {
                const v = Math.max(-1, Math.min(1, samples[i + j]));
                buf[j] = v < 0 ? v * 0x8000 : v * 0x7fff;
            }
            for (let j = n; j < block; j++) buf[j] = 0;  // 末块补齐
            const data = enc.encodeBuffer(buf);
            if (data.length) out.push(new Int8Array(data));
        }
        const tail = enc.flush();
        if (tail.length) out.push(new Int8Array(tail));
        return new Blob(out, { type: 'audio/mpeg' });
    }

    function saveBlob(blob, ext) {
        const base = (document.title || 'shanbay-article')
            .replace(/[\\/:*?"<>|\s]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 40) || 'shanbay-article';
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = base + '.' + ext;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    async function exportAudio() {
        if (exporting) return;
        if (!articleBlocks.length) { toast('没找到正文'); return; }
        if (settings.engine !== 'neural') { toast('导出需要神经语音引擎'); return; }

        const texts = articleBlocks.map(blockText).map(cleanForTTS)
            .filter((t) => t && /[a-zA-Z]/.test(t));
        if (!texts.length) { toast('没有可导出的内容'); return; }

        exporting = true;
        exportProgress = 0;
        syncReadBar();
        stopAll();
        setBusy(true);
        try {
            if (ttsState !== 'ready') await ensureModel();

            const parts = [];
            let rate = 24000;
            for (let i = 0; i < texts.length; i++) {
                const r = await synthSamples(texts[i]);
                rate = r.sampleRate || rate;
                parts.push(r.samples);
                parts.push(new Float32Array(Math.round(rate * 0.35)));
                exportProgress = Math.round(((i + 1) / texts.length) * 90);
                syncReadBar();
            }

            const total = parts.reduce((n, p) => n + p.length, 0);
            const all = new Float32Array(total);
            let off = 0;
            parts.forEach((p) => { all.set(p, off); off += p.length; });

            exportProgress = 95;
            syncReadBar();
            let blob;
            let ext = 'mp3';
            try {
                blob = encodeMp3(all, rate, await loadLame());
            } catch (e) {
                // 拿不到 lamejs（离线 / CDN 被墙）就导 WAV，至少能听
                blob = encodeWav16(all, rate);
                ext = 'wav';
            }
            saveBlob(blob, ext);
            toast('已导出 ' + ext.toUpperCase() + ' · ' + (blob.size / 1048576).toFixed(1) + 'MB · '
                + Math.round(total / rate) + ' 秒');
        } catch (e) {
            toast('导出失败：' + String((e && e.message) || e).slice(0, 60));
        } finally {
            exporting = false;
            exportProgress = 0;
            setBusy(false);
            syncReadBar();
        }
    }

    // 试听按钮同时也是「首次下载」的入口：点它才真正去拉模型，
    // 免得用户只是点了个句子就被偷偷下几百 MB。
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
        // 试听固定那句：绕过缓存重新生成，改完生成链路能立刻听出新效果
        speak(text, el, { fresh: !pending });
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

            // 小喇叭：全文 / 全段 / 单句。先拦下来，别让站点的点击逻辑跟着跑
            const ic = e.target.closest('.sb-ic');
            if (ic) {
                e.preventDefault();
                e.stopPropagation();
                if (ic.classList.contains('sb-ic-para')) {
                    const block = ic.closest('.sb-block');
                    if (block) speak(blockText(block), block);
                    return;
                }
                const prev = ic.previousElementSibling;
                const text = (ic.__sbText || (prev ? prev.textContent : '') || '').trim();
                if (text && /[a-zA-Z]/.test(text)) speak(text, prev || ic);
                return;
            }

            if (e.target.closest('a, button, input, textarea, select, [contenteditable="true"]')) return;

            // 划词选择时不朗读
            const sel = window.getSelection();
            if (sel && String(sel).trim()) return;

            // 阅读页：点哪句读哪句（整段太长，按句切）
            const block = e.target.closest('.sb-block');
            if (block) {
                const text = sentenceAtPoint(block, e.clientX, e.clientY);
                if (text && /[a-zA-Z]/.test(text)) speak(text, block);
                return;
            }

            const el = e.target.closest(SPEAK_SELECTOR);
            if (!el) return;
            const text = (el.textContent || '').trim();
            if (!/[a-zA-Z]/.test(text)) return;
            speak(text, el);
        }, true);

        document.addEventListener('pointerover', (e) => {
            if (!settings.speak || !(e.target instanceof Element)) return;
            const block = e.target.closest('.sb-block');
            if (block) {
                prefetch(sentenceAtPoint(block, e.clientX, e.clientY));
                return;
            }
            const el = e.target.closest(SPEAK_SELECTOR);
            if (!el) return;
            const text = (el.textContent || '').trim();
            if (/[a-zA-Z]/.test(text)) prefetch(text);
        }, true);

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') stopAll();
        });

        // 阅读页是 SPA：路由切换、正文异步渲染都要重新找段落
        window.addEventListener('hashchange', () => { clearArticle(); scheduleArticle(); });
        window.addEventListener('popstate', () => { clearArticle(); scheduleArticle(); });
        let lastUrl = location.href;
        setInterval(() => {
            if (location.href === lastUrl) return;
            lastUrl = location.href;
            clearArticle();
            scheduleArticle();
        }, 800);
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

        .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
        .actions button {
            flex: 1; padding: 8px 0; font-size: 12px; border-radius: 8px; cursor: pointer;
            border: 1px solid #e2eae7; background: #fff; color: #147864;
        }
        .actions button:hover { background: #f2f9f7; }
        .actions button.primary { background: #147864; border-color: #147864; color: #fff; }
        .actions button.primary:hover { background: #0f6455; }
        .actions button[hidden] { display: none !important; }

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
                    <button class="readall" hidden>朗读全文</button>
                    <button class="import">导入离线模型</button>
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
            readall: shadow.querySelector('.readall'),
            import: shadow.querySelector('.import'),
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
        ui.readall.addEventListener('click', readArticle);
        ui.import.addEventListener('click', pickModelFolder);

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
    let gpuReady = false;

    async function detectGPU() {
        if (!navigator.gpu) return false;
        try {
            return !!(await navigator.gpu.requestAdapter());
        } catch (e) {
            return false;
        }
    }

    // 有 GPU 用 fp32（310MB），没有就退到 q8（88MB，慢但能听）
    function sizeLabel() {
        return gpuReady ? '310MB' : '88MB';
    }

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
            ui.status.textContent = '正在下载语音模型 ' + loadPct + '% …（首次约 ' + sizeLabel() + '，之后离线可用）';
            ui.hint.textContent = '下载期间可以继续用系统语音。';
        } else if (ttsState === 'error') {
            ui.status.textContent = '模型加载失败：' + ttsError;
            ui.hint.textContent = '可以点「试听」重试，或切到系统语音。';
        } else if (settings.modelCached) {
            ui.status.textContent = '模型已下载 · 点句子会自动加载（约 1 秒）';
            ui.hint.textContent = '浏览器清过缓存的话会重新下载一次。';
        } else {
            ui.status.textContent = '神经语音未下载 · 首次约 ' + sizeLabel() + '，之后离线可用';
            ui.hint.textContent = '点「下载并试听」开始下载。';
        }
        syncPrimaryLabel();
        syncReadAll();
    }

    // 阅读页才出现「朗读全文」；正在读的时候变成停止，并带上进度
    function syncReadAll() {
        if (!ui.readall) return;
        const show = isReadingPage() && articleBlocks.length > 0;
        ui.readall.hidden = !show;
        if (show) {
            ui.readall.textContent = readingAll
                ? '停止（' + readProgress.done + '/' + readProgress.total + '）'
                : '朗读全文';
            ui.readall.classList.toggle('primary', readingAll);
        }
        syncReadBar();
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
        scheduleArticle();
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
        add('📦 导入离线模型（选 model 文件夹）', pickModelFolder);
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

        // 清掉旧配方版本的音频缓存（比如修复前生成的坏音频），否则会一直听到老声音
        idbPurgeOld().then((n) => {
            if (n > 0) {
                refreshCacheCount();
                console.log('[扇贝助手] 已清理 ' + n + ' 条旧版本音频缓存');
            }
        });

        // 探测 WebGPU，用来决定下载体积和推理设备
        detectGPU().then((v) => {
            gpuReady = v;
            updateUI();
        });

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

        // 阅读页正文是异步渲染的，DOM 一变就重扫（节流 1.2s；只加 class 不会触发 childList，不会自激）
        let articleObsTimer = null;
        new MutationObserver(() => {
            if (!isReadingPage()) return;
            clearTimeout(articleObsTimer);
            articleObsTimer = setTimeout(scanArticle, 1200);
        }).observe(document.body, { childList: true, subtree: true });

        console.log('[扇贝助手] v2.4.0 已加载：' + settings.engine + ' / ' + settings.rate + 'x');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    } else {
        bootstrap();
    }
})();
