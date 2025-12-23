// ==UserScript==
// @name         HITSZ 课堂视频超级播放器
// @namespace    http://tampermonkey.net/
// @version      20.0
// @description  HITSZ 视频平台功能增强脚本。核心专注于“双流同屏”体验： 自动开启画中画模式，支持老师视角与课件视角同时播放。功能包含：画中画4:3物理去黑边、主画面拉伸铺满、5倍音量增益与人声降噪、自由拖拽缩放、音画同步微调、左上角课程信息显示。
// @author       BCC
// @match        *://jxypt.hitsz.edu.cn/ve/back/rp/common/rpIndex.shtml?method=studyCourseDeatil*
// @match        *://jxypt-hitsz-edu-cn-s.hitsz.edu.cn/ve/back/rp/common/rpIndex.shtml?method=studyCourseDeatil*
// @grant        unsafeWindow
// @license      MIT
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // === 全局状态 ===
    const capturedUrls = new Set();
    let isPlayerLaunched = false;
    let videoMeta = { title: '未知课程', teacher: '未知教师', date: '' };

    const state = {
        isSwapped: false,
        syncOffset: 0.0,
        vocalGain: 5,           // 默认 5dB
        isCropSub: false,       // 画中画去黑边状态
        isPipVisible: true,     // 画中画显隐
        isStretchMain: false,   // 主画面强制拉伸状态
        vol1: 1.0,              // 源1音量
        vol2: 0.0,              // 源2音量
        rate: 1.0
    };

    let audioCtx;
    const nodes = { v1: null, v2: null };

    console.log("HSP V20 (Author: BCC): 引擎启动...");

    // ==========================================
    // 0. 信息抓取
    // ==========================================
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

    // ==========================================
    // 1. 网络嗅探 (仅用于播放)
    // ==========================================
    const isValidStream = (url) => {
        if (typeof url !== 'string') return false;
        const isVideo = url.includes('.m3u8') || url.includes('.mp4');
        const isSegment = url.includes('.ts') || url.includes('seg-') || url.includes('fragment') || url.includes('chunklist');
        return isVideo && !isSegment;
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (isValidStream(url)) { capturedUrls.add(url); tryLaunch(); }
        return originalOpen.apply(this, arguments);
    };

    const originalFetch = window.fetch;
    window.fetch = function(url, options) {
        if (isValidStream(url)) { capturedUrls.add(url); tryLaunch(); }
        return originalFetch.apply(this, arguments);
    };

    let launchTimer;
    function tryLaunch() {
        if (isPlayerLaunched) return;
        clearTimeout(launchTimer);
        launchTimer = setTimeout(() => {
            const validList = Array.from(capturedUrls).filter(isValidStream);
            if (validList.length > 0) {
                parseMetaFromUrl(validList[0]);
                isPlayerLaunched = true;
                renderUI(validList);
            }
        }, 1200);
    }

    // ==========================================
    // 2. 音频引擎 (DSP)
    // ==========================================
    function setupAudioNode(videoEl, id) {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (nodes[id]) return nodes[id];

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

        source.connect(highpass); highpass.connect(lowpass); lowpass.connect(highshelf);
        highshelf.connect(peaking); peaking.connect(compressor); compressor.connect(gain);
        gain.connect(audioCtx.destination);

        nodes[id] = { gain, lowpass, highpass, highshelf, peaking, compressor };
        return nodes[id];
    }

    function updateAudioState(v1, v2) {
        if (!audioCtx) return;
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

    // ==========================================
    // 3. UI 渲染
    // ==========================================
    function renderUI(urls) {
        const styleReset = document.createElement('style');
        styleReset.innerHTML = `html, body { overflow: hidden !important; width: 100%; height: 100%; margin: 0; }`;
        document.head.appendChild(styleReset);

        const root = document.createElement('div');
        root.id = 'hsp-root-v20';

        const css = `
            #hsp-root-v20 {
                position: fixed !important; inset: 0; background: #000; z-index: 2147483647;
                color: #eee; font-family: 'Segoe UI', system-ui, sans-serif; user-select: none;
            }
            #hsp-root-v20 * { box-sizing: border-box; }

            /* 舞台 */
            #hsp-stage { position: absolute; inset: 0; display:flex; justify-content:center; align-items:center; z-index:1; overflow:hidden;}
            video.hsp-video {
                width: 100%; height: 100%; object-fit: contain;
                background: #000; outline: none;
                transition: transform 0.3s, object-fit 0.2s;
                transform-origin: center center;
            }
            video.hsp-video.stretch-mode { object-fit: fill !important; }

            /* 画中画 */
            #hsp-pip {
                position: absolute; bottom: 130px; right: 30px;
                width: 400px; height: 225px; min-width: 150px; min-height: 100px;
                background: #000; border: 1px solid rgba(255,255,255,0.2);
                border-radius: 8px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
                z-index: 100; overflow: hidden;
                transition: width 0.3s, height 0.3s;
            }
            #hsp-pip:hover { border-color: #00a8ff; }
            #hsp-pip video { position:absolute; inset:0; width:100%; height:100%; object-fit:fill; pointer-events:none; }
            #hsp-pip video.pip-crop { object-fit: cover !important; }

            /* 信息浮层 */
            #hsp-info {
                position: absolute; top: 20px; left: 20px; z-index: 50;
                pointer-events: none; opacity: 0; transition: opacity 0.3s;
                text-shadow: 0 2px 4px rgba(0,0,0,0.8);
            }
            #hsp-root-v20:hover #hsp-info { opacity: 1; }
            .info-title { font-size: 24px; font-weight: bold; color: #fff; margin-bottom: 4px; }
            .info-meta { font-size: 14px; color: #ccc; display: flex; gap: 15px; }
            .info-tag { background: rgba(0,168,255,0.2); color: #00a8ff; padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 12px; align-self: center;}

            /* Resizers */
            .resizer { position: absolute; z-index: 50; }
            .resizer.nw { top:0; left:0; width:15px; height:15px; cursor:nw-resize; border-top:3px solid #00a8ff; border-left:3px solid #00a8ff; }
            .resizer.ne { top:0; right:0; width:15px; height:15px; cursor:ne-resize; border-top:3px solid #00a8ff; border-right:3px solid #00a8ff; }
            .resizer.sw { bottom:0; left:0; width:15px; height:15px; cursor:sw-resize; border-bottom:3px solid #00a8ff; border-left:3px solid #00a8ff; }
            .resizer.se { bottom:0; right:0; width:15px; height:15px; cursor:se-resize; background: linear-gradient(135deg, transparent 50%, #00a8ff 50%); }
            .resizer.n { top:0; left:15px; right:15px; height:6px; cursor:ns-resize; }
            .resizer.s { bottom:0; left:15px; right:15px; height:6px; cursor:ns-resize; }
            .resizer.w { left:0; top:15px; bottom:15px; width:6px; cursor:ew-resize; }
            .resizer.e { right:0; top:15px; bottom:15px; width:6px; cursor:ew-resize; }
            .pip-move { position: absolute; inset: 20px; z-index: 20; cursor: move; }
            .pip-bar {
                position: absolute; top: 0; left: 0; right: 0; height: 32px;
                background: linear-gradient(to bottom, rgba(0,0,0,0.9), transparent);
                display: flex; justify-content: space-between; align-items: center; padding: 0 8px;
                z-index: 30; opacity: 0; transition: opacity 0.2s;
            }
            #hsp-pip:hover .pip-bar { opacity: 1; }

            /* 控制栏 */
            #hsp-controls {
                position: absolute; bottom: 20px; left: 20px; right: 20px; height: 95px;
                background: rgba(30, 30, 30, 0.85); backdrop-filter: blur(16px);
                border: 1px solid rgba(255,255,255,0.1); border-radius: 16px;
                display: flex; align-items: center; padding: 0 24px; gap: 20px; z-index: 200;
                box-shadow: 0 4px 24px rgba(0,0,0,0.3); opacity: 0; transition: opacity 0.3s;
            }
            #hsp-root-v20:hover #hsp-controls { opacity: 1; }

            .h-btn { background: none; border: none; color: #ddd; cursor: pointer; height: 36px; display:flex; align-items:center; justify-content:center; border-radius: 6px; font-size: 14px; transition:0.2s; white-space:nowrap;}
            .h-btn:hover { background: rgba(255,255,255,0.15); color: #fff; }
            .h-btn-act { color: #000; background: #00a8ff; font-weight:bold; }

            .prog-wrap { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 4px; }
            .time-txt { font-size: 12px; color: #aaa; font-variant-numeric: tabular-nums; letter-spacing: 0.5px; }
            input[type=range] { -webkit-appearance: none; width: 100%; background: transparent; cursor: pointer; height: 16px; }
            input[type=range]::-webkit-slider-runnable-track { width: 100%; height: 4px; background: rgba(255,255,255,0.2); border-radius: 2px; }
            input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; height: 12px; width: 12px; border-radius: 50%; background: #fff; margin-top: -4px; box-shadow: 0 2px 4px #000; transition: transform 0.1s;}
            input[type=range]:hover::-webkit-slider-thumb { transform: scale(1.3); background: #00a8ff; }
            .ctrl-grp { display: flex; flex-direction: column; gap: 2px; width: 95px; }
            .ctrl-header { display:flex; justify-content:space-between; align-items: center; font-size: 11px; color: #999; margin-bottom: 2px;}
            .ctrl-val { color: #00a8ff; font-weight: bold; }
            .sync-input { background: transparent; border: none; color: #00a8ff; width: 40px; text-align: right; font-weight:bold; font-size:11px; padding:0; margin:0; height: 14px; line-height:14px;}
            .sync-unit { margin-left: 2px; line-height:14px; font-size:11px; color:#aaa; }

            /* 帮助面板 */
            .overlay-panel { position: absolute; inset: 0; background: rgba(0,0,0,0.7); backdrop-filter: blur(8px); z-index: 900; display: none; align-items: center; justify-content: center; }
            .panel-card { background: #1e1e1e; width: 800px; padding: 25px; border-radius: 16px; border: 1px solid #444; max-height:85vh; overflow-y:auto; box-shadow: 0 20px 50px rgba(0,0,0,0.8); }
            .panel-title { font-size:18px; font-weight:bold; color:#fff; border-bottom:1px solid #333; padding-bottom:15px; margin-bottom:15px; display:flex; justify-content:space-between; }

            .help-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
            .help-item h4 { color: #00a8ff; margin-bottom: 8px; font-size: 15px; border-left: 3px solid #00a8ff; padding-left: 8px; }
            .help-item ul { list-style: none; font-size: 13px; color: #ccc; line-height: 1.8; padding:0; }
            .help-item li { border-bottom: 1px dashed #333; padding-bottom: 4px; margin-bottom: 4px; }
            .help-item li b { color:#fff; background:#333; padding:2px 6px; border-radius:4px; font-size:12px; margin-right:6px; }

            #hsp-toast {
                position: absolute; top: 100px; left: 50%; transform: translateX(-50%);
                background: rgba(0,0,0,0.8); padding: 8px 20px; border-radius: 20px;
                font-size: 14px; opacity: 0; pointer-events: none; transition: 0.3s; z-index: 500;
            }
        `;

        const styleTag = document.createElement('style');
        styleTag.textContent = css;

        root.innerHTML = `
            <div id="hsp-stage"></div>
            <div id="hsp-toast">提示</div>

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
                    <button class="h-btn" id="btn-crop-sub" style="font-size:12px; padding:0 6px;" title="将画中画重置为4:3无黑边">✂ 4:3去黑边</button>
                    <button class="h-btn" id="btn-swap" style="font-size:12px; padding:0 6px;">⇋ 交换</button>
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
                                <li><b>同步微调</b> 0.0s 精度微调，解决音画不同步</li>
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
                    <input type="range" id="seek-bar" value="0" step="0.1">
                </div>

                <div class="ctrl-grp" style="border-right:1px solid #444; padding-right:10px; margin-right:5px;">
                    <div class="ctrl-header">
                        <span>同步微调</span>
                        <div style="display:flex;align-items:center;height:14px;"><input id="sync-input" class="sync-input" value="0.0"><span class="sync-unit">s</span></div>
                    </div>
                    <input type="range" id="sync-slider" min="-5" max="5" step="0.1" value="0">
                </div>

                <div class="ctrl-grp" style="border-right:1px solid #444; padding-right:10px; margin-right:5px;">
                    <div class="ctrl-header"><span>人声增强</span><span id="txt-vocal" class="ctrl-val">5dB</span></div>
                    <input type="range" id="vocal-slider" min="0" max="30" step="1" value="5" title="含高频降噪与动态压缩">
                </div>

                <div class="ctrl-grp">
                    <div class="ctrl-header"><span>音量 1</span><span id="txt-v1" class="ctrl-val">100%</span></div>
                    <input type="range" id="vol-1" max="5" step="0.1" value="1" title="绑定视频源1">
                </div>

                <div class="ctrl-grp">
                    <div class="ctrl-header"><span>音量 2</span><span id="txt-v2" class="ctrl-val">0%</span></div>
                    <input type="range" id="vol-2" max="5" step="0.1" value="0" title="绑定视频源2">
                </div>

                <div class="ctrl-grp" style="width:80px;">
                    <div class="ctrl-header"><span>倍速</span><span id="txt-rate" class="ctrl-val">1.0x</span></div>
                    <input type="range" id="rate-bar" min="0.5" max="3.5" step="0.1" value="1">
                </div>

                <button id="btn-toggle-pip" class="h-btn h-btn-act" title="显示/隐藏画中画 (声音保持)" style="font-size:18px;">👁️</button>
                <button id="btn-stretch-main" class="h-btn" title="拉伸/原比" style="font-size:18px;">↔</button>
                <button id="btn-fs" class="h-btn" style="font-size:20px;">⛶</button>
                <button id="btn-help" class="h-btn" style="font-size:20px;">?</button>
            </div>
        `;

        document.body.appendChild(root);
        root.appendChild(styleTag);
        initKernel(urls);
    }

    // ==========================================
    // 4. 内核逻辑
    // ==========================================
    function initKernel(urls) {
        const v1 = document.createElement('video'); v1.className = 'hsp-video'; v1.id = 'hsp-v1'; v1.crossOrigin = "anonymous";
        const v2 = document.createElement('video'); v2.className = 'hsp-video'; v2.id = 'hsp-v2'; v2.crossOrigin = "anonymous";

        document.getElementById('hsp-stage').appendChild(v1);
        document.getElementById('hsp-pip').appendChild(v2);

        const hls1 = new Hls(); const hls2 = new Hls();
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

        bindEvents(v1, v2, urls);
        initResizeLogic();
    }

    function bindEvents(v1, v2, urls) {
        let master = v1; let slave = v2;
        const showToast = (msg) => {
            const t = document.getElementById('hsp-toast');
            t.textContent = msg; t.style.opacity = 1;
            setTimeout(() => t.style.opacity = 0, 1500);
        };

        // 交换
        document.getElementById('btn-swap').onclick = () => {
            state.isSwapped = !state.isSwapped;
            const stage = document.getElementById('hsp-stage');
            const pip = document.getElementById('hsp-pip');
            if (state.isSwapped) { stage.appendChild(v2); pip.appendChild(v1); master=v2; slave=v1; }
            else { stage.appendChild(v1); pip.appendChild(v2); master=v1; slave=v2; }

            state.isStretchMain = false;
            applyVideoStyles();
            showToast("视角已交换");
        };

        // PiP 显隐
        document.getElementById('btn-toggle-pip').onclick = function() {
            state.isPipVisible = !state.isPipVisible;
            const pip = document.getElementById('hsp-pip');
            if (state.isPipVisible) {
                pip.style.display = 'block';
                this.classList.add('h-btn-act');
                this.style.opacity = '1';
                showToast("副画面: 显示");
            } else {
                pip.style.display = 'none';
                this.classList.remove('h-btn-act');
                this.style.opacity = '0.5';
                showToast("副画面: 隐藏 (声音继续)");
            }
        };

        const applyVideoStyles = () => {
            if (state.isStretchMain) master.classList.add('stretch-mode'); else master.classList.remove('stretch-mode');
            const pip = document.getElementById('hsp-pip');
            if (state.isCropSub) {
                const rect = pip.getBoundingClientRect();
                const newH = rect.width * 0.75;
                pip.style.height = newH + 'px';
                slave.classList.add('pip-crop');
            } else {
                slave.classList.remove('pip-crop');
            }
            document.getElementById('btn-stretch-main').classList.toggle('h-btn-act', state.isStretchMain);
            document.getElementById('btn-crop-sub').classList.toggle('h-btn-act', state.isCropSub);
        };

        document.getElementById('btn-stretch-main').onclick = () => { state.isStretchMain = !state.isStretchMain; applyVideoStyles(); showToast(state.isStretchMain?"主画面: 强制拉伸":"主画面: 保持比例"); };
        document.getElementById('btn-crop-sub').onclick = () => { state.isCropSub = !state.isCropSub; applyVideoStyles(); showToast(state.isCropSub?"画中画: 4:3 去黑边":"画中画: 自由模式"); };

        const btnPlay = document.getElementById('btn-play');
        const toggle = () => {
            if (master.paused) { master.play(); slave.play(); btnPlay.textContent = '❚❚'; }
            else { master.pause(); slave.pause(); btnPlay.textContent = '▶'; }
        };
        btnPlay.onclick = v1.onclick = v2.onclick = toggle;

        const seekBar = document.getElementById('seek-bar');
        const updateTick = () => {
            let d = master.duration; if(!Number.isFinite(d)&&master.seekable.length) d=master.seekable.end(0);
            const c = master.currentTime;
            if(Number.isFinite(d)&&d>0) {
                if(Math.abs(seekBar.value-(c/d)*100)>1) seekBar.value=(c/d)*100;
                document.getElementById('t-cur').textContent=fmt(c); document.getElementById('t-dur').textContent=fmt(d);
            }
            const tgt = c + state.syncOffset;
            if(Math.abs(slave.currentTime-tgt)>0.5) slave.currentTime=tgt;
            if(!master.paused && slave.paused) slave.play();
            if(master.paused && !slave.paused) slave.pause();
        };
        master.ontimeupdate = updateTick; slave.ontimeupdate = ()=>{if(state.isSwapped)updateTick()};
        seekBar.oninput = e => {
            let d = master.duration; if(!Number.isFinite(d)) d=master.seekable.end(0);
            const t = (e.target.value/100)*(d||1); master.currentTime=t; slave.currentTime=t+state.syncOffset;
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

    // ==========================================
    // 5. 缩放逻辑
    // ==========================================
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