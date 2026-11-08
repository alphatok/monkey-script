// ==UserScript==
// @name         英文朗读助手（扇贝 / 新闻 / 故事）
// @namespace    http://tampermonkey.net/
// @version      2.6.2
// @description  英文网页点句朗读（本地神经语音 Kokoro，WebGPU 加速，引擎与模型全离线），整段/全文一键连读、导出 MP3；支持扇贝阅读、CNN/BBC/NYT/卫报/VOA 等新闻站与 StoryNory/Gutenberg 等故事站
// @author       You
// @match        *://web.shanbay.com/*
// @match        *://*.shanbay.com/wordsweb/*
// @match        *://*.cnn.com/*
// @match        *://*.bbc.com/*
// @match        *://*.bbc.co.uk/*
// @match        *://*.nytimes.com/*
// @match        *://*.theguardian.com/*
// @match        *://*.npr.org/*
// @match        *://*.reuters.com/*
// @match        *://*.apnews.com/*
// @match        *://*.washingtonpost.com/*
// @match        *://*.latimes.com/*
// @match        *://*.usatoday.com/*
// @match        *://*.politico.com/*
// @match        *://*.nbcnews.com/*
// @match        *://*.cbsnews.com/*
// @match        *://*.abcnews.go.com/*
// @match        *://*.foxnews.com/*
// @match        *://*.economist.com/*
// @match        *://*.theatlantic.com/*
// @match        *://*.newyorker.com/*
// @match        *://*.time.com/*
// @match        *://*.bloomberg.com/*
// @match        *://*.scmp.com/*
// @match        *://*.aljazeera.com/*
// @match        *://*.dw.com/*
// @match        *://*.france24.com/*
// @match        *://*.telegraph.co.uk/*
// @match        *://*.thetimes.com/*
// @match        *://*.independent.co.uk/*
// @match        *://*.news.sky.com/*
// @match        *://*.voanews.com/*
// @match        *://*.breakingnewsenglish.com/*
// @match        *://*.newsinlevels.com/*
// @match        *://*.engoo.com/*
// @match        *://*.simple.wikipedia.org/*
// @match        *://*.en.wikipedia.org/*
// @match        *://*.storynory.com/*
// @match        *://*.americanliterature.com/*
// @match        *://*.gutenberg.org/*
// @match        *://*.loyalbooks.com/*
// @match        *://*.storyberries.com/*
// @match        *://*.eastoftheweb.com/*
// @match        *://*.shortkidstories.com/*
// @match        *://*.thefablecottage.com/*
// @match        *://*.read.gov/*
// @match        *://*.storylineonline.net/*
// @match        *://x.com/*
// @match        *://twitter.com/*
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

    // 语音引擎的完整依赖图（就是 jsDelivr 上那 5 个 +esm）。离线包里会把这几个
    // 文件原样带上，运行时用 blob URL 顶替，浏览器一次外网请求都不发。
    // 顺序就是拓扑序：被依赖的排在前面，生成 blob 时才能直接替换成前者的 URL。
    const ENGINE_CDN = {
        'ort-common.js': 'https://cdn.jsdelivr.net/npm/onnxruntime-common/+esm',
        'ort-web.js': 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/+esm',
        'phonemizer.js': 'https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/+esm',
        'transformers.js': 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/+esm',
        'kokoro.js': 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm'
    };
    const ENGINE_ORDER = ['ort-common.js', 'ort-web.js', 'phonemizer.js', 'transformers.js', 'kokoro.js'];
    const ENGINE_WASM = 'ort-wasm-simd-threaded.jsep.wasm';   // 21.6MB，真正的大头
    const ENGINE_MJS = 'ort-wasm-simd-threaded.jsep.mjs';
    const ENGINE_FILES = ENGINE_ORDER.concat([ENGINE_WASM, ENGINE_MJS]);

    // ========== 站点 ==========
    // 不搞「每个站点一套硬编码选择器」——那种东西三个月就烂，还得跟着人家改版跑。
    // 只区分三件事：是不是扇贝（正文本来就是每句一个元素）、是不是故事站（排版更松）、
    // 正文容器在哪。容器优先 <article>，没有就走通用打分（谁的 <p> 文本最多谁是正文），
    // 只有正文确实不在 <article> 里的站点才在 SITE_ROOT 里补一条。
    const STORY_HOSTS = ['storynory.com', 'americanliterature.com', 'gutenberg.org', 'loyalbooks.com',
        'storyberries.com', 'eastoftheweb.com', 'shortkidstories.com', 'thefablecottage.com',
        'read.gov', 'storylineonline.net'];

    // 面板里「支持的站点」打开的那个页面用的目录。改 @match 的时候记得同步这里，
    // 两边对不上用户就会看到「列表里有但没生效」。
    const SITE_CATALOG = [
        ['扇贝', [
            ['扇贝阅读', 'https://web.shanbay.com/reading', '正文逐句朗读，按英文报刊重排'],
            ['扇贝单词', 'https://web.shanbay.com/wordsweb', '单词页例句、短语']
        ]],
        ['新闻媒体', [
            ['BBC', 'https://www.bbc.com/news', ''],
            ['CNN', 'https://www.cnn.com', ''],
            ['纽约时报', 'https://www.nytimes.com', '付费墙内已登录的部分'],
            ['卫报', 'https://www.theguardian.com', ''],
            ['NPR', 'https://www.npr.org', ''],
            ['路透社', 'https://www.reuters.com', ''],
            ['美联社', 'https://apnews.com', ''],
            ['华盛顿邮报', 'https://www.washingtonpost.com', ''],
            ['洛杉矶时报', 'https://www.latimes.com', ''],
            ['今日美国', 'https://www.usatoday.com', ''],
            ['Politico', 'https://www.politico.com', ''],
            ['NBC News', 'https://www.nbcnews.com', ''],
            ['CBS News', 'https://www.cbsnews.com', ''],
            ['ABC News', 'https://abcnews.go.com', ''],
            ['Fox News', 'https://www.foxnews.com', ''],
            ['经济学人', 'https://www.economist.com', ''],
            ['大西洋月刊', 'https://www.theatlantic.com', ''],
            ['纽约客', 'https://www.newyorker.com', ''],
            ['时代周刊', 'https://time.com', ''],
            ['彭博', 'https://www.bloomberg.com', ''],
            ['南华早报', 'https://www.scmp.com', ''],
            ['半岛电视台', 'https://www.aljazeera.com', ''],
            ['德国之声 DW', 'https://www.dw.com', ''],
            ['France 24', 'https://www.france24.com', ''],
            ['每日电讯报', 'https://www.telegraph.co.uk', ''],
            ['泰晤士报', 'https://www.thetimes.com', ''],
            ['独立报', 'https://www.independent.co.uk', ''],
            ['Sky News', 'https://news.sky.com', '']
        ]],
        ['英语学习', [
            ['VOA 慢速英语', 'https://learningenglish.voanews.com', '语速慢、词汇简单，最适合练听力'],
            ['Breaking News English', 'https://breakingnewsenglish.com', '分级新闻 + 练习题'],
            ['News in Levels', 'https://www.newsinlevels.com', '同一新闻三个难度'],
            ['Engoo Daily News', 'https://engoo.com/app/daily-news', '每日短文 + 生词表'],
            ['维基百科', 'https://en.wikipedia.org', ''],
            ['Simple Wikipedia', 'https://simple.wikipedia.org', '用简单英语写的百科']
        ]],
        ['故事站 · 睡前听', [
            ['StoryNory', 'https://www.storynory.com', '童话与原创故事，每篇配朗读音频'],
            ['Project Gutenberg', 'https://www.gutenberg.org', '公版书全文：爱丽丝、傲慢与偏见……'],
            ['American Literature', 'https://americanliterature.com', '美国文学短篇 + 儿童故事'],
            ['LoyalBooks', 'https://www.loyalbooks.com', '公版有声书文本'],
            ['Storyberries', 'https://www.storyberries.com', '儿童睡前故事，按年龄分'],
            ['East of the Web', 'https://www.eastoftheweb.com', '短篇小说库'],
            ['Short Kid Stories', 'https://www.shortkidstories.com', '短篇儿童故事'],
            ['The Fable Cottage', 'https://www.thefablecottage.com', '寓言，有双语版'],
            ['Read.gov', 'https://www.read.gov', '美国国会图书馆儿童读物'],
            ['Storyline Online', 'https://www.storylineonline.net', '视频站，正文较少']
        ]],
        ['社交', [
            ['X', 'https://x.com/home', '时间线上每条推文一个小喇叭'],
            ['Twitter', 'https://twitter.com/home', '同上']
        ]]
    ];

    const SITE_ROOT = {
        'voanews.com': '#article-content, .wsw',
        'gutenberg.org': '.chapter, #chapter-content',
        'storynory.com': '.entry-content, .post-content',
        'americanliterature.com': '.story-text, .storycontent',
        'storyberries.com': '.entry-content',
        'loyalbooks.com': '.book-content'
    };

    function hostMatches(list) {
        const h = location.hostname;
        return list.some((d) => h === d || h.endsWith('.' + d));
    }

    function isShanbay() {
        return hostMatches(['shanbay.com']);
    }

    function isSocial() {
        return hostMatches(['x.com', 'twitter.com']);
    }

    function siteKind() {
        if (isShanbay()) return 'shanbay';
        if (isSocial()) return 'social';
        return hostMatches(STORY_HOSTS) ? 'story' : 'news';
    }

    function siteRootSelector() {
        const h = location.hostname;
        for (const d of Object.keys(SITE_ROOT)) {
            if (h === d || h.endsWith('.' + d)) return SITE_ROOT[d];
        }
        return '';
    }

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
        modelCached: false, // 模型下载过一次，之后点句子直接加载，不再询问
        typo: 'auto'        // 正文排版：auto = 故事站默认开、新闻站默认关；on / off 强制
    };

    // 新闻站的排版是编辑设计过的，默认别去动；故事站正文更需要「大字号 + 松行距」。
    function typoOn() {
        if (settings.typo === 'on') return true;
        if (settings.typo === 'off') return false;
        return siteKind() === 'story';
    }

    const KEY = 'sb-helper.settings.v2';
    const OLD_KEY = 'sb-helper.settings.v1';
    const STYLE_ID = 'sb-helper-style';
    const UI_ID = 'sb-helper-ui';
    const DB_NAME = 'sb-helper';
    const DB_VERSION = 2;          // v2 加了 engine 仓库，老库走 onupgradeneeded 自动补
    const DB_STORE = 'audio';
    const DB_ENGINE = 'engine';    // 离线引擎文件（wasm 21.6MB 放这儿，和音频缓存分开）

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

        /* ========== 通用站点（新闻 / 故事）正文排版 ========== */
        /* 新闻站的版式是编辑设计过的，默认不动；故事站默认打开。
           只放宽行距和字号，字体沿用站点自己的，免得「一眼看出被插件改过」。 */
        html.sb-typo .sb-block {
            font-size: 19px !important;
            line-height: 1.85 !important;
            letter-spacing: .005em !important;
            margin-bottom: 1em !important;
        }
        html.sb-typo .sb-sent-gap { margin-right: .3em; }

        /* 单句 span：平时完全隐形，只在悬停时给一点底色，不改变行内排版 */
        .sb-sent { border-radius: 3px; transition: background-color .15s ease; }
        .sb-sent:hover { background-color: rgba(32, 158, 133, .09); }

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
                req = indexedDB.open(DB_NAME, DB_VERSION);
            } catch (e) {
                resolve(null);
                return;
            }
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
                if (!req.result.objectStoreNames.contains(DB_ENGINE)) req.result.createObjectStore(DB_ENGINE);
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

    // 引擎文件单独一个仓库：清空音频缓存不该把 21MB 的 wasm 一起清掉
    async function idbGetEngine(key) {
        const db = await openDB();
        if (!db) return null;
        return new Promise((resolve) => {
            try {
                const req = db.transaction(DB_ENGINE, 'readonly').objectStore(DB_ENGINE).get(key);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            } catch (e) {
                resolve(null);
            }
        });
    }

    async function idbPutEngine(key, blob) {
        const db = await openDB();
        if (!db) return false;
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(DB_ENGINE, 'readwrite');
                tx.objectStore(DB_ENGINE).put(blob, key);
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => resolve(false);
            } catch (e) {
                resolve(false);
            }
        });
    }

    async function idbClearEngine() {
        const db = await openDB();
        if (!db) return;
        await new Promise((resolve) => {
            try {
                const req = db.transaction(DB_ENGINE, 'readwrite').objectStore(DB_ENGINE).clear();
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
            } catch (e) {
                resolve();
            }
        });
    }

    async function idbEngineCount() {
        const db = await openDB();
        if (!db) return 0;
        return new Promise((resolve) => {
            try {
                const req = db.transaction(DB_ENGINE, 'readonly').objectStore(DB_ENGINE).count();
                req.onsuccess = () => resolve(req.result || 0);
                req.onerror = () => resolve(0);
            } catch (e) {
                resolve(0);
            }
        });
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

    // ========== 离线引擎加载 ==========
    // 难点：这 5 个 +esm 之间是 ES module 的 import 关系，import 只走浏览器 HTTP 缓存，
    // 不查 Cache Storage，所以像模型那样塞缓存没用，必须让 import 本身消失。
    // 办法：把文件读出来，把 /npm/xxx/+esm 这类说明符先改写成绝对 CDN URL，
    // 再按拓扑序替换成已生成好的 blob URL——每个模块都从 blob 里 import 它的依赖，
    // 一个外网地址都不剩。wasm 与它的 .mjs 胶水同理，走 ort 的 wasmPaths 注入。
    let enginePromise = null;
    let engineLocal = false;      // 是否用的本地引擎（离线包导入过）

    async function loadEngine() {
        if (enginePromise) return enginePromise;
        enginePromise = (async () => {
            const raw = {};
            for (const name of ENGINE_FILES) {
                const blob = await idbGetEngine(name);
                if (!blob) return null;          // 没导入过引擎，交给调用方回退 CDN
                raw[name] = blob;
            }
            const urls = {};
            for (const name of ENGINE_ORDER) {
                let text = await raw[name].text();
                // /npm/ 是 jsDelivr 的根相对写法，放进 blob 会解析到站点自己的域名下，
                // 先变成绝对地址，后面才好精确替换
                text = text.replace(/\/npm\//g, 'https://cdn.jsdelivr.net/npm/');
                for (const dep of ENGINE_ORDER) {
                    if (!urls[dep]) continue;
                    const u = ENGINE_CDN[dep];
                    text = text.split('"' + u + '"').join('"' + urls[dep] + '"')
                               .split("'" + u + "'").join("'" + urls[dep] + "'");
                }
                urls[name] = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
            }
            const tf = await import(/* @vite-ignore */ urls['transformers.js']);
            // ort 支持 wasmPaths = { wasm, mjs } 这种对象写法（源码里 a?.wasm / a?.mjs），
            // 正好能让这两个文件也走 blob，否则默认会去 transformers 的 dist 目录拉
            if (tf.env && tf.env.backends && tf.env.backends.onnx) {
                tf.env.backends.onnx.wasm.wasmPaths = {
                    wasm: URL.createObjectURL(raw[ENGINE_WASM]),
                    mjs: URL.createObjectURL(raw[ENGINE_MJS])
                };
            }
            return await import(/* @vite-ignore */ urls['kokoro.js']);
        })().catch((e) => {
            enginePromise = null;
            return null;
        });
        const mod = await enginePromise;
        if (!mod) enginePromise = null;   // 缺文件时别把这个 null 缓存住
        else engineLocal = true;
        return mod;
    }


    async function ensureModel() {
        if (tts) return tts;
        if (ttsPromise) return ttsPromise;

        ttsState = 'loading';
        loadPct = 0;
        ttsError = '';
        updateUI();

        ttsPromise = (async () => {
            // 先试本地引擎（离线包里带的），没有才回 CDN
            const local = await loadEngine();
            const mod = local || (await import(/* @vite-ignore */ KOKORO_CDN));

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
            siteCached = true;
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
    // 注意：Cache Storage 和 IndexedDB 都是「按站点分家」的，模型下在 bbc.com
    // 不等于 shanbay.com 也有。GM 存储里的 settings.modelCached 是全局的，
    // 只能当「这人用过神经语音」的提示，绝不能当成「本站已缓存」。
    let siteCached = false;   // 当前站点到底有没有模型，启动时查一次

    async function refreshSiteCached() {
        siteCached = await modelInCache();
        refreshUsage();
        updateUI();
        return siteCached;
    }

    // 本站到底占了多少磁盘。Cache Storage 和 IndexedDB 都是按站点算的，
    // navigator.storage.estimate() 给的正好是这个 origin 的用量。
    let usageBytes = 0;

    async function refreshUsage() {
        try {
            if (navigator.storage && navigator.storage.estimate) {
                const est = await navigator.storage.estimate();
                usageBytes = est.usage || 0;
            }
        } catch (e) { /* 拿不到就不显示 */ }
        updateUI();
    }

    function fmtSize(n) {
        if (!n) return '0MB';
        return n >= 1073741824 ? (n / 1073741824).toFixed(1) + 'GB' : Math.round(n / 1048576) + 'MB';
    }

    // 清掉本站的模型 / 引擎 / 音频。别的站点不受影响（本来就各存各的）。
    async function clearSiteCache() {
        const msg = '清空本站的模型、引擎和音频缓存？\n'
            + '（只影响当前站点，其他站点不受影响。下次用要重新导入一次。）';
        if (typeof confirm === 'function' && !confirm(msg)) return;
        setBusy(true);
        try {
            for (const name of await caches.keys()) {
                try { await caches.delete(name); } catch (e) { /* ignore */ }
            }
            await idbClearEngine();
            await idbClear();
            tts = null;
            ttsPromise = null;
            ttsState = 'idle';
            enginePromise = null;
            engineLocal = false;
            blobCache.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } });
            blobCache.clear();
            siteCached = false;
            cacheCount = 0;
            // 这里不能再去问 estimate()：同一个文档里它的数字是滞后的
            // （实测删完还报 315MB，刷新页面才变 0），所以直接按已知事实归零。
            usageBytes = 0;
            updateUI();
            refreshCacheCount();
            toast('本站缓存已清空');
        } catch (e) {
            toast('清理失败：' + String((e && e.message) || e).slice(0, 40));
        } finally {
            setBusy(false);
            updateUI();
        }
    }

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

    // ========== 离线导入 ==========
    // 给「完全没网」的场景用：选一次整个包目录，脚本会同时收两样东西——
    //   model/  → 按 transformers.js 的缓存键（HuggingFace 原始 URL）写进 Cache Storage
    //   engine/ → 5 个 +esm、wasm、mjs 写进 IndexedDB，运行时转成 blob URL
    // 两边都齐了就是真离线：模型命中缓存，引擎走 blob，一个字节都不出网。
    // 不需要本地服务器，也不需要额外权限（input[webkitdirectory] 就够）。
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
        let engine = 0;
        const names = [];
        for (const f of fileList) {
            const base = f.name;
            // 引擎文件（engine/ 目录）按文件名认，存进 IndexedDB，运行时变成 blob
            if (ENGINE_FILES.indexOf(base) >= 0) {
                if (await idbPutEngine(base, f)) engine++;
                n++;
                bytes += f.size;
                names.push('engine/' + base);
                if (ui.status) ui.status.textContent = '正在导入 ' + n + ' 个文件 · ' + (bytes / 1048576).toFixed(0) + 'MB';
                continue;
            }
            const rel = modelRelPath(f.webkitRelativePath || f.name);
            if (!rel) continue;
            const cache = rel.indexOf('voices/') === 0 ? voice : main;
            await cache.put(MODEL_BASE + rel, new Response(f));
            n++;
            bytes += f.size;
            names.push(rel);
            if (ui.status) ui.status.textContent = '正在导入 ' + n + ' 个文件 · ' + (bytes / 1048576).toFixed(0) + 'MB';
        }
        if (engine) enginePromise = null;   // 引擎换过了，之前加载的作废
        return { n, bytes, names, engine };
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
                    refreshSiteCached();
                    // 导入会把 model.onnx(310MB) 和 model_quantized.onnx(88MB) 都塞进去，
                    // 但推理只用得上其中一份。留着另一份纯占地方，直接按当前设备清掉。
                    // 用 detectGPU() 现问一次，而不是看 gpuReady——那个是启动时异步填的，
                    // 刚打开页面就导入的话可能还是 false，会把 GPU 版删掉。
                    detectGPU().then((hd) =>
                        purgeStaleModels(hd ? 'model.onnx' : 'model_quantized.onnx')).then(refreshUsage);
                    toast('已导入 ' + r.n + ' 个文件 · ' + (r.bytes / 1048576).toFixed(0) + 'MB'
                        + (r.engine >= ENGINE_FILES.length ? '（含离线引擎）' : '')
                        + '，现在断网也能用');
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
        // 关键：把正在等的那个 promise 放掉。整篇朗读是
        //   await playWait(url) / await speakSystemWait(text)
        // 一段一段往下走的，暂停音频并不会让这两个 promise 自己 resolve，
        // 于是循环永远卡在 await 上、finally 不执行、readingAll 一直 true，
        // 按钮就永远停在「停止」——再点也只是又 stopAll 一次，怎么都放不出声音。
        if (playResolve) {
            const done = playResolve;
            playResolve = null;
            try { done(); } catch (e) { /* ignore */ }
        }
        // 整篇朗读的状态在这里就收掉，别等循环自己退出（它可能还在 await 上）
        readingAll = false;
        readProgress = { done: 0, total: 0 };
        try {
            audioEl.pause();
            audioEl.removeAttribute('src');
            audioEl.load();   // 彻底放掉上一段 buffer，避免残留音轨
        } catch (e) { /* ignore */ }
        try {
            window.speechSynthesis.cancel();
        } catch (e) { /* ignore */ }
        updateUI();
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
            // 现场查本站缓存：GM 里的 modelCached 是全站共享的，靠它判断会换个站点就重下 310MB
            const here = await modelInCache();
            if (here) {
                siteCached = true;
                // 本站确实有缓存，直接加载，不再打断用户
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
            // 本站没缓存：别悄悄拉几百 MB，弹面板让用户自己决定
            pendingAfterLoad = { text, el };
            openPanel();
            toast(settings.modelCached
                ? '这个站点还没导入模型，点「导入离线模型」选一次包目录'
                : '神经语音还没准备好，点「试听」下载或导入离线包');
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

    // 需要挂朗读 UI 的页面。扇贝只在阅读页（单词页另有逻辑），
    // 其它站点 @match 已经限定了域名，是不是正文交给 scanArticle 按内容判断。
    function isArticlePage() {
        if (isShanbay()) return isReadingPage();
        return true;
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
        document.documentElement.classList.remove('sb-typo');
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
        const show = isArticlePage() && articleBlocks.length > 0;
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
        const shanbay = isShanbay();
        articleBlocks.forEach((block) => {
            // 新闻/故事站的段落是整块纯文本，先把句子切成 span 才挂得上单句喇叭
            if (!shanbay) wrapSentences(block);
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

    // 通用正文容器：站点指定选择器 → <article> → 按 <p> 文本量打分。
    // 打分只遍历一遍 <p>、往上叠 8 层，避免「每个 div 都 querySelectorAll」的 O(n²)。
    function findArticleRoot() {
        const sel = siteRootSelector();
        if (sel) {
            const el = document.querySelector(sel);
            if (el) return el;
        }
        const art = document.querySelector('article');
        if (art && (art.textContent || '').trim().length > 300) return art;

        const scores = new Map();
        document.querySelectorAll('p').forEach((p) => {
            const t = (p.textContent || '').trim();
            if (t.length < 40 || !looksEnglish(t)) return;
            let el = p.parentElement;
            for (let d = 0; el && d < 8; d++, el = el.parentElement) {
                scores.set(el, (scores.get(el) || 0) + t.length);
            }
        });
        let best = null;
        let bestScore = 0;
        scores.forEach((s, el) => {
            // 同分取更深的那个：外层容器只是把同一批段落又算了一遍
            if (s > bestScore || (s === bestScore && best && el.contains(best))) {
                best = el;
                bestScore = s;
            }
        });
        return best || document.body;
    }

    // 通用站点的段落是「一整段纯文本」，没有「每句一个元素」这回事。
    // 要把句子切成 span 才挂得上单句喇叭。用 Range 按字符区间切：
    // 句子跨 <a>/<em> 时 extractContents 会把半个元素克隆进 span，结构不会坏。
    // 从后往前切，前面句子的偏移才不会被打乱。
    function wrapSentences(block) {
        if (block.querySelector('.sb-sent')) return;
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
        const nodes = [];
        let full = '';
        let n;
        while ((n = walker.nextNode())) {
            nodes.push({ node: n, start: full.length });
            full += n.nodeValue;
        }
        if (!full.trim()) return;
        const sents = splitSentences(full);
        if (sents.length < 2) return;

        const locate = (offset) => {
            for (let i = nodes.length - 1; i >= 0; i--) {
                const it = nodes[i];
                const len = it.node.nodeValue.length;
                if (offset >= it.start && offset <= it.start + len) return { node: it.node, off: offset - it.start };
            }
            return null;
        };

        for (let i = sents.length - 1; i >= 0; i--) {
            const s = sents[i];
            const a = locate(s.start);
            const b = locate(s.start + s.text.length);
            if (!a || !b) continue;
            const range = document.createRange();
            try {
                range.setStart(a.node, Math.min(a.off, a.node.nodeValue.length));
                range.setEnd(b.node, Math.min(b.off, b.node.nodeValue.length));
                const span = document.createElement('span');
                span.className = 'sb-sent';
                span.appendChild(range.extractContents());
                range.insertNode(span);
            } catch (e) { /* 切不动就跳过，点击朗读照样能用 */ }
        }
    }

    // 从一个容器里挑出「叶子段落」：内部还有块级元素的说明是容器不是段落。
    function collectBlocks(root, shanbay) {
        if (!root) return [];
        const nodes = root.querySelectorAll(shanbay ? 'p, li, div' : 'p, li, blockquote');
        const out = [];
        for (let i = 0; i < nodes.length && out.length < 400; i++) {
            const el = nodes[i];
            if (el.closest('nav, header, footer, aside, form, .sb-panel, #' + UI_ID)) continue;
            if (el.querySelector('p, div, li, ul, ol, section, article, h1, h2, h3, h4, table')) continue;
            // 图注 / 署名 / 时间 / 相关阅读不是正文，别挂喇叭
            if (!shanbay && el.closest('figcaption, .caption, .image-caption, .credit, .byline, .timestamp, .related, [class*="caption"], [class*="byline"]')) continue;
            const t = (el.textContent || '').trim();
            if (t.length < 15 || t.length > 3000) continue;
            if (!looksEnglish(t)) continue;
            out.push(el);
        }
        return out;
    }

    // 链接密度：正文里几乎没链接，首页/导航/卡片墙基本全是链接。
    // 实测 BBC 首页那个 <article> 是 0.99，文章页 0.09，故事站 0.005——这条比任何选择器都稳。
    function linkDensity(root) {
        if (!root) return 1;
        const total = (root.textContent || '').length;
        if (!total) return 1;
        let linked = 0;
        root.querySelectorAll('a').forEach((a) => { linked += (a.textContent || '').length; });
        return linked / total;
    }

    function textLen(list) {
        return list.reduce((n, el) => n + el.textContent.trim().length, 0);
    }

    // 同一父元素下兄弟段落最多的那一组。首页的卡片摘要散落在几十个卡片容器里，
    // 文章的段落则是「一个爹的一串兄弟」，这条能有效把首页挡在外面。
    function longestSiblingRun(list) {
        const byParent = new Map();
        list.forEach((el) => {
            const p = el.parentElement;
            if (!byParent.has(p)) byParent.set(p, []);
            byParent.get(p).push(el);
        });
        let best = [];
        byParent.forEach((arr) => { if (arr.length > best.length) best = arr; });
        return best;
    }

    // X / Twitter：没有「文章」，一条推文就是一段。只认 tweetText，
    // 每条挂一个小喇叭；不切句子、不套排版、不劫持整页点击。
    function scanTweets() {
        const list = [...document.querySelectorAll('[data-testid="tweetText"]')]
            .filter((el) => (el.textContent || '').trim().length >= 2)
            .slice(0, 80);
        if (!list.length) {
            clearArticle();
            updateUI();
            return;
        }
        articleBlocks = list;
        list.forEach((el) => {
            el.classList.add('sb-block');
            if (el.getAttribute('lang') !== 'en') el.setAttribute('lang', 'en');
            if (!el.querySelector(':scope > .sb-ic-para')) {
                const ic = makeIcon('para', '朗读这条');
                ic.style.cssText = 'margin-left:6px;vertical-align:-2px;';
                el.appendChild(ic);
            }
        });
        syncReadBar();
        updateUI();
    }

    function scanArticle() {
        if (!isArticlePage() || !document.body) return;
        if (isSocial()) {
            scanTweets();
            return;
        }
        const shanbay = isShanbay();
        let blocks;

        if (shanbay) {
            blocks = collectBlocks(document.querySelector('article') || document.body, true);
        } else {
            // 先信 <article>：新闻站的文章几乎都包在里面，比任何启发式都准。
            // 首页的卡片虽然也可能用 <article>，但单张卡片凑不出「3 段 + 400 字」。
            const art = document.querySelector('article');
            const inArt = art && linkDensity(art) <= 0.35 ? collectBlocks(art, false) : [];
            if (inArt.length >= 3 && textLen(inArt) >= 400) {
                blocks = inArt;
            } else {
                const root = findArticleRoot();
                blocks = root && linkDensity(root) <= 0.35
                    ? longestSiblingRun(collectBlocks(root, false))
                    : [];
            }
        }

        const minBlocks = shanbay ? ARTICLE_MIN_BLOCKS : 3;
        const minChars = shanbay ? ARTICLE_MIN_CHARS : 400;
        const blockChars = textLen(blocks);
        const longOnes = shanbay ? 99 : blocks.filter((el) => el.textContent.trim().length >= 120).length;
        if (blocks.length < minBlocks || blockChars < minChars || longOnes < 2) {
            clearArticle();
            updateUI();
            return;
        }
        const same = blocks.length === articleBlocks.length && blocks.every((el, i) => el === articleBlocks[i]);
        if (!same) {
            clearArticle();
            articleBlocks = blocks;
            blocks.forEach((el) => {
                el.classList.add('sb-block');
                // 标成英文：断词（hyphens:auto）和读屏发音都靠它，站点默认是 zh-CN
                if (el.getAttribute('lang') !== 'en') el.setAttribute('lang', 'en');
                fixSentenceSpacing(el);
            });
            if (shanbay) document.documentElement.classList.add('sb-read');
            if (!shanbay && typoOn()) document.documentElement.classList.add('sb-typo');
        }
        // 段落没变也要补图标：React 重渲染会把插进去的图标冲掉
        decorateArticle();
        updateUI();
    }

    // SPA 路由切换 / 正文异步渲染都要重扫，但别扫太勤
    let articleTimer = null;
    function scheduleArticle() {
        if (!isArticlePage()) return;
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
            // 延迟 60ms 是为了让 cancel() 先落地；这期间可能已经被 stopAll 掉了，
            // 那就别再开口，否则「刚点停止又冒出声音」
            setTimeout(() => { if (!settled) synth.speak(u); }, 60);
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
                    // 整篇要连续播，先把模型加载完再开始。
                    // 但本站没缓存就别闷头下 310MB——先问一句，让用户选导入还是在线下载。
                    if (!(await modelInCache())) {
                        openPanel();
                        toast('本站还没导入语音模型：点「导入离线模型」选一次包目录，或用系统语音');
                        readingAll = false;
                        readProgress = { done: 0, total: 0 };
                        updateUI();
                        return;
                    }
                    siteCached = true;
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

            // X / Twitter 上点击是导航和展开，只认喇叭，别的一概不接
            if (isSocial()) return;

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
            if (isSocial()) return;   // 时间线上滑一下就合成一条，纯属浪费
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

        .usage {
            margin-top: 8px; font-size: 12px; color: #8a938f;
            display: flex; justify-content: space-between; align-items: center; gap: 10px;
        }
        .usage-clear {
            color: #a4562a; cursor: pointer; text-decoration: none;
            border-bottom: 1px dashed rgba(164, 86, 42, .35); white-space: nowrap;
        }
        .usage-clear:hover { border-bottom-style: solid; }
        :host(.dark) .usage { color: #7d8a86; }
        :host(.dark) .usage-clear { color: #e0a074; border-bottom-color: rgba(224, 160, 116, .35); }

        .sites { margin-top: 8px; text-align: right; }
        .sites-link {
            font: 12px/1 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
            color: #147864; cursor: pointer; text-decoration: none;
            border-bottom: 1px dashed rgba(20, 120, 100, .35);
        }
        .sites-link:hover { border-bottom-style: solid; }
        :host(.dark) .sites-link { color: #6fd3b8; border-bottom-color: rgba(111, 211, 184, .35); }

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
                    <label class="typoRow"><input type="checkbox" class="typo"> 正文排版（大字 / 松行距）</label>
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
                <div class="usage" hidden><span class="usage-text"></span><a class="usage-clear">清理本站</a></div>
                <div class="sites"><a class="sites-link">支持的站点 ›</a></div>
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
            typo: shadow.querySelector('.typo'),
            typoRow: shadow.querySelector('.typoRow'),
            status: shadow.querySelector('.status'),
            bar: shadow.querySelector('.bar'),
            barFill: shadow.querySelector('.bar i'),
            test: shadow.querySelector('.test'),
            readall: shadow.querySelector('.readall'),
            import: shadow.querySelector('.import'),
            clear: shadow.querySelector('.clear'),
            hint: shadow.querySelector('.hint'),
            sites: shadow.querySelector('.sites-link'),
            usage: shadow.querySelector('.usage'),
            usageText: shadow.querySelector('.usage-text'),
            usageClear: shadow.querySelector('.usage-clear')
        };

        ui.gear.addEventListener('click', () => {
            ui.panel.classList.toggle('open');
            if (ui.panel.classList.contains('open')) refreshCacheCount();
        });
        ui.close.addEventListener('click', () => ui.panel.classList.remove('open'));
        ui.sites.addEventListener('click', (e) => { e.preventDefault(); openSiteList(); });
        ui.usageClear.addEventListener('click', (e) => { e.preventDefault(); clearSiteCache(); });

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
        ui.typo.addEventListener('change', () => {
            settings.typo = ui.typo.checked ? 'on' : 'off';
            saveSettings();
            document.documentElement.classList.toggle('sb-typo', ui.typo.checked);
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
        ui.usage.hidden = !(siteCached || usageBytes);
        if (!ui.usage.hidden) {
            ui.usageText.textContent = '本站占用 ' + fmtSize(usageBytes)
                + (siteCached ? '' : '（没有模型）');
        }
        ui.typo.checked = typoOn();
        // 扇贝阅读的排版是强制套用的，这一项只对别的站点有意义
        ui.typoRow.style.display = isShanbay() ? 'none' : '';

        // 状态
        ui.status.classList.toggle('err', ttsState === 'error');
        ui.bar.classList.toggle('show', ttsState === 'loading');
        ui.barFill.style.width = loadPct + '%';

        if (settings.engine === 'system') {
            ui.status.textContent = '使用浏览器内置语音，零下载、即点即读。音质一般，胜在快。';
            ui.hint.textContent = '神经语音更自然，但首次需下载模型。';
        } else if (ttsState === 'ready') {
            ui.status.textContent = '神经语音已就绪 · ' + (ttsDevice === 'webgpu' ? 'WebGPU 加速' : 'CPU（较慢）')
                + (engineLocal ? ' · 离线引擎' : '') + ' · 已缓存 ' + cacheCount + ' 句';
            ui.hint.textContent = engineLocal
                ? '引擎和模型都在本地，完全断网也能读。'
                : '生成的音频会存本地，重复播放零等待。';
        } else if (ttsState === 'loading') {
            ui.status.textContent = '正在下载语音模型 ' + loadPct + '% …（首次约 ' + sizeLabel() + '，之后离线可用）';
            ui.hint.textContent = '下载期间可以继续用系统语音。';
        } else if (ttsState === 'error') {
            ui.status.textContent = '模型加载失败：' + ttsError;
            ui.hint.textContent = '可以点「试听」重试，或切到系统语音。';
        } else if (siteCached) {
            ui.status.textContent = '本站模型已就绪 · 点句子会自动加载（约 1 秒）';
            ui.hint.textContent = '模型存在浏览器里，按站点分开存，换站点要再导入一次（0.5 秒）。';
        } else if (settings.modelCached) {
            ui.status.textContent = '本站还没导入模型（模型按站点分开存）';
            ui.hint.textContent = '点「导入离线模型」选一次包目录，0.5 秒搞定，不用重新下载。';
        } else {
            ui.status.textContent = '神经语音未下载 · 首次约 ' + sizeLabel() + '，之后离线可用';
            ui.hint.textContent = '点「试听」在线下载，或用离线包导入。';
        }
        syncPrimaryLabel();
        syncReadAll();
    }

    // 阅读页才出现「朗读全文」；正在读的时候变成停止，并带上进度
    function syncReadAll() {
        if (!ui.readall) return;
        const show = isArticlePage() && articleBlocks.length > 0;
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

    // 面板里的「支持的站点」：本地拼一页 HTML 用新标签打开。
    // 走 blob URL，断网也能看，也不用额外维护一个线上页面。
    function openSiteList() {
        const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const groups = SITE_CATALOG.map(([name, items]) => {
            const rows = items.map(([label, url, note]) => {
                const host = url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
                return '<li><a href="' + esc(url) + '" target="_blank" rel="noreferrer">' + esc(label) + '</a>'
                    + '<span class="host">' + esc(host) + '</span>'
                    + (note ? '<span class="note">' + esc(note) + '</span>' : '')
                    + '</li>';
            }).join('');
            return '<section><h2>' + esc(name) + '<em>' + items.length + '</em></h2><ul>' + rows + '</ul></section>';
        }).join('');
        const total = SITE_CATALOG.reduce((n, g) => n + g[1].length, 0);

        const html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
            + '<title>英文朗读助手 · 支持站点</title><style>'
            + '*{box-sizing:border-box}'
            + 'body{margin:0;padding:40px 20px 80px;background:#f6f7f7;color:#1b1b1b;'
            + 'font:15px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}'
            + '.wrap{max-width:860px;margin:0 auto}'
            + 'h1{font-size:26px;margin:0 0 6px}'
            + '.sub{color:#777;margin:0 0 26px;font-size:14px}'
            + 'section{background:#fff;border-radius:12px;padding:18px 22px 8px;margin-bottom:16px;'
            + 'box-shadow:0 2px 14px rgba(0,0,0,.05)}'
            + 'h2{font-size:17px;margin:0 0 10px;padding-left:10px;border-left:4px solid #147864}'
            + 'h2 em{font-style:normal;font-size:12px;color:#8aa;margin-left:8px}'
            + 'ul{list-style:none;margin:0;padding:0}'
            + 'li{padding:7px 0;border-bottom:1px solid #f0f2f1;display:flex;flex-wrap:wrap;'
            + 'align-items:baseline;gap:10px}'
            + 'li:last-child{border-bottom:0}'
            + 'a{color:#147864;text-decoration:none;font-weight:600;min-width:180px}'
            + 'a:hover{text-decoration:underline}'
            + '.host{color:#9aa5a1;font:12px/1 "SF Mono",Menlo,monospace}'
            + '.note{color:#777;font-size:13px;flex:1 1 240px}'
            + 'footer{margin-top:24px;color:#777;font-size:13px;line-height:1.9}'
            + '</style></head><body><div class="wrap">'
            + '<h1>支持的站点</h1>'
            + '<p class="sub">共 ' + total + ' 个。打开<b>文章页 / 故事页</b>才会在正文挂小喇叭；'
            + '首页和栏目页是故意跳过的（按链接密度和段落密度自动判断）。</p>'
            + groups
            + '<footer>模型和引擎存在浏览器里，<b>按站点分开存</b>：每个站点第一次用，'
            + '点一次齿轮 →「导入离线模型」选一下离线包目录即可，0.5 秒，不用重新下载。<br>'
            + '想加新站点：Tampermonkey 面板里编辑脚本，在 @match 段落照着加一行，刷新即可。</footer>'
            + '</div></body></html>';

        const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        window.open(url, '_blank', 'noopener');
        setTimeout(() => URL.revokeObjectURL(url), 120000);
    }

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
        add('🌐 支持的站点', openSiteList);
        add('📦 导入离线模型（选包目录）', pickModelFolder);
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

        // 先查本站到底有没有模型（Cache Storage 按站点分家），再决定要不要预热
        refreshSiteCached().then(() => setTimeout(warmUp, 1500));

        // 清掉旧配方版本的音频缓存（比如修复前生成的坏音频），否则会一直听到老声音
        idbPurgeOld().then((n) => {
            if (n > 0) {
                refreshCacheCount();
                console.log('[英文朗读助手] 已清理 ' + n + ' 条旧版本音频缓存');
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
            if (!isArticlePage()) return;
            // 扇贝是 SPA，重渲染会把图标冲掉，所以要一直盯着；
            // 新闻站 DOM 天天在动（广告、推荐位），挂好之后没被拆掉就别再扫了，省得白烧 CPU。
            if (!isShanbay() && articleBlocks.length && articleBlocks.every((el) => el.isConnected)) return;
            clearTimeout(articleObsTimer);
            articleObsTimer = setTimeout(scanArticle, 1200);
        }).observe(document.body, { childList: true, subtree: true });

        console.log('[英文朗读助手] v2.6.2 已加载：' + settings.engine + ' / ' + settings.rate + 'x');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    } else {
        bootstrap();
    }
})();
