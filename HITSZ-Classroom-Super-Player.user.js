// ==UserScript==
// @name         HITSZ 课堂视频超级播放器
// @namespace    http://tampermonkey.net/
// @version      62.0
// @description  【仅支持 Violentmonkey 暴力猴，不支持 Tampermonkey 油猴】HITSZ 视频平台功能增强脚本。现代化UI，双流同屏，实时自动对齐，可调整大小比例，去黑边。支持两通道音量在0-500%独立调节，支持人声增强。
// @author       BCC
// @match        *://jxypt.hitsz.edu.cn/ve/back/rp/common/rpIndex.shtml?method=studyCourseDeatil*
// @match        *://jxypt-hitsz-edu-cn-s.hitsz.edu.cn/ve/back/rp/common/rpIndex.shtml?method=studyCourseDeatil*
// @require      https://cdn.jsdelivr.net/npm/hls.js@1.4.0/dist/hls.min.js
// @grant        unsafeWindow
// @license      MIT
// @updateURL    https://openuserjs.org/meta/BCC-HIT/HITSZ_%E8%AF%BE%E5%A0%82%E8%A7%86%E9%A2%91%E8%B6%85%E7%BA%A7%E6%92%AD%E6%94%BE%E5%99%A8.meta.js
// @downloadURL  https://openuserjs.org/install/BCC-HIT/HITSZ_%E8%AF%BE%E5%A0%82%E8%A7%86%E9%A2%91%E8%B6%85%E7%BA%A7%E6%92%AD%E6%94%BE%E5%99%A8.user.js
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const capturedUrls = new Set();
    const bootId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (typeof unsafeWindow !== 'undefined') unsafeWindow.__HSP_BOOT_ID__ = bootId;

    let isPlayerLaunched = false;
    let videoMeta = { title: '未知课程', teacher: '未知教师', date: '' };

    // 状态管理
    const state = {
        isSwapped: false,
        syncOffset: 0.0,
        realtimeAlign: false,
        alignStatus: '待机',
        lastAlign: null,
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
    const audioNodeFailed = { v1: false, v2: false };
    const audioCapture = {
        frame: 2048,
        maxSec: 150,
        chunks: { v1: [], v2: [] },
        samples: { v1: 0, v2: 0 },
        totalSamples: { v1: 0, v2: 0 },
        processors: { v1: null, v2: null },
        sink: null
    };
    const runtime = {
        timers: [],
        cleanups: [],
        current: null
    };
    const offlineAlignCache = {
        playlists: new Map(),
        segmentFrames: new Map()
    };
    try {
        if (typeof unsafeWindow !== 'undefined' && typeof unsafeWindow.__HSP_CLEANUP__ === 'function') {
            unsafeWindow.__HSP_CLEANUP__();
        }
    } catch(e) {}

    console.log("HSP V62.0 (Author: BCC): 引擎启动...");

    function isCurrentBoot() {
        return typeof unsafeWindow === 'undefined' || unsafeWindow.__HSP_BOOT_ID__ === bootId;
    }

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

    // 三路课堂录像会同时请求老师、课件和学生视角。不能依赖请求先后顺序：
    // 学生视角可能比课件更早返回，导致它被错误地放进小窗。
    function getStreamRole(url) {
        let text = String(url || '');
        try { text = decodeURIComponent(text); } catch (e) {}
        text = text.toLowerCase();
        if (/(?:老师|教师|teacher|lecturer|instructor|maincamera|teacherview)/i.test(text)) return 'teacher';
        if (/(?:课件|ppt|courseware|course-?ware|slide|document|screen|presentation)/i.test(text)) return 'courseware';
        if (/(?:学生|student|learner|studentview)/i.test(text)) return 'student';
        return 'unknown';
    }

    function selectPlaybackStreams(urls) {
        const streams = urls.filter(isValidStream);
        const teacher = streams.find(url => getStreamRole(url) === 'teacher');
        const courseware = streams.find(url => getStreamRole(url) === 'courseware');

        // 主画面为老师，小窗为课件；只有两者都识别到时才覆盖旧的顺序兼容逻辑。
        if (teacher && courseware) return [teacher, courseware];

        // 即使角色信息不完整，也绝不在有其它候选时优先选学生视角。
        const nonStudent = streams.filter(url => getStreamRole(url) !== 'student');
        return (nonStudent.length >= 2 ? nonStudent : streams).slice(0, 2);
    }

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
        if (!isCurrentBoot() || isPlayerLaunched || launchScheduled) return;
        launchScheduled = true; // 立刻锁住，后续XHR/fetch不再重置计时器
        launchTimer = setTimeout(() => {
            if (!isCurrentBoot()) return;
            // 三路时优先老师 + 课件，且课件作为小窗（第二路）来源。
            const validList = selectPlaybackStreams(Array.from(capturedUrls));
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

    try {
        const devStreams = (typeof unsafeWindow !== 'undefined' && Array.isArray(unsafeWindow.__HSP_DEV_STREAMS))
            ? unsafeWindow.__HSP_DEV_STREAMS
            : [];
        devStreams.forEach(url => {
            if (isValidStream(url)) capturedUrls.add(url);
        });
        if (typeof unsafeWindow !== 'undefined') {
            unsafeWindow.__HSP_DEV_ON_STREAM = (url) => {
                if (!isValidStream(url)) return;
                capturedUrls.add(url);
                tryLaunch();
            };
        }
        if (capturedUrls.size > 0) tryLaunch();
        console.log(`[HSP DevPayload] Pre-captured streams: ${capturedUrls.size}`);
    } catch(e) {
        console.warn('[HSP DevPayload] Failed to import pre-captured streams:', e);
    }

    // 2. 音频引擎
    function setupAudioNode(videoEl, id) {
        if (!videoEl || audioNodeFailed[id]) return nodes[id];
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
            audioNodeFailed[id] = false;
        } catch(e) {
            // Web Audio Graph 建立失败（如AudioContext被抢占），降级为直接用video.volume
            console.warn('[HSP] Web Audio fallback for', id, e);
            audioNodeFailed[id] = true;
            nodes[id] = null; // 保持null，updateAudioState会用video.volume兜底
        }
        return nodes[id];
    }

    function updateAudioState(v1, v2) {
        // Web Audio Graph路径
        if (audioCtx) {
            if (audioCtx.state === 'suspended') audioCtx.resume().catch(()=>{});
            if (nodes.v1) { v1.volume = 1; nodes.v1.gain.gain.value = state.vol1; }
            if (v2 && nodes.v2) { v2.volume = 1; nodes.v2.gain.gain.value = state.vol2; }
            [nodes.v1, nodes.v2].forEach(n => {
                if (!n) return;
                if (state.vocalGain > 0) {
                    n.highpass.frequency.value = 95;
                    n.lowpass.frequency.value = 14500;
                    n.peaking.frequency.value = 2400;
                    n.peaking.Q.value = 0.95;
                    n.peaking.gain.value = state.vocalGain;
                    n.highshelf.frequency.value = 5200;
                    n.highshelf.gain.value = Math.min(3.5, state.vocalGain * 0.12);
                } else {
                    n.highpass.frequency.value = 80;
                    n.peaking.gain.value = 0;
                    n.highshelf.gain.value = 0;
                    n.lowpass.frequency.value = 22000;
                }
            });
        }
        // Fallback：AudioContext未建立或Graph失败时，直接用video.volume（上限1.0）
        if (!audioCtx || !nodes.v1) { v1.volume = Math.min(1, state.vol1); }
        if (v2 && (!audioCtx || !nodes.v2)) { v2.volume = Math.min(1, state.vol2); }
    }

    function pushAudioChunk(id, chunk) {
        const copy = new Float32Array(chunk);
        const start = audioCapture.totalSamples[id];
        const end = start + copy.length;
        audioCapture.chunks[id].push({ data: copy, start, end, offset: Number(state.syncOffset) || 0 });
        audioCapture.totalSamples[id] = end;
        audioCapture.samples[id] += copy.length;
        const maxSamples = Math.ceil((audioCtx ? audioCtx.sampleRate : 44100) * audioCapture.maxSec);
        while (audioCapture.samples[id] > maxSamples && audioCapture.chunks[id].length > 1) {
            const old = audioCapture.chunks[id].shift();
            audioCapture.samples[id] -= old.data.length;
        }
    }

    function ensureAudioCapture() {
        if (!audioCtx || !nodes.v1 || !nodes.v2 || !nodes.v1.analyser || !nodes.v2.analyser) return false;
        if (!audioCapture.sink) {
            audioCapture.sink = audioCtx.createGain();
            audioCapture.sink.gain.value = 0;
            audioCapture.sink.connect(audioCtx.destination);
        }
        ['v1', 'v2'].forEach(id => {
            if (audioCapture.processors[id]) return;
            const proc = audioCtx.createScriptProcessor(audioCapture.frame, 1, 1);
            proc.onaudioprocess = e => pushAudioChunk(id, e.inputBuffer.getChannelData(0));
            nodes[id].analyser.connect(proc);
            proc.connect(audioCapture.sink);
            audioCapture.processors[id] = proc;
        });
        return true;
    }

    function availableAudioSamples(id, afterSample = null) {
        if (!Number.isFinite(afterSample)) return audioCapture.samples[id];
        let count = 0;
        audioCapture.chunks[id].forEach(chunk => {
            if (chunk.end <= afterSample) return;
            count += chunk.end - Math.max(chunk.start, afterSample);
        });
        return count;
    }

    function recentAudio(id, seconds, afterSample = null) {
        const sr = audioCtx ? audioCtx.sampleRate : 44100;
        const need = Math.ceil(seconds * sr);
        const available = availableAudioSamples(id, afterSample);
        if (available < need * 0.75) return null;
        const out = new Float32Array(Math.min(need, available));
        let offset = out.length;
        for (let i = audioCapture.chunks[id].length - 1; i >= 0 && offset > 0; i--) {
            const chunk = audioCapture.chunks[id][i];
            if (Number.isFinite(afterSample) && chunk.end <= afterSample) continue;
            const data = chunk.data;
            const startInChunk = Number.isFinite(afterSample) ? Math.max(0, afterSample - chunk.start) : 0;
            const usable = data.length - startInChunk;
            const take = Math.min(usable, offset);
            offset -= take;
            out.set(data.subarray(data.length - take), offset);
        }
        return offset === 0 ? out : out.subarray(offset);
    }

    function capturedAudioSeconds(id, afterSample = null) {
        const sr = audioCtx ? audioCtx.sampleRate : 44100;
        return availableAudioSamples(id, afterSample) / sr;
    }

    function copyAudioRange(id, start, end) {
        const len = Math.max(0, end - start);
        const out = new Float32Array(len);
        if (!len) return out;
        let written = 0;
        audioCapture.chunks[id].forEach(chunk => {
            if (chunk.end <= start || chunk.start >= end) return;
            const from = Math.max(start, chunk.start);
            const to = Math.min(end, chunk.end);
            if (to <= from) return;
            out.set(chunk.data.subarray(from - chunk.start, to - chunk.start), written);
            written += to - from;
        });
        return written === len ? out : out.subarray(0, written);
    }

    function projectedAudioSeconds(baseOffset) {
        const sr = audioCtx ? audioCtx.sampleRate : 44100;
        const v2Chunks = audioCapture.chunks.v2;
        if (!audioCapture.chunks.v1.length || !v2Chunks.length) return 0;
        const v2Min = v2Chunks[0].start;
        const v2Max = v2Chunks[v2Chunks.length - 1].end;
        let total = 0;
        audioCapture.chunks.v1.forEach(chunk => {
            const shift = Math.round((baseOffset - (chunk.offset || 0)) * sr);
            const start = Math.max(chunk.start, v2Min - shift);
            const end = Math.min(chunk.end, v2Max - shift);
            if (end > start) total += end - start;
        });
        return total / sr;
    }

    function projectedRecentAudioPair(seconds, baseOffset) {
        const sr = audioCtx ? audioCtx.sampleRate : 44100;
        const need = Math.ceil(seconds * sr);
        const v2Chunks = audioCapture.chunks.v2;
        if (!audioCapture.chunks.v1.length || !v2Chunks.length) return null;
        const v2Min = v2Chunks[0].start;
        const v2Max = v2Chunks[v2Chunks.length - 1].end;
        const parts1 = [];
        const parts2 = [];
        let total = 0;

        for (let i = audioCapture.chunks.v1.length - 1; i >= 0 && total < need; i--) {
            const chunk = audioCapture.chunks.v1[i];
            const shift = Math.round((baseOffset - (chunk.offset || 0)) * sr);
            let start = Math.max(chunk.start, v2Min - shift);
            let end = Math.min(chunk.end, v2Max - shift);
            if (end <= start) continue;
            const take = Math.min(end - start, need - total);
            start = end - take;
            const a = copyAudioRange('v1', start, end);
            const b = copyAudioRange('v2', start + shift, end + shift);
            const len = Math.min(a.length, b.length);
            if (len <= 0) continue;
            parts1.unshift(a.length === len ? a : a.subarray(a.length - len));
            parts2.unshift(b.length === len ? b : b.subarray(b.length - len));
            total += len;
        }

        if (total < need * 0.75) return null;
        const s1 = new Float32Array(total);
        const s2 = new Float32Array(total);
        let at = 0;
        for (let i = 0; i < parts1.length; i++) {
            s1.set(parts1[i], at);
            s2.set(parts2[i], at);
            at += parts1[i].length;
        }
        return { s1, s2, seconds: total / sr };
    }

    function captureTotals() {
        return { v1: audioCapture.totalSamples.v1, v2: audioCapture.totalSamples.v2 };
    }

    function clearAudioCapture(resetLastAlign = true) {
        audioCapture.chunks.v1 = [];
        audioCapture.chunks.v2 = [];
        audioCapture.samples.v1 = 0;
        audioCapture.samples.v2 = 0;
        audioCapture.totalSamples.v1 = 0;
        audioCapture.totalSamples.v2 = 0;
        if (resetLastAlign) state.lastAlign = null;
    }

    function validateAlignResult(detail, opts = {}) {
        const minConfidence = opts.minConfidence || 1.10;
        const minRms = opts.minRms || 0.001;
        const minPeak = opts.minPeak || 0.10;
        const maxAbsDelta = opts.maxAbsDelta || 4.8;
        if (!detail) return { ok: false, reason: '计算失败' };
        if (detail.rms1 < minRms || detail.rms2 < minRms) return { ok: false, reason: '声音太弱，等待老师持续讲话' };
        if (Math.abs(detail.delta) > maxAbsDelta) return { ok: false, reason: '已取当前±10s内最佳值；请确认是否先手动调近' };
        if (opts.silenceOnlyValidation) return { ok: true, reason: 'ok' };
        if (detail.confidence < minConfidence) return { ok: false, reason: `置信度不足 ${detail.confidence.toFixed(2)}` };
        if (detail.peak < minPeak) return { ok: false, reason: `互相关峰值过低 ${detail.peak.toFixed(2)}` };
        return { ok: true, reason: 'ok' };
    }

    function estimateAlignment(s1, s2, sr, searchSec) {
        return new Promise((resolve, reject) => {
            if (!s1 || !s2 || s1.length < sr || s2.length < sr) {
                reject(new Error('采集数据不足，请保持播放'));
                return;
            }
            const len = Math.min(s1.length, s2.length);
            let a = s1.length === len ? s1 : s1.subarray(s1.length - len);
            let b = s2.length === len ? s2 : s2.subarray(s2.length - len);
            let workSr = sr;

            if (searchSec > 30 && sr > 12000) {
                const factor = Math.max(2, Math.floor(sr / 12000));
                const outLen = Math.floor(len / factor);
                const da = new Float32Array(outLen);
                const db = new Float32Array(outLen);
                for (let i = 0; i < outLen; i++) {
                    let sa = 0, sb = 0;
                    const base = i * factor;
                    for (let j = 0; j < factor; j++) {
                        sa += a[base + j] || 0;
                        sb += b[base + j] || 0;
                    }
                    da[i] = sa / factor;
                    db[i] = sb / factor;
                }
                a = da;
                b = db;
                workSr = sr / factor;
            }

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
    const rms1 = Math.sqrt(sum1/len) || 0, rms2 = Math.sqrt(sum2/len) || 0;
    const r1 = rms1 || 1, r2 = rms2 || 1;
    let mean1 = 0, mean2 = 0;
    for (let i = 0; i < len; i++) { mean1 += s1[i]; mean2 += s2[i]; }
    mean1 /= len; mean2 /= len;
    for (let i = 0; i < len; i++) { s1[i] = (s1[i] - mean1) / r1; s2[i] = (s2[i] - mean2) / r2; }
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
    const guard = Math.max(1, Math.floor(0.25 * SR));
    let bestLag = 0, bestVal = -Infinity, secondVal = -Infinity;
    function visit(lag, val) {
        if (val > bestVal) {
            if (Math.abs(lag - bestLag) > guard) secondVal = bestVal;
            bestVal = val; bestLag = lag;
        } else if (Math.abs(lag - bestLag) > guard && val > secondVal) {
            secondVal = val;
        }
    }
    for (let lag = 0; lag <= maxLag; lag++) {
        visit(lag, A[2*lag]);
    }
    for (let lag = 1; lag <= maxLag; lag++) {
        const idx = fftSize - lag;
        visit(-lag, A[2*idx]);
    }
    const confidence = bestVal > 0 && secondVal > 0 ? bestVal / secondVal : (bestVal > 0 ? 99 : 0);
    self.postMessage({ bestLag, peak: bestVal / len, confidence, rms1, rms2 });
};`;
            const blob = new Blob([workerCode], { type: 'application/javascript' });
            const workerUrl = URL.createObjectURL(blob);
            const worker = new Worker(workerUrl);
            worker.postMessage({ s1: new Float32Array(a), s2: new Float32Array(b), SR: workSr, SEARCH_SEC: searchSec });
            worker.onmessage = e => {
                worker.terminate(); URL.revokeObjectURL(workerUrl);
                const offsetSec = -(e.data.bestLag / workSr);
                resolve({
                    delta: parseFloat(offsetSec.toFixed(3)),
                    confidence: e.data.confidence || 0,
                    peak: e.data.peak || 0,
                    rms1: e.data.rms1 || 0,
                    rms2: e.data.rms2 || 0,
                    lag: e.data.bestLag,
                    sampleRate: Math.round(workSr)
                });
            };
            worker.onerror = err => {
                worker.terminate(); URL.revokeObjectURL(workerUrl);
                reject(new Error('计算出错：' + err.message));
            };
        });
    }

    // 手动/实时共用的自动对齐入口。delta 是当前播放器间的残余误差；
    // targetOffset 是基于调用时 baseOffset 得出的绝对候选，避免重复点击时累加旧误差。
    function autoAlign(v1, v2, onResult, onError, opts = {}) {
        const sampleDur = opts.sampleDur || 8.0;
        const minSampleDur = opts.minSampleDur || Math.min(4, sampleDur);
        const searchSec = opts.searchSec || 5.0;
        const sr = audioCtx ? audioCtx.sampleRate : 44100;
        const baseOffset = Number.isFinite(opts.baseOffset) ? opts.baseOffset : state.syncOffset;
        const afterSamples = opts.afterSamples || null;
        const projectHistory = !!opts.projectHistory && !afterSamples;

        if (!audioCtx || !nodes.v1 || !nodes.v2 || !nodes.v1.analyser || !nodes.v2.analyser) {
            onError('音频引擎未就绪，请先点击页面触发音频解锁');
            return;
        }
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(()=>{});
        if (!ensureAudioCapture()) {
            onError('音频采集未就绪');
            return;
        }

        const run = () => {
            const available = Math.min(projectHistory
                ? projectedAudioSeconds(baseOffset)
                : Math.min(
                    capturedAudioSeconds('v1', afterSamples && afterSamples.v1),
                    capturedAudioSeconds('v2', afterSamples && afterSamples.v2)
                ),
                sampleDur);
            const effectiveSampleDur = Math.max(minSampleDur, Math.min(sampleDur, available));
            const projected = projectHistory ? projectedRecentAudioPair(effectiveSampleDur, baseOffset) : null;
            const s1 = projected ? projected.s1 : recentAudio('v1', effectiveSampleDur, afterSamples && afterSamples.v1);
            const s2 = projected ? projected.s2 : recentAudio('v2', effectiveSampleDur, afterSamples && afterSamples.v2);
            if (!s1 || !s2) {
                onError('采集数据不足，请保持播放');
                return;
            }
            const actualSearchSec = Math.max(0, Math.min(searchSec, effectiveSampleDur - 0.5));
            if (opts.minSearchSec && actualSearchSec < opts.minSearchSec) {
                onError(`采样还不够：当前可搜索 ±${actualSearchSec.toFixed(1)}s，请继续播放有声音片段`, {
                    sampleDur: effectiveSampleDur,
                    searchSec: actualSearchSec,
                    requestedSearchSec: searchSec
                });
                return;
            }
            estimateAlignment(s1, s2, sr, actualSearchSec)
                .then(detail => {
                    detail.sampleDur = effectiveSampleDur;
                    detail.searchSec = actualSearchSec;
                    detail.availableSec = projected ? projected.seconds : available;
                    detail.projectedHistory = projectHistory;
                    detail.baseOffset = baseOffset;
                    detail.targetOffset = parseFloat((baseOffset + detail.delta).toFixed(3));
                    const verdict = validateAlignResult(detail, opts);
                    detail.ok = verdict.ok;
                    detail.reason = verdict.reason;
                    state.lastAlign = detail;
                    if (!verdict.ok) {
                        onError(verdict.reason, detail);
                        return;
                    }
                    onResult(detail);
                })
                .catch(err => onError(err.message));
        };

        if ((projectHistory
            ? projectedAudioSeconds(baseOffset)
            : Math.min(
                capturedAudioSeconds('v1', afterSamples && afterSamples.v1),
                capturedAudioSeconds('v2', afterSamples && afterSamples.v2)
            )) >= minSampleDur) run();
        else setTimeout(run, Math.ceil(minSampleDur * 1000) + 250);
    }

    function parseM3u8(text, baseUrl) {
        const out = [];
        let pendingDuration = 0;
        text.split(/\r?\n/).forEach(raw => {
            const line = raw.trim();
            if (!line) return;
            if (line.startsWith('#EXTINF:')) {
                pendingDuration = parseFloat(line.slice(8)) || 0;
                return;
            }
            if (line.startsWith('#')) return;
            out.push({ url: new URL(line, baseUrl).href, duration: pendingDuration || 0 });
            pendingDuration = 0;
        });
        return out;
    }

    function readPts90k(data, off) {
        return (((data[off] & 0x0e) * 536870912) +
            ((data[off + 1] << 22) | ((data[off + 2] & 0xfe) << 14) | (data[off + 3] << 7) | ((data[off + 4] & 0xfe) >> 1))) / 90000;
    }

    function parsePat(payload) {
        const pointer = payload[0] || 0;
        let p = 1 + pointer;
        if (payload[p] !== 0x00) return null;
        const sectionLength = ((payload[p + 1] & 0x0f) << 8) | payload[p + 2];
        const end = p + 3 + sectionLength - 4;
        p += 8;
        while (p + 4 <= end) {
            const program = (payload[p] << 8) | payload[p + 1];
            const pid = ((payload[p + 2] & 0x1f) << 8) | payload[p + 3];
            if (program !== 0) return pid;
            p += 4;
        }
        return null;
    }

    function parsePmt(payload) {
        const pointer = payload[0] || 0;
        let p = 1 + pointer;
        if (payload[p] !== 0x02) return null;
        const sectionLength = ((payload[p + 1] & 0x0f) << 8) | payload[p + 2];
        const end = p + 3 + sectionLength - 4;
        const programInfoLength = ((payload[p + 10] & 0x0f) << 8) | payload[p + 11];
        p += 12 + programInfoLength;
        const streams = [];
        while (p + 5 <= end) {
            const streamType = payload[p];
            const pid = ((payload[p + 1] & 0x1f) << 8) | payload[p + 2];
            const infoLen = ((payload[p + 3] & 0x0f) << 8) | payload[p + 4];
            streams.push({ streamType, pid });
            p += 5 + infoLen;
        }
        return streams;
    }

    function collectAdtsFrames(chunks, pts, out) {
        const len = chunks.reduce((n, c) => n + c.length, 0);
        const data = new Uint8Array(len);
        let at = 0;
        chunks.forEach(c => { data.set(c, at); at += c.length; });
        let p = 0;
        let idx = 0;
        while (p + 7 < data.length) {
            if (data[p] !== 0xff || (data[p + 1] & 0xf0) !== 0xf0) {
                p++;
                continue;
            }
            const frameLen = ((data[p + 3] & 0x03) << 11) | (data[p + 4] << 3) | ((data[p + 5] & 0xe0) >> 5);
            if (frameLen < 7 || p + frameLen > data.length) {
                p++;
                continue;
            }
            out.push({ t: pts + idx * 1024 / 44100, size: frameLen });
            idx++;
            p += frameLen;
        }
    }

    function fingerprintTsSegments(buffers, segmentDuration = 10) {
        let pmtPid = null;
        let audioPid = null;
        let currentPts = null;
        let fallbackTime = 0;
        const frames = [];
        buffers.forEach(buffer => {
            const data = new Uint8Array(buffer);
            const pesByPid = new Map();
            for (let off = 0; off + 188 <= data.length; off += 188) {
                if (data[off] !== 0x47) continue;
                const payloadStart = !!(data[off + 1] & 0x40);
                const pid = ((data[off + 1] & 0x1f) << 8) | data[off + 2];
                const afc = (data[off + 3] >> 4) & 0x03;
                let p = off + 4;
                if (afc === 2 || afc === 0) continue;
                if (afc === 3) p += 1 + data[p];
                if (p >= off + 188) continue;
                const payload = data.subarray(p, off + 188);
                if (pid === 0 && payloadStart) {
                    const parsed = parsePat(payload);
                    if (parsed != null) pmtPid = parsed;
                    continue;
                }
                if (pmtPid != null && pid === pmtPid && payloadStart) {
                    const streams = parsePmt(payload);
                    const audio = streams && streams.find(s => s.streamType === 0x0f || s.streamType === 0x11 || s.streamType === 0x03 || s.streamType === 0x04);
                    if (audio) audioPid = audio.pid;
                    continue;
                }
                if (audioPid == null || pid !== audioPid) continue;
                if (payloadStart) {
                    const prev = pesByPid.get(pid);
                    if (prev) collectAdtsFrames(prev.bytes, prev.pts ?? fallbackTime, frames);
                    let pts = null;
                    let start = 0;
                    if (payload[0] === 0x00 && payload[1] === 0x00 && payload[2] === 0x01) {
                        const flags = payload[7] || 0;
                        const headerLen = payload[8] || 0;
                        if (flags & 0x80) pts = readPts90k(payload, 9);
                        start = 9 + headerLen;
                    }
                    currentPts = pts;
                    pesByPid.set(pid, { pts, bytes: [payload.subarray(start)] });
                } else {
                    const pes = pesByPid.get(pid);
                    if (pes) pes.bytes.push(payload);
                }
            }
            pesByPid.forEach(pes => collectAdtsFrames(pes.bytes, pes.pts ?? currentPts ?? fallbackTime, frames));
            fallbackTime += segmentDuration;
        });
        frames.sort((a, b) => a.t - b.t);
        return frames;
    }

    function normalizeVector(values) {
        let sum = 0, count = 0;
        for (const v of values) if (v) { sum += v; count++; }
        const mean = count ? sum / count : 0;
        let sq = 0;
        for (let i = 0; i < values.length; i++) {
            if (!values[i]) continue;
            values[i] -= mean;
            sq += values[i] * values[i];
        }
        const rms = Math.sqrt(sq / Math.max(1, count)) || 1;
        for (let i = 0; i < values.length; i++) if (values[i]) values[i] /= rms;
    }

    function correlateFingerprints(aFrames, bFrames, maxLagSec = 90) {
        const a0 = aFrames[0]?.t || 0;
        const b0 = bFrames[0]?.t || 0;
        const bin = 1024 / 44100;
        const a = aFrames.map(f => ({ t: f.t - a0, v: Math.log(Math.max(1, f.size)) }));
        const b = bFrames.map(f => ({ t: f.t - b0, v: Math.log(Math.max(1, f.size)) }));
        const n = Math.ceil(Math.max(a.at(-1)?.t || 0, b.at(-1)?.t || 0) / bin) + 2;
        const av = new Float64Array(n);
        const bv = new Float64Array(n);
        a.forEach(f => { av[Math.round(f.t / bin)] = f.v; });
        b.forEach(f => { bv[Math.round(f.t / bin)] = f.v; });
        normalizeVector(av);
        normalizeVector(bv);
        const maxLag = Math.round(maxLagSec / bin);
        const guard = Math.round(2 / bin);
        let best = { lag: 0, score: -Infinity };
        let second = -Infinity;
        for (let lag = -maxLag; lag <= maxLag; lag++) {
            let s = 0, count = 0;
            for (let i = 0; i < n; i++) {
                const j = i + lag;
                if (j < 0 || j >= n) continue;
                s += av[i] * bv[j];
                count++;
            }
            const score = count ? s / count : -Infinity;
            if (score > best.score) {
                if (Math.abs(lag - best.lag) > guard) second = best.score;
                best = { lag, score };
            } else if (Math.abs(lag - best.lag) > guard && score > second) {
                second = score;
            }
        }
        const confidence = best.score > 0 && second > 0 ? best.score / second : 0;
        return { delta: parseFloat((best.lag * bin).toFixed(3)), score: best.score, confidence, second };
    }

    async function fetchOfflineFingerprint(playlistUrl, startSec, windowSec) {
        let segments = offlineAlignCache.playlists.get(playlistUrl);
        if (!segments) {
            const playlistText = await fetch(playlistUrl, { cache: 'force-cache' }).then(r => {
                if (!r.ok) throw new Error(`playlist HTTP ${r.status}`);
                return r.text();
            });
            segments = parseM3u8(playlistText, playlistUrl);
            offlineAlignCache.playlists.set(playlistUrl, segments);
        }
        let t = 0;
        const selected = [];
        for (const seg of segments) {
            const segStart = t;
            const segEnd = t + seg.duration;
            if (segEnd >= startSec && segStart <= startSec + windowSec) selected.push(seg);
            t = segEnd;
        }
        if (selected.length < 4) throw new Error('可用 HLS 分片太少');
        const frameGroups = await Promise.all(selected.map(async seg => {
            const cached = offlineAlignCache.segmentFrames.get(seg.url);
            if (cached) return cached;
            const buffer = await fetch(seg.url, { cache: 'force-cache' }).then(r => {
                if (!r.ok) throw new Error(`segment HTTP ${r.status}`);
                return r.arrayBuffer();
            });
            const parsed = fingerprintTsSegments([buffer], seg.duration || 10);
            offlineAlignCache.segmentFrames.set(seg.url, parsed);
            return parsed;
        }));
        const frames = frameGroups.flat().sort((a, b) => a.t - b.t);
        if (frames.length < 1000) throw new Error('AAC 指纹太短');
        return { frames, selected: selected.length };
    }

    async function offlineFingerprintAlign(urls, currentTime, opts = {}) {
        if (!urls || urls.length < 2) throw new Error('缺少双路 HLS 地址');
        const windowSec = opts.windowSec || 120;
        const searchSec = opts.searchSec || 90;
        const maxApplyOffset = opts.maxApplyOffset == null ? 5 : opts.maxApplyOffset;
        const starts = [
            Math.max(0, currentTime - 60),
            Math.max(0, currentTime + 120),
            Math.max(0, currentTime + 300)
        ];
        const candidates = [];
        for (let i = 0; i < starts.length; i++) {
            const start = starts[i];
            const [a, b] = await Promise.all([
                fetchOfflineFingerprint(urls[0], start, windowSec),
                fetchOfflineFingerprint(urls[1], start, windowSec)
            ]);
            const corr = correlateFingerprints(a.frames, b.frames, searchSec);
            candidates.push({
                start,
                delta: corr.delta,
                offset: parseFloat((-corr.delta).toFixed(2)),
                score: corr.score,
                confidence: corr.confidence,
                frames1: a.frames.length,
                frames2: b.frames.length,
                segments1: a.selected,
                segments2: b.selected
            });
        }
        const good = candidates.filter(c => c.score > 0.42 && c.confidence > 1.06);
        if (!good.length) {
            const best = candidates.sort((a, b) => b.score - a.score)[0];
            const suffix = best ? ` best ${best.offset >= 0 ? '+' : ''}${best.offset.toFixed(2)}s score ${best.score.toFixed(2)} conf ${best.confidence.toFixed(2)}` : '';
            throw new Error('离线指纹置信度不足' + suffix);
        }
        const offsets = good.map(c => c.offset);
        const minOffset = Math.min(...offsets);
        const maxOffset = Math.max(...offsets);
        if (maxOffset - minOffset > 0.75) {
            throw new Error(`离线指纹不稳定 ${minOffset.toFixed(2)}s ~ ${maxOffset.toFixed(2)}s`);
        }
        const offset = parseFloat((good.reduce((sum, c) => sum + c.offset, 0) / good.length).toFixed(2));
        if (Number.isFinite(maxApplyOffset) && Math.abs(offset) > maxApplyOffset) {
            const best = good.sort((a, b) => b.score - a.score)[0];
            throw new Error(`音频候选 ${offset >= 0 ? '+' : ''}${offset.toFixed(2)}s 过大，可能是音轨相对视频错位，未自动应用；best score ${best.score.toFixed(2)} conf ${best.confidence.toFixed(2)}`);
        }
        return {
            delta: parseFloat((offset - state.syncOffset).toFixed(3)),
            offset,
            confidence: Math.min(...good.map(c => c.confidence)),
            peak: Math.max(...good.map(c => c.score)),
            rms1: 1,
            rms2: 1,
            method: 'aac-fingerprint',
            candidates
        };
    }

    function visualSimilarity(v1, v2) {
        if (!v1 || !v2 || !v1.videoWidth || !v2.videoWidth) throw new Error('视频画面未就绪');
        const w = 96;
        const h = 54;
        const canvas = document.createElement('canvas');
        canvas.width = w * 2;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('Canvas 不可用');

        // 老师视角里投影幕通常在右上区域；取稍大的区域，避免只截到边框。
        const sx = Math.round(v1.videoWidth * 0.46);
        const sy = Math.round(v1.videoHeight * 0.03);
        const sw = Math.round(v1.videoWidth * 0.43);
        const sh = Math.round(v1.videoHeight * 0.55);
        ctx.drawImage(v1, sx, sy, sw, sh, 0, 0, w, h);
        ctx.drawImage(v2, 0, 0, v2.videoWidth, v2.videoHeight, w, 0, w, h);
        const a = ctx.getImageData(0, 0, w, h).data;
        const b = ctx.getImageData(w, 0, w, h).data;
        let mse = 0;
        let edgeA = 0;
        let edgeB = 0;
        let edgeErr = 0;
        const grayA = new Float32Array(w * h);
        const grayB = new Float32Array(w * h);
        for (let i = 0, p = 0; i < grayA.length; i++, p += 4) {
            grayA[i] = (a[p] * 0.299 + a[p + 1] * 0.587 + a[p + 2] * 0.114) / 255;
            grayB[i] = (b[p] * 0.299 + b[p + 1] * 0.587 + b[p + 2] * 0.114) / 255;
            const d = grayA[i] - grayB[i];
            mse += d * d;
        }
        mse /= grayA.length;
        for (let y = 1; y < h; y++) {
            for (let x = 1; x < w; x++) {
                const i = y * w + x;
                const ea = Math.abs(grayA[i] - grayA[i - 1]) + Math.abs(grayA[i] - grayA[i - w]);
                const eb = Math.abs(grayB[i] - grayB[i - 1]) + Math.abs(grayB[i] - grayB[i - w]);
                edgeA += ea;
                edgeB += eb;
                edgeErr += Math.abs(ea - eb);
            }
        }
        const lumaScore = 1 / (1 + mse * 12);
        const edgeScore = 1 / (1 + edgeErr / Math.max(1, Math.min(edgeA, edgeB)));
        return parseFloat((lumaScore * 0.35 + edgeScore * 0.65).toFixed(6));
    }


    // 3. UI 渲染 (V30.0)
    function renderUI(urls) {
        const oldRoot = document.getElementById('hsp-root-v20');
        if (oldRoot) oldRoot.remove();
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
                transition: none; transform-origin: center center;
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

            .ctrl-grp { display: flex; flex-direction: column; gap: 2px; flex: 0.5; min-width: 40px; position: relative; }
            .ctrl-header { display:flex; justify-content:space-between; align-items: center; font-size: 11px; color: #bbb; margin-bottom: 2px; }
            .ctrl-header > span:first-child { white-space: nowrap; flex-shrink: 0; }
            .ctrl-val { color: #00a8ff; font-weight: bold; flex-shrink: 0; }
            .sync-input { background: transparent; border: none; color: #00a8ff; width: 44px; text-align: right; font-weight:bold; font-size:11px; padding:0; margin:0; height: 14px; line-height:14px; flex-shrink: 0; font-variant-numeric: tabular-nums; }
            .sync-unit { margin-left: 1px; line-height:14px; font-size:11px; color:#aaa; flex-shrink: 0; }
            .sync-actions { display:flex; align-items:center; gap:5px; height:16px; flex-shrink:0; }
            .sync-mini-btn { background:none; border:none; color:#bbb; cursor:pointer; font-size:11px; padding:0 2px; line-height:14px; height:16px; border-radius:4px; flex-shrink:0; }
            .sync-mini-btn:hover { background: rgba(255,255,255,0.12); }
            .sync-mini-btn.active { color:#6cffb5; font-weight:bold; }
            .align-status { position:absolute; left:0; right:0; top:33px; color:#aaa; font-size:10px; line-height:12px; min-height:12px; max-height:24px; overflow:hidden; white-space:normal; overflow-wrap:anywhere; opacity:0; pointer-events:none; }
            .align-status.show { opacity:0.78; }
            #hsp-toast.toast-ok { color:#c8ffd8; border:1px solid rgba(108,255,181,0.35); }
            #hsp-toast.toast-warn { color:#ffe7a5; border:1px solid rgba(255,210,90,0.35); }
            #hsp-toast.toast-err { color:#ffb8b8; border:1px solid rgba(255,100,100,0.35); }

            .overlay-panel { position: absolute; inset: 0; background: rgba(0,0,0,0.7); backdrop-filter: blur(8px); z-index: 900; display: none; align-items: center; justify-content: center; }
            .panel-card { background: #1e1e1e; width: 800px; padding: 25px; border-radius: 16px; border: 1px solid #444; max-height:85vh; overflow-y:auto; box-shadow: 0 20px 50px rgba(0,0,0,0.8); }
            .panel-title { font-size:18px; font-weight:bold; color:#fff; border-bottom:1px solid #333; padding-bottom:15px; margin-bottom:15px; display:flex; justify-content:space-between; }
            .help-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
            .help-item h4 { color: #00a8ff; margin-bottom: 8px; font-size: 15px; border-left: 3px solid #00a8ff; padding-left: 8px; }
            .help-item ul { list-style: none; font-size: 13px; color: #ccc; line-height: 1.8; padding:0; }
            .help-item li { border-bottom: 1px dashed #333; padding-bottom: 4px; margin-bottom: 4px; }
            .help-item li b { color:#fff; background:#333; padding:2px 6px; border-radius:4px; font-size:12px; margin-right:6px; }
            #hsp-toast { position: absolute; top: 92px; left: 50%; transform: translateX(-50%); max-width: min(620px, calc(100vw - 32px)); background: rgba(18,18,20,0.72); border: 1px solid rgba(255,255,255,0.14); box-shadow: 0 8px 28px rgba(0,0,0,0.22); backdrop-filter: blur(18px) saturate(1.25); -webkit-backdrop-filter: blur(18px) saturate(1.25); padding: 9px 18px; border-radius: 18px; font-size: 14px; line-height: 18px; text-align:center; white-space:normal; overflow-wrap:anywhere; opacity: 0; pointer-events: none; transition: opacity 0.18s; z-index: 800; }
        `;

        const styleTag = document.createElement('style');
        styleTag.textContent = css;

        root.innerHTML = `
            <div id="hsp-stage"></div>
            <div id="hsp-toast">提示</div>
            <div id="hsp-debug-state" style="display:none;"></div>

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
                                <li><b>人声增强</b> 默认开启 5dB，提升语音清晰度并保留动态压缩</li>
                                <li><b>视角对齐</b> 先手动调到偏差约±10秒内，再用校准精修</li>
                                <li><b>校准</b> 必须在有声片段使用，只在当前设置±10秒内取最佳值</li>
                                <li><b>AUTO</b> 后台做同样的±10秒局部检测，结果稳定才小步修正</li>
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
                        <div class="sync-actions">
                            <input id="sync-input" class="sync-input" value="0.00"><span class="sync-unit">s</span>
                            <button id="btn-auto-align" class="sync-mini-btn" title="校准：只在当前对齐设置的 ±10 秒内精修">校准</button>
                            <button id="btn-live-align" class="sync-mini-btn" title="自动校准：播放时周期检测并修正偏移">AUTO</button>
                        </div>
                    </div>
                    <input type="range" id="sync-slider" min="-120" max="120" step="0.1" value="0">
                    <div id="align-status" class="align-status"></div>
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
        const hasDual = urls.length > 1;
        const v1 = document.createElement('video'); v1.className = 'hsp-video'; v1.id = 'hsp-v1'; v1.crossOrigin = "anonymous";
        const v2 = document.createElement('video'); v2.className = 'hsp-video'; v2.id = 'hsp-v2'; v2.crossOrigin = "anonymous";

        document.getElementById('hsp-stage').appendChild(v1);
        document.getElementById('hsp-pip').appendChild(v2);

        const hlsConfig = {
            maxBufferLength: 120,
            maxMaxBufferLength: 900,
            backBufferLength: 120,
            enableWorker: true,
            lowLatencyMode: false,
            fragLoadingTimeOut: 30000,
            fragLoadingMaxRetry: 8,
            fragLoadingRetryDelay: 1000,
            manifestLoadingTimeOut: 30000,
            manifestLoadingMaxRetry: 6,
            manifestLoadingRetryDelay: 1000
        };
        const hls1 = new Hls(hlsConfig);
        const hls2 = hasDual ? new Hls(hlsConfig) : null;

        // 只保留当前播放时间附近的片段，快进后自动使用新数据
        const load = (hls, v, url) => {
            if(Hls.isSupported()) {
                hls.loadSource(url);
                hls.attachMedia(v);
                hls.on(Hls.Events.ERROR, (_, data) => {
                    if (!data || !data.fatal) return;
                    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                        hls.startLoad();
                    } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                        hls.recoverMediaError();
                    } else {
                        console.warn('[HSP] Fatal HLS error, unable to recover', data);
                    }
                });
            }
            else { v.src = url; }
        };
        load(hls1, v1, urls[0]);
        if (hasDual) { load(hls2, v2, urls[1]); v2.volume = 0; }
        else {
            state.isPipVisible = false;
            document.getElementById('hsp-pip').style.display = 'none';
        }

        const unlockAudio = () => {
            try {
                if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                if (audioCtx.state === 'suspended') audioCtx.resume().catch(()=>{});
                setupAudioNode(v1, 'v1');
                if (hasDual) setupAudioNode(v2, 'v2');
                if (hasDual) ensureAudioCapture();
                updateAudioState(v1, hasDual ? v2 : null);
            } catch(e) {
                console.warn('[HSP] Audio unlock failed, native volume fallback active', e);
            }
            document.removeEventListener('click', unlockAudio);
        };
        const resumeAudio = () => {
            try {
                if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(()=>{});
                updateAudioState(v1, hasDual ? v2 : null);
            } catch(e) {}
        };
        document.addEventListener('click', unlockAudio);
        document.addEventListener('visibilitychange', resumeAudio);
        [v1, v2].forEach(v => v.addEventListener('play', resumeAudio));

        bindEvents(v1, v2, hls1, hls2, hasDual, urls);
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

    function bindEvents(v1, v2, hls1, hls2, hasDual, urls) {
        let master = v1; let slave = hasDual ? v2 : null;
        const loader = document.getElementById('hsp-loading');
        let syncHoldUntil = 0;
        let lastBufferUiAt = 0;
        let liveAlignBusy = false;
        let liveAlignStable = [];
        let alignStatusHideTimer = null;
        let lastCalibrationAt = 0;
        let lastCalibrationSamples = null;
        let lastCalibrationTarget = null;
        let lastMasterTime = null;
        let lastMasterStamp = 0;
        let toastHideTimer = null;
        let toastProtectUntil = 0;
        const showToast = (msg, type = '', duration = 1500, options = {}) => {
            const now = Date.now();
            if (!options.force && !options.protect && now < toastProtectUntil) return;
            const t = document.getElementById('hsp-toast');
            t.classList.remove('toast-ok', 'toast-warn', 'toast-err');
            if (type) t.classList.add(`toast-${type}`);
            t.textContent = msg; t.style.opacity = 1;
            if (options.protect) toastProtectUntil = now + duration;
            clearTimeout(toastHideTimer);
            toastHideTimer = setTimeout(() => t.style.opacity = 0, duration);
        };
        const writeDebugState = () => {
            const el = document.getElementById('hsp-debug-state');
            if (!el) return;
            el.textContent = JSON.stringify({
                version: '62.0',
                syncOffset: state.syncOffset,
                realtimeAlign: state.realtimeAlign,
                alignStatus: state.alignStatus,
                lastAlign: state.lastAlign,
                masterId: master && master.id,
                slaveId: slave && slave.id,
                streams: urls
            });
        };
        const setAlignStatus = (msg, type = '') => {
            state.alignStatus = msg;
            const el = document.getElementById('align-status');
            if (el) {
                el.textContent = msg;
                el.style.color = type === 'err' ? '#ffb8b8' : '#aaa';
                const visible = state.realtimeAlign || type === 'warn' || type === 'err' || type === 'ok';
                el.classList.toggle('show', !!msg && visible);
                clearTimeout(alignStatusHideTimer);
                if (!state.realtimeAlign && (type === 'ok' || type === 'warn')) {
                    alignStatusHideTimer = setTimeout(() => el.classList.remove('show'), 3500);
                }
            }
            if (runtime.current) runtime.current.alignStatus = msg;
            writeDebugState();
        };

        const safePlay = (v) => v ? v.play().catch(()=>{}) : Promise.resolve();
        const safeDuration = (v) => {
            if (!v) return 1;
            if (Number.isFinite(v.duration) && v.duration > 0) return v.duration;
            try {
                if (v.seekable && v.seekable.length > 0) {
                    const end = v.seekable.end(v.seekable.length - 1);
                    if (Number.isFinite(end) && end > 0) return end;
                }
            } catch(e) {}
            return 1;
        };
        const pairOffset = () => (hasDual && state.isSwapped) ? -state.syncOffset : state.syncOffset;
        const clampMediaTime = (v, time) => {
            if (!Number.isFinite(time)) return 0;
            const d = safeDuration(v);
            return Math.max(0, Math.min(time, d > 1 ? d - 0.05 : time));
        };
        const applyBaseRate = () => {
            master.playbackRate = state.rate;
            if (slave) slave.playbackRate = state.rate;
        };
        const writeSync = (value, immediate = true) => {
            const parsed = parseFloat(value);
            state.syncOffset = Number.isFinite(parsed) ? parsed : 0;
            const syncIn = document.getElementById('sync-input');
            const syncSl = document.getElementById('sync-slider');
            if (syncIn) syncIn.value = state.syncOffset.toFixed(2);
            if (syncSl) syncSl.value = state.syncOffset;
            if (immediate) syncSlaveNow(0.05);
            writeDebugState();
        };
        const syncSlaveNow = (threshold = 0.25) => {
            if (!hasDual || !slave || !Number.isFinite(master.currentTime)) return;
            const target = clampMediaTime(slave, master.currentTime + pairOffset());
            const drift = slave.currentTime - target;

            if (Math.abs(drift) > threshold) {
                syncHoldUntil = Date.now() + 500;
                slave.currentTime = target;
                slave.playbackRate = state.rate;
                return;
            }

            if (!master.paused && !slave.paused && Math.abs(drift) > 0.06 && Date.now() > syncHoldUntil) {
                const correction = Math.max(-0.08, Math.min(0.08, -drift * 0.18));
                slave.playbackRate = Math.max(0.25, Math.min(4, state.rate + correction));
            } else if (slave.playbackRate !== state.rate) {
                slave.playbackRate = state.rate;
            }
        };
        const seekBoth = (time) => {
            const t = clampMediaTime(master, time);
            clearAudioCapture();
            liveAlignStable = [];
            lastCalibrationAt = 0;
            lastCalibrationSamples = null;
            lastCalibrationTarget = null;
            lastMasterTime = null;
            syncHoldUntil = Date.now() + 1200;
            master.currentTime = t;
            if (slave) slave.currentTime = clampMediaTime(slave, t + pairOffset());
            setAlignStatus(state.realtimeAlign ? '实时对齐等待新音频' : '已跳转，等待新音频');
        };
        const applyAlignDelta = (detail, source) => {
            const baseOffset = Number.isFinite(detail.baseOffset) ? detail.baseOffset : state.syncOffset;
            const targetOffset = Number.isFinite(detail.targetOffset) ? detail.targetOffset : baseOffset + detail.delta;
            const newOffset = parseFloat(targetOffset.toFixed(2));
            writeSync(newOffset);
            const msg = `${source}: ${newOffset >= 0 ? '+' : ''}${newOffset.toFixed(2)}s`;
            setAlignStatus(msg, 'ok');
            return newOffset;
        };
        const maybeLiveAlign = () => {
            if (!state.realtimeAlign || liveAlignBusy || !hasDual || !slave || master.paused || slave.paused) return;
            if (Date.now() - lastCalibrationAt < 15000) {
                setAlignStatus('AUTO 暂停片刻，保留刚才校准', '');
                return;
            }
            if (master.readyState < 3 || slave.readyState < 3) {
                setAlignStatus('实时对齐等待缓冲', 'warn');
                return;
            }
            liveAlignBusy = true;
            autoAlign(v1, v2,
                detail => {
                    liveAlignBusy = false;
                    liveAlignStable.push(detail);
                    if (liveAlignStable.length > 2) liveAlignStable.shift();
                    if (Math.abs(detail.delta) < 0.06) {
                        setAlignStatus('AUTO 已稳定', '');
                        return;
                    }
                    const stable = liveAlignStable.length >= 2 && liveAlignStable.every(d => Math.abs(d.delta - detail.delta) < 0.35);
                    if (!stable) {
                        setAlignStatus(`AUTO 观察 ${detail.delta >= 0 ? '+' : ''}${detail.delta.toFixed(2)}s`, '');
                        return;
                    }
                    const limitedDelta = Math.max(-1.2, Math.min(1.2, detail.delta));
                    const limited = Object.assign({}, detail, {
                        delta: limitedDelta,
                        targetOffset: parseFloat(((Number.isFinite(detail.baseOffset) ? detail.baseOffset : state.syncOffset) + limitedDelta).toFixed(3))
                    });
                    const newOffset = applyAlignDelta(limited, '实时对齐');
                    showToast(`AUTO ${newOffset >= 0 ? '+' : ''}${newOffset.toFixed(2)}s`, 'ok');
                },
                (errMsg, detail) => {
                    liveAlignBusy = false;
                    liveAlignStable = [];
                    setAlignStatus(/声音太弱|采集数据不足/.test(errMsg) ? 'AUTO 等待有声片段' : `AUTO ${errMsg}`, 'warn');
                },
                { sampleDur: 30, minSampleDur: 5.5, searchSec: 10, minRms: 0.001, minConfidence: 1.04, minPeak: 0.015, maxAbsDelta: 9.8, projectHistory: true }
            );
        };
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const shouldTryWideAlign = (errMsg, detail) => {
            const msg = String(errMsg || '');
            if (/声音太弱|采集数据不足|音频引擎未就绪|音频采集未就绪/.test(msg)) return false;
            if (/搜索边界/.test(msg)) return true;
            if (Math.abs(state.syncOffset) >= 8) return true;
            if (detail && Math.abs(detail.delta || 0) >= 2.5) return true;
            return false;
        };
        const visualAlignSearch = async () => {
            const baseTime = clampMediaTime(v1, v1.currentTime);
            const originalOffset = state.syncOffset;
            const wasPlaying = !master.paused;
            v1.pause();
            if (v2) v2.pause();

            const scoreAt = async (offset) => {
                v1.currentTime = baseTime;
                v2.currentTime = clampMediaTime(v2, baseTime + offset);
                await wait(550);
                const score = visualSimilarity(v1, v2);
                return { offset: parseFloat(offset.toFixed(2)), score };
            };

            const candidates = [];
            for (let o = -36; o <= 36; o += 6) candidates.push(o);
            if (!candidates.some(o => Math.abs(o - originalOffset) < 0.1)) candidates.push(originalOffset);
            let results = [];
            for (let i = 0; i < candidates.length; i++) {
                setAlignStatus(`视觉搜索 ${i + 1}/${candidates.length}: ${candidates[i].toFixed(0)}s`, 'warn');
                try { results.push(await scoreAt(candidates[i])); } catch(e) {}
            }
            results.sort((a, b) => b.score - a.score);
            if (!results.length) throw new Error('视觉搜索失败：无法读取视频帧');

            const coarseBest = results[0];
            const refine = [];
            for (let o = coarseBest.offset - 5; o <= coarseBest.offset + 5; o += 1) refine.push(o);
            const refineResults = [];
            for (let i = 0; i < refine.length; i++) {
                setAlignStatus(`视觉精搜 ${i + 1}/${refine.length}: ${refine[i].toFixed(1)}s`, 'warn');
                try { refineResults.push(await scoreAt(refine[i])); } catch(e) {}
            }
            results = results.concat(refineResults).sort((a, b) => b.score - a.score);
            const best = results[0];
            const second = results.find(r => Math.abs(r.offset - best.offset) > 2.5) || results[1] || best;
            const margin = best.score - second.score;
            const detail = {
                method: 'visual-projector',
                offset: best.offset,
                delta: parseFloat((best.offset - originalOffset).toFixed(3)),
                confidence: parseFloat((best.score / Math.max(0.0001, second.score)).toFixed(3)),
                peak: best.score,
                margin,
                candidates: results.slice(0, 12)
            };
            state.lastAlign = detail;

            if (best.score < 0.54 || margin < 0.018) {
                writeSync(originalOffset);
                v1.currentTime = baseTime;
                v2.currentTime = clampMediaTime(v2, baseTime + originalOffset);
                if (wasPlaying) { safePlay(v1); safePlay(v2); }
                throw new Error(`视觉结果不明确 best ${best.score.toFixed(2)} margin ${margin.toFixed(3)}`);
            }

            writeSync(best.offset);
            v1.currentTime = baseTime;
            v2.currentTime = clampMediaTime(v2, baseTime + best.offset);
            clearAudioCapture();
            if (wasPlaying) { safePlay(v1); safePlay(v2); }
            setAlignStatus(`视觉对齐: ${best.offset >= 0 ? '+' : ''}${best.offset.toFixed(2)}s score ${best.score.toFixed(2)}`, 'ok');
            return detail;
        };
        const wideAlignSearch = async () => {
            const baseV1 = clampMediaTime(v1, v1.currentTime);
            const wasPlaying = !master.paused;
            const originalOffset = state.syncOffset;
            const candidates = [];
            const addCandidate = v => {
                const c = Math.max(-60, Math.min(60, parseFloat(v.toFixed(2))));
                if (!candidates.some(x => Math.abs(x - c) < 0.01)) candidates.push(c);
            };
            [-32, -24, -16, -8, 0, 8, 16, 24, 32].forEach(d => addCandidate(originalOffset + d));

            const scoreCandidate = async (offset, sampleDur = 1.4, baseTime = baseV1, strict = false) => {
                clearAudioCapture();
                const targetV1 = clampMediaTime(v1, baseTime);
                const targetV2 = targetV1 + offset;
                const clampedV2 = clampMediaTime(v2, targetV2);
                if (Math.abs(clampedV2 - targetV2) > 0.5) {
                    return { ok: false, offset, errMsg: '候选偏移超出视频范围', score: 0 };
                }
                v1.currentTime = targetV1;
                v2.currentTime = clampedV2;
                await wait(350);
                await Promise.all([safePlay(v1), safePlay(v2)]);
                await wait(Math.ceil(sampleDur * 1000) + 350);
                return new Promise(resolve => {
                    autoAlign(v1, v2,
                        detail => resolve({ ok: true, offset: parseFloat((offset + detail.delta).toFixed(2)), detail, score: detail.confidence * detail.peak }),
                        (errMsg, detail) => resolve({ ok: false, offset, detail, errMsg, score: detail ? detail.confidence * detail.peak : 0 }),
                        {
                            sampleDur,
                            searchSec: 0.9,
                            minConfidence: strict ? 1.65 : 1.45,
                            minPeak: strict ? 0.11 : 0.10,
                            maxAbsDelta: 0.95
                        }
                    );
                });
            };

            let best = null;
            const successful = [];
            for (let i = 0; i < candidates.length; i++) {
                setAlignStatus(`大范围搜索 ${i + 1}/${candidates.length}: ${candidates[i].toFixed(0)}s`, 'warn');
                const result = await scoreCandidate(candidates[i], 1.2);
                if (result.ok) {
                    successful.push(result);
                    if (!best || result.score > best.score) best = result;
                }
            }
            if (best) {
                const refineList = [];
                for (let d = -6; d <= 6; d += 2) {
                    const c = Math.max(-60, Math.min(60, parseFloat((best.offset + d).toFixed(2))));
                    if (!refineList.some(x => Math.abs(x - c) < 0.01)) refineList.push(c);
                }
                for (let i = 0; i < refineList.length; i++) {
                    setAlignStatus(`精细搜索 ${i + 1}/${refineList.length}: ${refineList[i].toFixed(1)}s`, 'warn');
                    const result = await scoreCandidate(refineList[i], 1.5);
                    if (result.ok) {
                        successful.push(result);
                        if (result.score > best.score) best = result;
                    }
                }
            }

            const verifyWideCandidate = async (candidate, rank) => {
                const offsets = [];
                const scores = [];
                const details = [];
                const checkPoints = [baseV1, baseV1 + 8, baseV1 + 16];
                for (let i = 0; i < checkPoints.length; i++) {
                    setAlignStatus(`验证候选 ${rank}: ${candidate.offset.toFixed(2)}s (${i + 1}/${checkPoints.length})`, 'warn');
                    const result = await scoreCandidate(candidate.offset, 2.2, checkPoints[i], true);
                    if (!result.ok) continue;
                    offsets.push(result.offset);
                    scores.push(result.score);
                    details.push(result.detail);
                }
                if (offsets.length < 2) return null;
                const min = Math.min(...offsets);
                const max = Math.max(...offsets);
                if (max - min > 0.55) return null;
                const offset = parseFloat((offsets.reduce((a, b) => a + b, 0) / offsets.length).toFixed(2));
                const score = scores.reduce((a, b) => a + b, 0) / scores.length;
                const detail = Object.assign({}, details[details.length - 1], {
                    confidence: Math.min(...details.map(d => d.confidence || 0)),
                    peak: Math.min(...details.map(d => d.peak || 0))
                });
                return { ok: true, offset, detail, score };
            };

            if (successful.length) {
                const top = successful
                    .sort((a, b) => b.score - a.score)
                    .filter((item, idx, arr) => arr.findIndex(x => Math.abs(x.offset - item.offset) < 0.75) === idx)
                    .slice(0, 3);
                best = null;
                for (let i = 0; i < top.length; i++) {
                    const verified = await verifyWideCandidate(top[i], i + 1);
                    if (verified && (!best || verified.score > best.score)) best = verified;
                }
            } else {
                best = null;
            }

            if (!best) {
                writeSync(originalOffset);
                v1.currentTime = baseV1;
                v2.currentTime = clampMediaTime(v2, baseV1 + originalOffset);
                if (wasPlaying) { safePlay(v1); safePlay(v2); }
                else { v1.pause(); v2.pause(); }
                throw new Error('大范围搜索失败：没有找到跨时间点稳定的音频重合点');
            }

            writeSync(best.offset);
            v1.currentTime = baseV1;
            v2.currentTime = clampMediaTime(v2, baseV1 + best.offset);
            clearAudioCapture();
            if (wasPlaying) { safePlay(v1); safePlay(v2); }
            else { v1.pause(); v2.pause(); }
            best.detail.delta = parseFloat((best.offset - originalOffset).toFixed(3));
            state.lastAlign = best.detail;
            setAlignStatus(`大范围对齐: ${best.offset >= 0 ? '+' : ''}${best.offset.toFixed(2)}s conf ${best.detail.confidence.toFixed(2)}`, 'ok');
            return best;
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
                    pip.dataset.preCropWidth = pip.style.width || `${rect.width}px`;
                    pip.dataset.preCropHeight = pip.style.height || `${rect.height}px`;
                    pip.style.width = (rect.height * 1.333) + 'px';
                    pip.dataset.cropped = "true";
                }
                slaveEl.classList.add('crop-mode');
            } else {
                slaveEl.classList.remove('crop-mode');
                if (pip.dataset.cropped) {
                    if (pip.dataset.preCropWidth) pip.style.width = pip.dataset.preCropWidth;
                    if (pip.dataset.preCropHeight) pip.style.height = pip.dataset.preCropHeight;
                }
                delete pip.dataset.cropped;
                delete pip.dataset.preCropWidth;
                delete pip.dataset.preCropHeight;
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
            if (!hasDual) { showToast("当前只有一路视频"); return; }
            state.isSwapped = !state.isSwapped;
            const stage = document.getElementById('hsp-stage');
            const pip = document.getElementById('hsp-pip');
            if (state.isSwapped) { stage.appendChild(v2); pip.appendChild(v1); master=v2; slave=v1; }
            else { stage.appendChild(v1); pip.appendChild(v2); master=v1; slave=v2; }
            applyBaseRate();
            syncSlaveNow(0.05);
            applyVideoStyles();
            showToast("视角已交换", 'ok');
        };

        document.getElementById('btn-toggle-pip').onclick = function() {
            if (!hasDual) { showToast("当前只有一路视频"); return; }
            state.isPipVisible = !state.isPipVisible;
            document.getElementById('hsp-pip').style.display = state.isPipVisible ? 'block' : 'none';
            if (state.isPipVisible) { this.classList.add('h-btn-act'); this.classList.remove('h-btn-dim'); }
            else { this.classList.remove('h-btn-act'); this.classList.add('h-btn-dim'); }
        };

        document.getElementById('btn-stretch-main').onclick = () => {
            state.isStretchMain = !state.isStretchMain;
            applyVideoStyles();
            showToast(state.isStretchMain?"主画面: 强制拉伸":"主画面: 保持比例", 'ok');
        };

        document.getElementById('btn-crop-sub').onclick = () => {
            if (!hasDual) { showToast("当前只有一路视频"); return; }
            if (state.isSwapped) {
                state.isCropV1 = !state.isCropV1;
            } else {
                state.isCropV2 = !state.isCropV2;
            }
            applyVideoStyles();
        };

        const btnPlay = document.getElementById('btn-play');
        let bufferHoldActive = false;
        let bufferHoldWasPlaying = false;
        const checkBuffer = () => {
            const wantsPlayback = btnPlay.textContent === '❚❚' || bufferHoldActive;
            const buffering = wantsPlayback && ((master.readyState < 3) || (hasDual && slave.readyState < 3 && state.isPipVisible));
            loader.style.display = buffering ? 'flex' : 'none';
            if (buffering) {
                if (!bufferHoldActive) {
                    bufferHoldActive = true;
                    bufferHoldWasPlaying = btnPlay.textContent === '❚❚' || !master.paused || (hasDual && slave && !slave.paused);
                }
                master.pause();
                if (hasDual && slave) slave.pause();
            } else {
                if (bufferHoldActive && bufferHoldWasPlaying) {
                    bufferHoldActive = false;
                    syncHoldUntil = Date.now() + 900;
                    syncSlaveNow(0.05);
                    if (master.paused) safePlay(master);
                    if (hasDual && slave.paused) safePlay(slave).then(() => syncSlaveNow(0.08));
                } else if (bufferHoldActive) {
                    bufferHoldActive = false;
                }
            }
        };
        [v1, v2].filter(v => hasDual || v === v1).forEach(v => {
            v.addEventListener('waiting', checkBuffer);
            v.addEventListener('canplay', checkBuffer);
            v.addEventListener('playing', checkBuffer);
            v.addEventListener('seeking', () => {
                if (v === master && Date.now() > syncHoldUntil) {
                    clearAudioCapture();
                    liveAlignStable = [];
                    lastMasterTime = null;
                    setAlignStatus(state.realtimeAlign ? 'AUTO 等待新位置声音' : '', '');
                }
            });
            v.addEventListener('seeked', () => {
                if (v === master) {
                    clearAudioCapture();
                    liveAlignStable = [];
                    lastMasterTime = master.currentTime;
                    lastMasterStamp = Date.now();
                }
                syncSlaveNow(0.08);
            });
        });

        const toggle = () => {
            if (master.paused) {
                safePlay(master); if (slave) safePlay(slave).then(() => syncSlaveNow(0.08));
                btnPlay.textContent = '❚❚';
            } else {
                master.pause(); if (slave) slave.pause();
                btnPlay.textContent = '▶';
            }
        };
        btnPlay.onclick = v1.onclick = v2.onclick = toggle;

        const seekBar = document.getElementById('seek-bar');
        const barContainer = document.getElementById('bar-container');
        const barPlayed = document.getElementById('bar-played');

        const updateBufferUI = () => {
            const now = Date.now();
            if (now - lastBufferUiAt < 800) return;
            lastBufferUiAt = now;
            const d = safeDuration(master);
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
            const d = safeDuration(master);
            const c = master.currentTime;
            const now = Date.now();
            if (lastMasterTime != null && lastMasterStamp) {
                const elapsed = (now - lastMasterStamp) / 1000;
                const expected = elapsed * Math.max(0.1, state.rate);
                if (Math.abs((c - lastMasterTime) - expected) > 2.0 && now > syncHoldUntil) {
                    clearAudioCapture();
                    liveAlignStable = [];
                    setAlignStatus(state.realtimeAlign ? 'AUTO 等待新位置声音' : '', '');
                }
            }
            lastMasterTime = c;
            lastMasterStamp = now;

            const pct = (c/d)*100;
            if(Math.abs(seekBar.value-pct)>0.5) seekBar.value = pct;
            barPlayed.style.width = pct + '%';
            document.getElementById('t-cur').textContent=fmt(c); document.getElementById('t-dur').textContent=fmt(d);

            updateBufferUI();

            syncSlaveNow();
        };
        master.ontimeupdate = updateTick;
        if (slave) slave.ontimeupdate = ()=>{if(state.isSwapped)updateTick()};
        master.addEventListener('progress', updateBufferUI);
        runtime.timers.push(setInterval(() => syncSlaveNow(), 500));
        runtime.timers.push(setInterval(maybeLiveAlign, 6000));
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                if (slave) slave.playbackRate = state.rate;
                return;
            }
            applyBaseRate();
            syncHoldUntil = Date.now() + 900;
            syncSlaveNow(0.05);
            checkBuffer();
        });

        seekBar.oninput = e => {
            const d = safeDuration(master);
            const t = (e.target.value/100)*(d||1);
            seekBoth(t);
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
            state.vocalGain=parseFloat(e.target.value);
            document.getElementById('txt-vocal').textContent = state.vocalGain > 0 ? `+${state.vocalGain}dB` : "OFF";
            updateAudioState(v1,v2);
        };
        const syncIn=document.getElementById('sync-input'), syncSl=document.getElementById('sync-slider');
        const setSync=v=>{
            writeSync(v);
            liveAlignStable = [];
            lastCalibrationAt = 0;
            lastCalibrationSamples = null;
            lastCalibrationTarget = null;
            setAlignStatus(`同步: ${state.syncOffset >= 0 ? '+' : ''}${state.syncOffset.toFixed(2)}s`);
        };
        syncIn.oninput=e=>setSync(e.target.value);
        syncIn.onchange=e=>setSync(e.target.value);
        syncSl.oninput=e=>setSync(e.target.value);

        // 自动对齐按钮
        const btnAutoAlign = document.getElementById('btn-auto-align');
        const searchableWindow = () => {
            const available = Math.min(projectedAudioSeconds(state.syncOffset), 121);
            return Math.max(0, Math.min(10, available - 0.5));
        };
        const resetAutoAlignButton = () => {
            btnAutoAlign.disabled = false;
            btnAutoAlign.style.opacity = '1';
            btnAutoAlign.title = '校准：只在当前对齐设置的 ±10 秒内精修';
        };
        const showLocalAlignGuide = (mode) => {
            setAlignStatus(mode === 'AUTO' ? 'AUTO: ±10s局部修正' : '校准: ±10s局部精修', 'warn');
            showToast('使用前提：先手动把两路调到±10秒内，并且当前片段要有老师声音', 'warn', 5600, { protect: true });
        };
        const runClassicCalibration = () => {
            autoAlign(v1, v2,
                detail => {
                    const newOffset = applyAlignDelta(detail, '校准');
                    lastCalibrationAt = Date.now();
                    liveAlignStable = [];
                    if (!lastCalibrationSamples || Math.abs(detail.delta) > 0.15) {
                        lastCalibrationSamples = captureTotals();
                        lastCalibrationTarget = newOffset;
                    }
                    showToast(`已校准 ${newOffset >= 0 ? '+' : ''}${newOffset.toFixed(2)}s`, 'ok');
                    resetAutoAlignButton();
                },
                (errMsg, detail) => {
                    const suffix = detail && detail.confidence ? ` conf ${detail.confidence.toFixed(2)}` : '';
                    setAlignStatus(errMsg + suffix, 'warn');
                    showToast('⚠️ ' + errMsg + suffix, 'warn');
                    resetAutoAlignButton();
                },
                {
                    sampleDur: 30,
                    minSampleDur: 5.5,
                    searchSec: 10,
                    minSearchSec: 5,
                    minRms: 0.001,
                    maxAbsDelta: 10.1,
                    silenceOnlyValidation: true,
                    projectHistory: true
                }
            );
        };
        btnAutoAlign.onclick = () => {
            if (!hasDual) { showToast("当前只有一路视频"); return; }
            if (btnAutoAlign.disabled) return;
            btnAutoAlign.disabled = true;
            btnAutoAlign.style.opacity = '0.5';
            btnAutoAlign.title = '分析中…';
            if (master.paused || slave.paused) {
                showLocalAlignGuide('校准');
                resetAutoAlignButton();
                return;
            }
            const win = searchableWindow();
            if (state.lastAlign && Date.now() - lastCalibrationAt < 3000 && Math.abs((state.lastAlign.targetOffset || state.syncOffset) - state.syncOffset) < 0.15) {
                const offset = Number.isFinite(state.syncOffset) ? state.syncOffset : 0;
                setAlignStatus(`已校准: ${offset >= 0 ? '+' : ''}${offset.toFixed(2)}s`, 'ok');
                showToast(`刚刚已校准，可继续复核`, 'ok');
                resetAutoAlignButton();
                return;
            }
            showLocalAlignGuide('校准');
            setTimeout(() => {
                setAlignStatus(`校准中: ±${Math.min(10, win).toFixed(1)}s`, 'warn');
            }, 900);
            runClassicCalibration();
        };
        document.getElementById('btn-live-align').onclick = e => {
            if (!hasDual) { showToast("当前只有一路视频", 'warn'); return; }
            state.realtimeAlign = !state.realtimeAlign;
            e.currentTarget.classList.toggle('active', state.realtimeAlign);
            liveAlignStable = [];
            if (state.realtimeAlign) {
                ensureAudioCapture();
                showLocalAlignGuide('AUTO');
                setTimeout(() => setAlignStatus('AUTO: 等待有声片段', ''), 1200);
                showToast('AUTO 已开启：只做±10s局部修正', 'ok', 2800);
                setTimeout(maybeLiveAlign, 500);
            } else {
                setAlignStatus('');
                showToast('AUTO 已关闭');
            }
        };
        document.getElementById('rate-bar').oninput = e => { const r=parseFloat(e.target.value); state.rate=r; applyBaseRate(); document.getElementById('txt-rate').textContent=r.toFixed(1)+'x'; };
        document.getElementById('btn-fs').onclick = () => { const r=document.getElementById('hsp-root-v20'); if(!document.fullscreenElement) r.requestFullscreen(); else document.exitFullscreen(); };
        document.getElementById('btn-help').onclick = () => document.getElementById('hsp-help').style.display = 'flex';
        document.querySelector('.btn-close-help').onclick = () => document.getElementById('hsp-help').style.display = 'none';

        document.addEventListener('keydown', e => {
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
            if (e.code === 'Space') { e.preventDefault(); toggle(); }
            if (e.code === 'ArrowRight') { seekBoth(master.currentTime + 5); showToast('快进 5s'); }
            if (e.code === 'ArrowLeft') { seekBoth(master.currentTime - 5); showToast('后退 5s'); }
        });
        runtime.current = {
            state,
            get masterId() { return master && master.id; },
            get slaveId() { return slave && slave.id; },
            get streams() { return urls.slice(); },
            get syncOffset() { return state.syncOffset; },
            setSync: writeSync,
            seekBoth,
            autoAlignNow: () => new Promise((resolve, reject) => autoAlign(v1, v2, resolve, reject)),
            fingerprintCandidate: (opts = {}) => offlineFingerprintAlign(urls, master.currentTime, Object.assign({ maxApplyOffset: 120, windowSec: 120, searchSec: 100 }, opts)),
            getAlignStatus: () => ({ status: state.alignStatus, last: state.lastAlign, realtime: state.realtimeAlign })
        };
        window.__HSP_DEBUG__ = runtime.current;
        if (typeof unsafeWindow !== 'undefined') unsafeWindow.__HSP_DEBUG__ = runtime.current;
        writeDebugState();
        if (typeof unsafeWindow !== 'undefined') {
            unsafeWindow.__HSP_CLEANUP__ = () => {
                runtime.timers.forEach(id => clearInterval(id));
                runtime.timers = [];
                try { document.getElementById('hsp-root-v20')?.remove(); } catch(e) {}
                try { audioCapture.processors.v1?.disconnect(); audioCapture.processors.v2?.disconnect(); audioCapture.sink?.disconnect(); } catch(e) {}
                audioCapture.processors.v1 = null;
                audioCapture.processors.v2 = null;
                audioCapture.sink = null;
            };
        }
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
