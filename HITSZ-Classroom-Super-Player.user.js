// ==UserScript==
// @name         HITSZ 课堂视频超级播放器
// @namespace    http://tampermonkey.net/
// @version      32.0
// @description  【仅支持 Violentmonkey 暴力猴，不支持 Tampermonkey 油猴】HITSZ 视频平台功能增强脚本。现代化UI，进度条拖动精准流畅。支持画中画（老师与课件同时显示），可调整大小比例，去黑边。支持两通道音量在0-500%独立调节，支持人声增强。
// @author       BCC
// @match        *://jxypt.hitsz.edu.cn/ve/back/rp/common/rpIndex.shtml?method=studyCourseDeatil*
// @match        *://jxypt-hitsz-edu-cn-s.hitsz.edu.cn/ve/back/rp/common/rpIndex.shtml?method=studyCourseDeatil*
// @updateURL    https://openuserjs.org/meta/BCC-HIT/HITSZ_%E8%AF%BE%E5%A0%82%E8%A7%86%E9%A2%91%E8%B6%85%E7%BA%A7%E6%92%AD%E6%94%BE%E5%99%A8.meta.js
// @downloadURL  https://openuserjs.org/install/BCC-HIT/HITSZ_%E8%AF%BE%E5%A0%82%E8%A7%86%E9%A2%91%E8%B6%85%E7%BA%A7%E6%92%AD%E6%94%BE%E5%99%A8.user.js
// @require      https://cdn.jsdelivr.net/npm/hls.js@1.4.0/dist/hls.min.js
// @grant        unsafeWindow
// @license      MIT
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const capturedUrls = new Set();

    let isPlayerLaunched = false;
    let videoMeta = { title: '未知课程', teacher: '未知教师', date: '' };

    // 状态管理
    const state = {
        isSwapped: false,
        syncOffset: 0.0,
        vocalGain: 5,
        isPipVisible: true,
        isCropV1: false,
        isCropV2: false,
        isStretchMain: false,
        vol1: 1.0,
        vol2: 0.0,
        rate: 1.0,
        bufferedHistory: [],
        isControlHovered: false // 新增：是否正悬停在控制栏上
    };

    let audioCtx;
    const nodes = { v1: null, v2: null };

    console.log("HSP V30.0 (Author: BCC): 引擎启动...");

    // 0. 信息抓取
    function scrapePageInfo() {
        try {
            const titleEl = document.querySelector('#kcmc') || document.querySelector('.course-title') || document.querySelector('h3');
            if(titleEl) videoMeta.title = titleEl.innerText.trim();
            const teacherEl = document.querySelector('#skjs') || document.querySelector('.teacher-name');
            if(teacherEl) videoMeta.teacher = teacherEl.innerText.trim();
            const timeEl = document.querySelector('#sksj') || document.querySelector('.time');
            if(timeEl) videoMeta.date = timeEl.innerText.trim();
        } catch(e) {}
    }
    window.addEventListener('DOMContentLoaded', scrapePageInfo);

    function parseMetaFromUrl(url) {
        try {
            const decoded = decodeURI(url);
            const match = decoded.match(/\/([^\/]+)\.mp4\//);
            if (match && match[1]) {
                const parts = match[1].split('_');
                if (parts.length >= 2) {
                    videoMeta.title = parts[0];
                    videoMeta.teacher = parts[1];
                    const datePart = parts.find(p => p.match(/^20\d{6,}/));
                    if (datePart) videoMeta.date = datePart.substring(0,4) + '-' + datePart.substring(4,6) + '-' + datePart.substring(6,8);
                }
            }
        } catch(e) {}
    }

    // 1. 网络嗅探
    const isValidStream = (url) => {
        if (typeof url !== 'string') return false;
        const isVideo = url.includes('.m3u8') || url.includes('.mp4');
        const isSegment = url.includes('.ts') || url.includes('seg-') || url.includes('fragment') || url.includes('chunklist');
        return isVideo && !isSegment;
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (isValidStream(url)) {
            capturedUrls.add(url);
            document.querySelectorAll('video:not(#hsp-v1):not(#hsp-v2)').forEach(v => { v.muted = true; v.volume = 0; });
            tryLaunch();
        }


        return originalOpen.apply(this, arguments);
    };

    const originalFetch = window.fetch;
    window.fetch = function(url, options) {
        if (isValidStream(url)) {
            capturedUrls.add(url);
            document.querySelectorAll('video:not(#hsp-v1):not(#hsp-v2)').forEach(v => { v.muted = true; v.volume = 0; });
            tryLaunch();
        }
        return originalFetch.apply(this, arguments);
    };

    let launchTimer;
    let launchScheduled = false; // 修复：防止延迟窗口内重复排期
    function tryLaunch() {
        if (isPlayerLaunched || launchScheduled) return;
        launchScheduled = true; // 立刻锁住，后续XHR/fetch不再重置计时器
        launchTimer = setTimeout(() => {
            // 修复：严格限制最多取前两条，防止HLS子manifest被误当第二路流
            const validList = Array.from(capturedUrls).filter(isValidStream).slice(0, 2);
            if (validList.length > 0) {
                isPlayerLaunched = true; // 修复：在任何异步操作前先锁住，防止race condition
                parseMetaFromUrl(validList[0]);
                renderUI(validList);
            } else {
                // 没拿到流则重置，允许下次重试
                launchScheduled = false;
            }
        }, 1200);
    }

    // 2. 音频引擎
    function setupAudioNode(videoEl, id) {
        if (nodes[id]) return nodes[id];
        try {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const source = audioCtx.createMediaElementSource(videoEl);
            const gain = audioCtx.createGain();
            const lowpass = audioCtx.createBiquadFilter();
            const highpass = audioCtx.createBiquadFilter();
            const highshelf = audioCtx.createBiquadFilter();
            const peaking = audioCtx.createBiquadFilter();
            const compressor = audioCtx.createDynamicsCompressor();

            highpass.type = 'highpass'; highpass.frequency.value = 80;
            lowpass.type = 'lowpass'; lowpass.frequency.value = 22000;
            highshelf.type = 'highshelf'; highshelf.frequency.value = 4000; highshelf.gain.value = 0;
            peaking.type = 'peaking'; peaking.frequency.value = 2000; peaking.Q.value = 0.8; peaking.gain.value = 0;
            compressor.threshold.value = -10; compressor.ratio.value = 10;

            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 4096; // 足够精度的时域数据

            source.connect(analyser); analyser.connect(highpass); highpass.connect(lowpass); lowpass.connect(highshelf);
            highshelf.connect(peaking); peaking.connect(compressor); compressor.connect(gain);
            gain.connect(audioCtx.destination);

            nodes[id] = { gain, lowpass, highpass, highshelf, peaking, compressor, analyser };
        } catch(e) {
            // Web Audio Graph 建立失败（如AudioContext被抢占），降级为直接用video.volume
            console.warn('[HSP] Web Audio fallback for', id, e);
            nodes[id] = null; // 保持null，updateAudioState会用video.volume兜底
        }
        return nodes[id];
    }

    function updateAudioState(v1, v2) {
        // Web Audio Graph路径
        if (audioCtx) {
            if (audioCtx.state === 'suspended') audioCtx.resume();
            if (nodes.v1) { v1.volume = 1; nodes.v1.gain.gain.value = state.vol1; }
            if (nodes.v2) { v2.volume = 1; nodes.v2.gain.gain.value = state.vol2; }
            [nodes.v1, nodes.v2].forEach(n => {
                if (!n) return;
                if (state.vocalGain > 0) {
                    n.peaking.gain.value = state.vocalGain;
                    n.highshelf.gain.value = Math.max(-20, -1 * state.vocalGain);
                    n.lowpass.frequency.value = 10000;
                } else {
                    n.peaking.gain.value = 0;
                    n.highshelf.gain.value = 0;
                    n.lowpass.frequency.value = 22000;
                }
            });
        }
        // Fallback：AudioContext未建立或Graph失败时，直接用video.volume（上限1.0）
        if (!audioCtx || !nodes.v1) { v1.volume = Math.min(1, state.vol1); }
        if (!audioCtx || !nodes.v2) { v2.volume = Math.min(1, state.vol2); }
    }

    // 6. 自动视角对齐（实时采集8s PCM + FFT互相关，搜索范围±5s）
    function autoAlign(v1, v2, onResult, onError) {
        const SAMPLE_DUR = 8.0;
        const SEARCH_SEC = 5.0;
        const SR = audioCtx ? audioCtx.sampleRate : 44100;
        const FRAME = 2048;

        if (!audioCtx || !nodes.v1 || !nodes.v2 || !nodes.v1.analyser || !nodes.v2.analyser) {
            onError('音频引擎未就绪，请先点击页面触发音频解锁');
            return;
        }
        if (audioCtx.state === 'suspended') audioCtx.resume();

        const buf1 = [], buf2 = [];
        const totalFrames = Math.ceil((SAMPLE_DUR * SR) / FRAME);
        let collected = 0;

        const proc1 = audioCtx.createScriptProcessor(FRAME, 1, 1);
        const proc2 = audioCtx.createScriptProcessor(FRAME, 1, 1);
        nodes.v1.analyser.connect(proc1); proc1.connect(audioCtx.destination);
        nodes.v2.analyser.connect(proc2); proc2.connect(audioCtx.destination);

        proc1.onaudioprocess = e => {
            if (collected >= totalFrames) return;
            buf1.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        };
        proc2.onaudioprocess = e => {
            if (collected >= totalFrames) return;
            buf2.push(new Float32Array(e.inputBuffer.getChannelData(0)));
            collected++;
        };

        setTimeout(() => {
            try { proc1.disconnect(); proc2.disconnect(); } catch(e) {}
            if (buf1.length < 2 || buf2.length < 2) {
                onError('采集数据不足，请确保视频正在播放');
                return;
            }
            const n = Math.min(buf1.length, buf2.length);
            const len = n * FRAME;
            const s1 = new Float32Array(len);
            const s2 = new Float32Array(len);
            buf1.slice(0, n).forEach((f, i) => s1.set(f, i * FRAME));
            buf2.slice(0, n).forEach((f, i) => s2.set(f, i * FRAME));

            const workerCode = `
function fft(buf) {
    const n = buf.length >> 1;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            let t = buf[2*i]; buf[2*i] = buf[2*j]; buf[2*j] = t;
            t = buf[2*i+1]; buf[2*i+1] = buf[2*j+1]; buf[2*j+1] = t;
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len;
        const wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let j = 0; j < len >> 1; j++) {
                const u = 2*(i+j), v = 2*(i+j+(len>>1));
                const pr = buf[v]*cr - buf[v+1]*ci;
                const pi = buf[v]*ci + buf[v+1]*cr;
                buf[v] = buf[u]-pr; buf[v+1] = buf[u+1]-pi;
                buf[u] += pr; buf[u+1] += pi;
                const nr = cr*wr - ci*wi; ci = cr*wi + ci*wr; cr = nr;
            }
        }
    }
}
function ifft(buf) {
    const n = buf.length >> 1;
    for (let i = 1; i < n; i++) buf[2*i+1] = -buf[2*i+1];
    fft(buf);
    for (let i = 0; i < n; i++) { buf[2*i] /= n; buf[2*i+1] = -buf[2*i+1] / n; }
}
self.onmessage = function(e) {
    const { s1, s2, SR, SEARCH_SEC } = e.data;
    const len = s1.length;
    let sum1 = 0, sum2 = 0;
    for (let i = 0; i < len; i++) { sum1 += s1[i]*s1[i]; sum2 += s2[i]*s2[i]; }
    const r1 = Math.sqrt(sum1/len) || 1, r2 = Math.sqrt(sum2/len) || 1;
    for (let i = 0; i < len; i++) { s1[i] /= r1; s2[i] /= r2; }
    let fftSize = 1;
    while (fftSize < 2 * len) fftSize <<= 1;
    const A = new Float64Array(fftSize * 2), B = new Float64Array(fftSize * 2);
    for (let i = 0; i < len; i++) { A[2*i] = s1[i]; B[2*i] = s2[i]; }
    fft(A); fft(B);
    for (let i = 0; i < fftSize; i++) {
        const ar=A[2*i],ai=A[2*i+1],br=B[2*i],bi=B[2*i+1];
        A[2*i]=ar*br+ai*bi; A[2*i+1]=ai*br-ar*bi;
    }
    ifft(A);
    const maxLag = Math.min(Math.floor(SEARCH_SEC * SR), len - 1);
    let bestLag = 0, bestVal = -Infinity;
    for (let lag = 0; lag <= maxLag; lag++) {
        if (A[2*lag] > bestVal) { bestVal = A[2*lag]; bestLag = lag; }
    }
    for (let lag = 1; lag <= maxLag; lag++) {
        const idx = fftSize - lag;
        if (A[2*idx] > bestVal) { bestVal = A[2*idx]; bestLag = -lag; }
    }
    self.postMessage({ bestLag });
};`;
            const blob = new Blob([workerCode], { type: 'application/javascript' });
            const workerUrl = URL.createObjectURL(blob);
            const worker = new Worker(workerUrl);
            worker.postMessage({ s1, s2, SR, SEARCH_SEC }, [s1.buffer, s2.buffer]);
            worker.onmessage = e => {
                worker.terminate(); URL.revokeObjectURL(workerUrl);
                const offsetSec = -(e.data.bestLag / SR);
                onResult(parseFloat(offsetSec.toFixed(2)));
            };
            worker.onerror = err => {
                worker.terminate(); URL.revokeObjectURL(workerUrl);
                onError('计算出错：' + err.message);
            };
        }, SAMPLE_DUR * 1000 + 300);
    }


    // 3. UI 渲染 (V30.0)
    function renderUI(urls) {
        // === Kill 官方播放器：脚本只是悬浮覆盖，官方jydH5Player仍在底层运行会自动播放 ===
        // 1. 只静音+暂停，不清空src/load()——避免触发emptied事件导致官方播放器重新初始化抢占AudioContext
        document.querySelectorAll('video').forEach(v => {
            try {
                v.pause();
                v.muted = true;
                v.volume = 0;
            } catch(e) {}
        });
        // 2. 覆盖 jydH5Player 函数，阻止其被再次调用（如 getStreamUrlByRpId 的异步回调）
        try {
            if (typeof unsafeWindow !== 'undefined' && typeof unsafeWindow.jydH5Player === 'function') {
                unsafeWindow.jydH5Player = function() {
                    console.log('[HSP] jydH5Player call intercepted and blocked');
                };
            }
            if (typeof window.jydH5Player === 'function') {
                window.jydH5Player = function() {};
            }
        } catch(e) {}
        // 3. 定期巡逻：官方播放器可能在之后被自动触发，持续压制
        setInterval(() => {
            document.querySelectorAll('video').forEach(v => {
                if (v.id !== 'hsp-v1' && v.id !== 'hsp-v2') {
                    if (!v.paused) v.pause();
                    v.muted = true;
                    v.volume = 0;
                }
            });
        }, 3000);
        // === Kill 结束 ===

        const styleReset = document.createElement('style');
        styleReset.innerHTML = `html, body { overflow: hidden !important; width: 100%; height: 100%; margin: 0; }`;
        document.head.appendChild(styleReset);

        const root = document.createElement('div');
        root.id = 'hsp-root-v20';

        const css = `
            #hsp-root-v20 { position: fixed !important; inset: 0; background: #000; z-index: 2147483647; color: #eee; font-family: 'Segoe UI', system-ui, sans-serif; user-select: none; }
            #hsp-root-v20 * { box-sizing: border-box; }

            /* 鼠标空闲时隐藏光标 */
            #hsp-root-v20.ui-inactive { cursor: none !important; }

            /* 舞台 */
            #hsp-stage { position: absolute; inset: 0; display:flex; justify-content:center; align-items:center; z-index:1; overflow:hidden;}
            video.hsp-video {
                width: 100%; height: 100%; object-fit: contain; background: #000; outline: none;
                transition: transform 0.3s; transform-origin: center center;
            }
            video.hsp-video.stretch-mode { object-fit: fill !important; }
            video.hsp-video.crop-mode {
                object-fit: fill !important;
                transform: scaleX(1.34) !important;
            }

            /* 画中画 */
            #hsp-pip {
                position: absolute; bottom: 130px; right: 30px;
                width: 400px; height: 225px; min-width: 150px; min-height: 100px;
                background: #000; border: 1px solid rgba(255,255,255,0.15);
                border-radius: 8px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
                z-index: 100; overflow: hidden;
            }
            #hsp-pip:hover { border-color: #00a8ff; }
            #hsp-pip video { position:absolute; inset:0; width:100%; height:100%; object-fit:fill !important; pointer-events:none; }

            #hsp-loading {
                position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
                z-index: 500; pointer-events: none; display: none;
                flex-direction: column; align-items: center; gap: 8px;
            }
            .spinner {
                width: 40px; height: 40px; border: 4px solid rgba(255,255,255,0.3);
                border-top: 4px solid #00a8ff; border-radius: 50%;
                animation: spin 1s linear infinite;
            }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

            /* 信息浮层 - 配合 .ui-show 控制显隐 */
            #hsp-info {
                position: absolute; top: 20px; left: 20px; z-index: 50;
                pointer-events: none; opacity: 0; transition: opacity 0.5s;
                text-shadow: 0 2px 4px rgba(0,0,0,0.8);
            }
            #hsp-root-v20.ui-show #hsp-info { opacity: 1; }

            .info-title { font-size: 24px; font-weight: bold; color: #fff; margin-bottom: 4px; }
            .info-meta { font-size: 14px; color: #ccc; display: flex; gap: 15px; }
            .info-tag { background: rgba(0,168,255,0.2); color: #00a8ff; padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 12px; align-self: center;}

            /* Resizers - 去掉颜色，只保留功能和鼠标样式 */
            .resizer { position: absolute; z-index: 50; }
            .resizer.nw { top:0; left:0; width:15px; height:15px; cursor:nw-resize; }
            .resizer.ne { top:0; right:0; width:15px; height:15px; cursor:ne-resize; }
            .resizer.sw { bottom:0; left:0; width:15px; height:15px; cursor:sw-resize; }
            .resizer.se { bottom:0; right:0; width:15px; height:15px; cursor:se-resize; }
            .resizer.n { top:0; left:15px; right:15px; height:6px; cursor:ns-resize; }
            .resizer.s { bottom:0; left:15px; right:15px; height:6px; cursor:ns-resize; }
            .resizer.w { left:0; top:15px; bottom:15px; width:6px; cursor:ew-resize; }
            .resizer.e { right:0; top:15px; bottom:15px; width:6px; cursor:ew-resize; }

            .pip-move { position: absolute; inset: 20px; z-index: 20; cursor: move; }
            .pip-bar {
                position: absolute; top: 0; left: 0; right: 0; height: 32px;
                background: linear-gradient(to bottom, rgba(0,0,0,0.8), transparent);
                display: flex; justify-content: flex-start; align-items: center; padding: 0 8px;
                z-index: 30; opacity: 0; transition: opacity 0.2s;
            }
            #hsp-pip:hover .pip-bar { opacity: 1; }

            /* 控制栏 - 配合 .ui-show 控制显隐 */
            #hsp-controls {
                position: absolute; bottom: 20px; left: 20px; right: 20px; height: 88px;
                background: rgba(40, 40, 40, 0.55); backdrop-filter: blur(24px) saturate(180%);
                border: 1px solid rgba(255,255,255,0.15); border-radius: 16px;
                display: flex; align-items: center; padding: 0 24px; gap: 20px; z-index: 200;
                box-shadow: 0 8px 32px rgba(0,0,0,0.3);
                opacity: 0; transition: opacity 0.5s; /* 平滑淡入淡出 */
            }
            #hsp-root-v20.ui-show #hsp-controls { opacity: 1; }

            .h-btn { background: none; border: none; color: #ddd; cursor: pointer; height: 36px; display:flex; align-items:center; justify-content:center; border-radius: 6px; font-size: 14px; transition:0.2s; white-space:nowrap;}
            .h-btn:hover { background: rgba(255,255,255,0.15); color: #fff; }
            .h-btn-act { color: #00a8ff !important; text-shadow: 0 0 12px rgba(0, 168, 255, 0.6); font-weight: bold; }
            .h-btn-dim { opacity: 0.4; filter: grayscale(100%); }

            .prog-wrap { flex: 3; min-width: 80px; display: flex; flex-direction: column; justify-content: center; gap: 6px; position: relative; }
            .time-txt { font-size: 12px; color: #ccc; font-variant-numeric: tabular-nums; letter-spacing: 0.5px; }

            .prog-bar-container {
                position: relative; width: 100%; height: 6px;
                background: rgba(255,255,255,0.2); border-radius: 3px;
                cursor: pointer; overflow:hidden;
            }

            .prog-buffer {
                position: absolute; top:0; height:100%;
                background: #00ccff; opacity: 0.8; pointer-events: none; z-index: 1;
                transition: width 0.2s;
            }
            .prog-played {
                position: absolute; top:0; left:0; height:100%;
                background: rgba(255, 255, 255, 0.65); border-radius: 3px; width: 0%; pointer-events: none;
                z-index: 2; box-shadow: 1px 0 0 rgba(0,0,0,0.1);
            }

            input[type=range].prog-input {
                -webkit-appearance: none; position: absolute; top:-5px; left:0; width: 100%; height: 16px;
                background: transparent; cursor: pointer; margin:0; z-index: 10;
            }
            input[type=range].prog-input::-webkit-slider-runnable-track { height: 100%; background: transparent; }
            input[type=range].prog-input::-webkit-slider-thumb {
                -webkit-appearance: none; height: 14px; width: 14px; border-radius: 50%; background: #fff;
                margin-top: 1px; box-shadow: 0 1px 3px rgba(0,0,0,0.5); transform: scale(0); transition: transform 0.1s;
            }
            .prog-wrap:hover input[type=range].prog-input::-webkit-slider-thumb { transform: scale(1); }

            input[type=range]:not(.prog-input) { -webkit-appearance: none; width: 100%; background: transparent; cursor: pointer; height: 16px; }
            input[type=range]:not(.prog-input)::-webkit-slider-runnable-track { width: 100%; height: 4px; background: rgba(255,255,255,0.2); border-radius: 2px; }
            input[type=range]:not(.prog-input)::-webkit-slider-thumb { -webkit-appearance: none; height: 12px; width: 12px; border-radius: 50%; background: #fff; margin-top: -4px; box-shadow: 0 2px 4px #000; transition: transform 0.1s;}
            input[type=range]:not(.prog-input)::hover::-webkit-slider-thumb { transform: scale(1.3); background: #00a8ff; }

            .ctrl-grp { display: flex; flex-direction: column; gap: 2px; flex: 0.5; min-width: 40px; }
            .ctrl-header { display:flex; justify-content:space-between; align-items: center; font-size: 11px; color: #bbb; margin-bottom: 2px; }
            .ctrl-header > span:first-child { white-space: nowrap; flex-shrink: 0; }
            .ctrl-val { color: #00a8ff; font-weight: bold; flex-shrink: 0; }
            .sync-input { background: transparent; border: none; color: #00a8ff; width: 30px; text-align: right; font-weight:bold; font-size:11px; padding:0; margin:0; height: 14px; line-height:14px; flex-shrink: 0; }
            .sync-unit { margin-left: 1px; line-height:14px; font-size:11px; color:#aaa; flex-shrink: 0; }

            .overlay-panel { position: absolute; inset: 0; background: rgba(0,0,0,0.7); backdrop-filter: blur(8px); z-index: 900; display: none; align-items: center; justify-content: center; }
            .panel-card { background: #1e1e1e; width: 800px; padding: 25px; border-radius: 16px; border: 1px solid #444; max-height:85vh; overflow-y:auto; box-shadow: 0 20px 50px rgba(0,0,0,0.8); }
            .panel-title { font-size:18px; font-weight:bold; color:#fff; border-bottom:1px solid #333; padding-bottom:15px; margin-bottom:15px; display:flex; justify-content:space-between; }
            .help-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
            .help-item h4 { color: #00a8ff; margin-bottom: 8px; font-size: 15px; border-left: 3px solid #00a8ff; padding-left: 8px; }
            .help-item ul { list-style: none; font-size: 13px; color: #ccc; line-height: 1.8; padding:0; }
            .help-item li { border-bottom: 1px dashed #333; padding-bottom: 4px; margin-bottom: 4px; }
            .help-item li b { color:#fff; background:#333; padding:2px 6px; border-radius:4px; font-size:12px; margin-right:6px; }
            #hsp-toast { position: absolute; top: 100px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.8); padding: 8px 20px; border-radius: 20px; font-size: 14px; opacity: 0; pointer-events: none; transition: 0.3s; z-index: 500; }
        `;

        const styleTag = document.createElement('style');
        styleTag.textContent = css;

        root.innerHTML = `
            <div id="hsp-stage"></div>
            <div id="hsp-toast">提示</div>

            <div id="hsp-loading">
                <div class="spinner"></div>
            </div>

            <div id="hsp-info">
                <div class="info-title">${videoMeta.title}</div>
                <div class="info-meta">
                    <div><span class="info-tag">教师</span> ${videoMeta.teacher}</div>
                    <div><span class="info-tag">时间</span> ${videoMeta.date}</div>
                </div>
            </div>

            <div id="hsp-pip">
                <div class="pip-move"></div>
                <div class="resizer nw" data-dir="nw"></div><div class="resizer ne" data-dir="ne"></div>
                <div class="resizer sw" data-dir="sw"></div><div class="resizer se" data-dir="se"></div>
                <div class="resizer n" data-dir="n"></div><div class="resizer s" data-dir="s"></div>
                <div class="resizer w" data-dir="w"></div><div class="resizer e" data-dir="e"></div>

                <div class="pip-bar">
                    <button class="h-btn" id="btn-crop-sub" style="font-size:12px; padding:0 6px;" title="去黑边">✂ 4:3去黑边</button>
                </div>
            </div>

            <div id="hsp-help" class="overlay-panel">
                <div class="panel-card">
                    <div class="panel-title"><span>全功能操作手册</span><button class="h-btn btn-close-help">✕</button></div>
                    <div class="help-grid">
                        <div class="help-item">
                            <h4>🎬 画面控制</h4>
                            <ul>
                                <li><b>画中画显隐</b> 点击 👁️ 可隐藏副画面(声音保持播放)</li>
                                <li><b>画中画去黑边</b> 强制变窄为4:3比例，物理切除左右黑边</li>
                                <li><b>主画面拉伸</b> 支持 ↔ 强制拉伸铺满屏幕</li>
                                <li><b>视角交换</b> 点击 ⇋ 交换主副画面，音量设置保持</li>
                            </ul>
                        </div>
                        <div class="help-item">
                            <h4>🔊 音频增强</h4>
                            <ul>
                                <li><b>独立音量</b> 两个滑块分别绑定视频源1和源2</li>
                                <li><b>滚轮调音</b> 鼠标在主画面空白处滚动，快速调节主音量</li>
                                <li><b>人声增强</b> 默认开启 5dB，集成高频降噪与动态压缩</li>
                                <li><b>视角对齐</b> 0.0s 精度微调，解决主副画面不同步</li>
                                <li><b>🎯自动对齐</b> 点击后采集8秒音频，互相关算法自动计算偏移。使用前提：① 在老师持续讲话的片段；② 已手动将偏差缩小至5秒以内，再点击🎯精确对齐</li>
                            </ul>
                        </div>
                        <div class="help-item">
                            <h4>🖼️ 窗口布局</h4>
                            <ul>
                                <li><b>自由变形</b> 拖动PiP边缘可改变长宽比</li>
                                <li><b>等比缩放</b> 拖动PiP角落可等比缩放</li>
                                <li><b>位置移动</b> 拖动PiP中心区域可移动位置</li>
                            </ul>
                        </div>
                        <div class="help-item">
                            <h4>⌨️ 快捷键</h4>
                            <ul>
                                <li><b>空格键</b> 播放 / 暂停</li>
                                <li><b>方向键</b> 左/右快进退 5秒</li>
                                <li><b>全屏</b> 双击主画面或点击底栏 ⛶ 按钮</li>
                            </ul>
                        </div>
                    </div>
                    <div style="margin-top:20px; text-align:right; color:#555; font-size:12px;">Author: BCC</div>
                </div>
            </div>

            <div id="hsp-controls">
                <button id="btn-play" class="h-btn" style="font-size:28px; color:#00a8ff;">▶</button>

                <div class="prog-wrap">
                    <div class="time-txt"><span id="t-cur">00:00</span> / <span id="t-dur">--:--</span></div>
                    <div class="prog-bar-container" id="bar-container">
                        <div class="prog-played" id="bar-played"></div>
                        <input type="range" id="seek-bar" class="prog-input" value="0" step="0.1">
                    </div>
                </div>

                <div class="ctrl-grp" style="flex:0.8;">
                    <div class="ctrl-header">
                        <span>视角对齐</span>
                        <div style="display:flex;align-items:center;gap:3px;height:14px;">
                            <input id="sync-input" class="sync-input" value="0.0"><span class="sync-unit">s</span>
                            <button id="btn-auto-align" title="自动对齐：采集8秒音频波形互相关计算偏移" style="background:none;border:none;color:#00a8ff;cursor:pointer;font-size:11px;padding:0;line-height:14px;height:14px;flex-shrink:0;">🎯</button>
                        </div>
                    </div>
                    <input type="range" id="sync-slider" min="-60" max="60" step="0.1" value="0">
                </div>

                <div class="ctrl-grp">
                    <div class="ctrl-header"><span>人声增强</span><span id="txt-vocal" class="ctrl-val">5dB</span></div>
                    <input type="range" id="vocal-slider" min="0" max="30" step="1" value="5">
                </div>

                <div class="ctrl-grp">
                    <div class="ctrl-header"><span>音量 1</span><span id="txt-v1" class="ctrl-val">100%</span></div>
                    <input type="range" id="vol-1" max="5" step="0.1" value="1">
                </div>

                <div class="ctrl-grp">
                    <div class="ctrl-header"><span>音量 2</span><span id="txt-v2" class="ctrl-val">0%</span></div>
                    <input type="range" id="vol-2" max="5" step="0.1" value="0">
                </div>

                <div class="ctrl-grp">
                    <div class="ctrl-header"><span>倍速</span><span id="txt-rate" class="ctrl-val">1.0x</span></div>
                    <input type="range" id="rate-bar" min="0.5" max="3.5" step="0.1" value="1">
                </div>

                <button id="btn-toggle-pip" class="h-btn h-btn-act" title="画中画显隐" style="font-size:18px;">👁️</button>
                <button id="btn-swap" class="h-btn" title="交换画面" style="font-size:18px;">⇋</button>
                <button id="btn-stretch-main" class="h-btn" title="拉伸/原比" style="font-size:18px;">↔</button>
                <button id="btn-fs" class="h-btn" style="font-size:20px;">⛶</button>
                <button id="btn-help" class="h-btn" style="font-size:20px;">?</button>
            </div>
        `;

        document.body.appendChild(root);
        root.appendChild(styleTag);
        initKernel(urls);
    }

    // 4. 内核逻辑
    function initKernel(urls) {
        const v1 = document.createElement('video'); v1.className = 'hsp-video'; v1.id = 'hsp-v1'; v1.crossOrigin = "anonymous";
        const v2 = document.createElement('video'); v2.className = 'hsp-video'; v2.id = 'hsp-v2'; v2.crossOrigin = "anonymous";

        document.getElementById('hsp-stage').appendChild(v1);
        document.getElementById('hsp-pip').appendChild(v2);

        const hlsConfig = {
            maxBufferLength: 60,
            maxMaxBufferLength: 600,
            enableWorker: true,
            lowLatencyMode: true
        };
        const hls1 = new Hls(hlsConfig);
        const hls2 = new Hls(hlsConfig);

        // 只保留当前播放时间附近的片段，快进后自动使用新数据
        const load = (hls, v, url) => {
            if(Hls.isSupported()) { hls.loadSource(url); hls.attachMedia(v); }
            else { v.src = url; }
        };
        load(hls1, v1, urls[0]);
        if (urls.length > 1) { load(hls2, v2, urls[1]); v2.volume = 0; }
        else { document.getElementById('hsp-pip').style.display = 'none'; }

        const unlockAudio = () => {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') audioCtx.resume();
            setupAudioNode(v1, 'v1'); setupAudioNode(v2, 'v2');
            updateAudioState(v1, v2);
            document.removeEventListener('click', unlockAudio);
        };
        document.addEventListener('click', unlockAudio);

        bindEvents(v1, v2, hls1, hls2);
        initResizeLogic();
        initIdleBehavior(); // 启动闲置检测
    }

    // 合并缓冲段算法
    function mergeRanges(ranges) {
        if (!ranges || ranges.length === 0) return [];
        ranges.sort((a, b) => a[0] - b[0]);
        const result = [ranges[0]];
        for (let i = 1; i < ranges.length; i++) {
            const last = result[result.length - 1];
            const curr = ranges[i];
            if (curr[0] <= last[1] + 1.0) {
                last[1] = Math.max(last[1], curr[1]);
            } else {
                result.push(curr);
            }
        }
        return result;
    }

    // 5. 新增：UI自动隐藏行为
    function initIdleBehavior() {
        const root = document.getElementById('hsp-root-v20');
        const controls = document.getElementById('hsp-controls');
        let idleTimer;

        // 监听控制栏悬停状态，防止调节时消失
        controls.addEventListener('mouseenter', () => state.isControlHovered = true);
        controls.addEventListener('mouseleave', () => state.isControlHovered = false);

        const resetIdle = () => {
            // 显示UI
            root.classList.add('ui-show');
            root.classList.remove('ui-inactive');

            clearTimeout(idleTimer);

            idleTimer = setTimeout(() => {
                // 如果鼠标没有停留在控制栏上，则隐藏UI
                if (!state.isControlHovered) {
                    root.classList.remove('ui-show');
                    root.classList.add('ui-inactive'); // 触发隐藏光标
                }
            }, 2800); // 2.8秒后自动隐藏
        };

        // 鼠标移动或点击时重置计时
        root.addEventListener('mousemove', resetIdle);
        root.addEventListener('click', resetIdle);

        // 初始触发一次
        resetIdle();
    }

    function bindEvents(v1, v2, hls1, hls2) {
        let master = v1; let slave = v2;
        const loader = document.getElementById('hsp-loading');
        const showToast = (msg) => {
            const t = document.getElementById('hsp-toast');
            t.textContent = msg; t.style.opacity = 1;
            setTimeout(() => t.style.opacity = 0, 1500);
        };

        const applyVideoStyles = () => {
            const pip = document.getElementById('hsp-pip');
            const masterEl = state.isSwapped ? v2 : v1;
            const slaveEl = state.isSwapped ? v1 : v2;

            masterEl.style.transform = '';
            masterEl.classList.remove('crop-mode', 'stretch-mode');
            if (state.isStretchMain) {
                masterEl.classList.add('stretch-mode');
            }

            slaveEl.classList.remove('stretch-mode', 'crop-mode');
            slaveEl.style.transform = '';

            const isSlaveV1 = (slaveEl === v1);
            const shouldCrop = isSlaveV1 ? state.isCropV1 : state.isCropV2;

            if (shouldCrop) {
                const rect = pip.getBoundingClientRect();
                if (!pip.dataset.cropped) {
                    pip.style.width = (rect.height * 1.333) + 'px';
                    pip.dataset.cropped = "true";
                }
                slaveEl.classList.add('crop-mode');
            } else {
                slaveEl.classList.remove('crop-mode');
                delete pip.dataset.cropped;
            }

            document.getElementById('btn-stretch-main').classList.toggle('h-btn-act', state.isStretchMain);

            const btnCrop = document.getElementById('btn-crop-sub');
            if (shouldCrop) {
                btnCrop.classList.add('h-btn-act');
                btnCrop.textContent = "✂ 去黑边 ON";
            } else {
                btnCrop.classList.remove('h-btn-act');
                btnCrop.textContent = "✂ 4:3去黑边";
            }
        };

        document.getElementById('btn-swap').onclick = () => {
            state.isSwapped = !state.isSwapped;
            const stage = document.getElementById('hsp-stage');
            const pip = document.getElementById('hsp-pip');
            if (state.isSwapped) { stage.appendChild(v2); pip.appendChild(v1); master=v2; slave=v1; }
            else { stage.appendChild(v1); pip.appendChild(v2); master=v1; slave=v2; }
            applyVideoStyles();
            showToast("视角已交换");
        };

        document.getElementById('btn-toggle-pip').onclick = function() {
            state.isPipVisible = !state.isPipVisible;
            document.getElementById('hsp-pip').style.display = state.isPipVisible ? 'block' : 'none';
            if (state.isPipVisible) { this.classList.add('h-btn-act'); this.classList.remove('h-btn-dim'); }
            else { this.classList.remove('h-btn-act'); this.classList.add('h-btn-dim'); }
        };

        document.getElementById('btn-stretch-main').onclick = () => {
            state.isStretchMain = !state.isStretchMain;
            applyVideoStyles();
            showToast(state.isStretchMain?"主画面: 强制拉伸":"主画面: 保持比例");
        };

        document.getElementById('btn-crop-sub').onclick = () => {
            if (state.isSwapped) {
                state.isCropV1 = !state.isCropV1;
            } else {
                state.isCropV2 = !state.isCropV2;
            }
            applyVideoStyles();
        };

        const btnPlay = document.getElementById('btn-play');
        const checkBuffer = () => {
            const buffering = (master.readyState < 3 && !master.paused) || (slave.readyState < 3 && !slave.paused && state.isPipVisible);
            loader.style.display = buffering ? 'flex' : 'none';
            if (buffering) {
                if(master.readyState >= 3) master.pause();
                if(slave.readyState >= 3) slave.pause();
            } else {
                if (btnPlay.textContent === '❚❚') {
                    if (master.paused) master.play();
                    if (slave.paused) slave.play();
                }
            }
        };
        [v1, v2].forEach(v => {
            v.addEventListener('waiting', checkBuffer);
            v.addEventListener('canplay', checkBuffer);
            v.addEventListener('playing', checkBuffer);
        });

        const toggle = () => {
            if (master.paused) {
                master.play().catch(()=>{}); slave.play().catch(()=>{});
                btnPlay.textContent = '❚❚';
            } else {
                master.pause(); slave.pause();
                btnPlay.textContent = '▶';
            }
        };
        btnPlay.onclick = v1.onclick = v2.onclick = toggle;

        const seekBar = document.getElementById('seek-bar');
        const barContainer = document.getElementById('bar-container');
        const barPlayed = document.getElementById('bar-played');

        const updateBufferUI = () => {
            let d = master.duration; if(!Number.isFinite(d)) d=master.seekable.end(0) || 1;
            const currentBuffered = [];
            for(let i=0; i<master.buffered.length; i++) {
                currentBuffered.push([master.buffered.start(i), master.buffered.end(i)]);
            }
            state.bufferedHistory = state.bufferedHistory.concat(currentBuffered);
            state.bufferedHistory = mergeRanges(state.bufferedHistory);

            const oldBufs = barContainer.querySelectorAll('.prog-buffer');
            oldBufs.forEach(el => el.remove());

            state.bufferedHistory.forEach(range => {
                const start = range[0];
                const end = range[1];
                const startPct = (start / d) * 100;
                const widthPct = ((end - start) / d) * 100;
                if (widthPct > 0 && startPct < 100) {
                     const bufEl = document.createElement('div');
                     bufEl.className = 'prog-buffer';
                     bufEl.style.left = startPct + '%';
                     bufEl.style.width = Math.min(widthPct, 100-startPct) + '%';
                     barContainer.insertBefore(bufEl, barPlayed);
                }
            });
        };

        const updateTick = () => {
            let d = master.duration; if(!Number.isFinite(d)) d=master.seekable.end(0) || 1;
            const c = master.currentTime;

            const pct = (c/d)*100;
            if(Math.abs(seekBar.value-pct)>0.5) seekBar.value = pct;
            barPlayed.style.width = pct + '%';
            document.getElementById('t-cur').textContent=fmt(c); document.getElementById('t-dur').textContent=fmt(d);

            updateBufferUI();

            const tgt = c + state.syncOffset;
            if (Math.abs(slave.currentTime - tgt) > 0.5) {
                slave.currentTime = tgt;
            }
        };
        master.ontimeupdate = updateTick; slave.ontimeupdate = ()=>{if(state.isSwapped)updateTick()};
        master.addEventListener('progress', updateBufferUI);

        seekBar.oninput = e => {
            let d = master.duration; if(!Number.isFinite(d)) d=master.seekable.end(0);
            const t = (e.target.value/100)*(d||1);
            master.currentTime=t; slave.currentTime=t+state.syncOffset;
        };

        document.getElementById('vol-1').oninput = e => { state.vol1=e.target.value; document.getElementById('txt-v1').textContent=Math.round(e.target.value*100)+'%'; updateAudioState(v1,v2); };
        document.getElementById('vol-2').oninput = e => { state.vol2=e.target.value; document.getElementById('txt-v2').textContent=Math.round(e.target.value*100)+'%'; updateAudioState(v1,v2); };

        document.getElementById('hsp-stage').addEventListener('wheel', e => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -0.1 : 0.1;
            let v = parseFloat(state.vol1) + delta; if(v<0)v=0;if(v>5)v=5;
            state.vol1 = v.toFixed(1);
            document.getElementById('vol-1').value = state.vol1;
            document.getElementById('txt-v1').textContent=Math.round(state.vol1*100)+'%';
            updateAudioState(v1, v2);
            showToast(`音量1: ${Math.round(state.vol1*100)}%`);
        });

        document.getElementById('vocal-slider').oninput = e => {
            state.vocalGain=e.target.value;
            document.getElementById('txt-vocal').textContent = state.vocalGain > 0 ? `+${state.vocalGain}dB` : "OFF";
            updateAudioState(v1,v2);
        };

        const syncIn=document.getElementById('sync-input'), syncSl=document.getElementById('sync-slider');
        const setSync=v=>{state.syncOffset=parseFloat(v);syncIn.value=state.syncOffset.toFixed(1);syncSl.value=state.syncOffset;};
        syncIn.onchange=e=>setSync(e.target.value); syncSl.oninput=e=>setSync(e.target.value);

        // 自动对齐按钮
        const btnAutoAlign = document.getElementById('btn-auto-align');
        btnAutoAlign.onclick = () => {
            if (btnAutoAlign.disabled) return;
            btnAutoAlign.disabled = true;
            btnAutoAlign.style.opacity = '0.5';
            btnAutoAlign.title = '分析中…';
            showToast('🎯 采集音频中，请保持播放（约8秒）…');

            autoAlign(v1, v2,
                (delta) => {
                    // delta是在当前syncOffset基础上的修正量，叠加而非替换
                    const newOffset = parseFloat((state.syncOffset + delta).toFixed(2));
                    setSync(newOffset);
                    // 立即应用到slave
                    const tgt = master.currentTime + newOffset;
                    if (Math.abs(slave.currentTime - tgt) > 0.05) slave.currentTime = tgt;
                    showToast(`🎯 自动对齐完成：修正${delta >= 0 ? '+' : ''}${delta.toFixed(2)}s → 总偏移${newOffset >= 0 ? '+' : ''}${newOffset.toFixed(2)}s`);
                    btnAutoAlign.disabled = false;
                    btnAutoAlign.style.opacity = '1';
                    btnAutoAlign.title = '自动对齐：采集8秒音频波形互相关计算偏移';
                },
                (errMsg) => {
                    showToast('⚠️ ' + errMsg);
                    btnAutoAlign.disabled = false;
                    btnAutoAlign.style.opacity = '1';
                    btnAutoAlign.title = '自动对齐：采集8秒音频波形互相关计算偏移';
                }
            );
        };
        document.getElementById('rate-bar').oninput = e => { const r=parseFloat(e.target.value); master.playbackRate=slave.playbackRate=r; document.getElementById('txt-rate').textContent=r.toFixed(1)+'x'; };
        document.getElementById('btn-fs').onclick = () => { const r=document.getElementById('hsp-root-v20'); if(!document.fullscreenElement) r.requestFullscreen(); else document.exitFullscreen(); };
        document.getElementById('btn-help').onclick = () => document.getElementById('hsp-help').style.display = 'flex';
        document.querySelector('.btn-close-help').onclick = () => document.getElementById('hsp-help').style.display = 'none';

        document.addEventListener('keydown', e => {
            if (e.code === 'Space') { e.preventDefault(); toggle(); }
            if (e.code === 'ArrowRight') { master.currentTime += 5; showToast('快进 5s'); }
            if (e.code === 'ArrowLeft') { master.currentTime -= 5; showToast('后退 5s'); }
        });
        const fmt = s => { if(!Number.isFinite(s)||s<0)return "--:--"; return new Date(s*1000).toISOString().substr(11,8); };
    }

    function initResizeLogic() {
        const pip = document.getElementById('hsp-pip');
        const moveHandle = pip.querySelector('.pip-move');
        let startX, startY, startW, startH, startL, startT, ratio;

        let isMove = false;
        moveHandle.onmousedown = e => {
            if(e.target.classList.contains('resizer')) return;
            isMove = true;
            const r = pip.getBoundingClientRect();
            startL = r.left; startT = r.top; startX = e.clientX; startY = e.clientY;
            pip.style.right='auto'; pip.style.bottom='auto'; pip.style.left=startL+'px'; pip.style.top=startT+'px';
        };

        let isResize = false, currDir = '';
        pip.querySelectorAll('.resizer').forEach(r => {
            r.onmousedown = e => {
                e.stopPropagation(); isResize = true; currDir = e.target.dataset.dir;
                const rect = pip.getBoundingClientRect();
                startW = rect.width; startH = rect.height; startL = rect.left; startT = rect.top;
                startX = e.clientX; startY = e.clientY;
                ratio = startW / startH;
                pip.style.left=startL+'px'; pip.style.top=startT+'px'; pip.style.right='auto'; pip.style.bottom='auto';
            };
        });

        window.addEventListener('mousemove', e => {
            if (isMove) {
                pip.style.left = (startL + e.clientX - startX) + 'px';
                pip.style.top = (startT + e.clientY - startY) + 'px';
            }
            if (isResize) {
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                let newW = startW, newH = startH, newL = startL, newT = startT;

                if (currDir.includes('e')) newW = startW + dx;
                if (currDir.includes('w')) { newW = startW - dx; newL = startL + dx; }
                if (currDir.includes('s')) newH = startH + dy;
                if (currDir.includes('n')) { newH = startH - dy; newT = startT + dy; }

                if (['ne', 'se', 'sw', 'nw'].includes(currDir)) {
                    newH = newW / ratio;
                    if (currDir.includes('n')) newT = startT + (startH - newH);
                }

                if(newW > 100 && newH > 50) {
                    pip.style.width = newW + 'px'; pip.style.height = newH + 'px';
                    pip.style.left = newL + 'px'; pip.style.top = newT + 'px';
                }
            }
        });
        window.addEventListener('mouseup', () => { isMove = false; isResize = false; });

        pip.addEventListener('wheel', e => {
            e.preventDefault(); e.stopPropagation();
            const r = pip.getBoundingClientRect();
            const d = e.deltaY > 0 ? -50 : 50;
            let w = r.width + d; if(w<150)w=150;
            pip.style.width = w + 'px';
            pip.style.height = (w / (r.width/r.height)) + 'px';
        }, { passive: false });
    }

})();
