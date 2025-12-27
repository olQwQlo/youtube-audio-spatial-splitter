// Content Script

class AudioGraph {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.nodes = {
      stereo: null,
      splitter: null,
      hrtfL: null,
      hrtfR: null,
      lowShelf: null,  // [NEW] ASMR Bass
      highShelf: null  // [NEW] ASMR Detail
    };
    this.panningMode = 'HRTF'; // Tab-specific: 'HRTF' (Binaural) | 'equalpower' (Speaker)
    this.videoElement = null;
    this.isAttached = false;
  }

  _handleAutoplayPolicy() {
    if (this.ctx.state === 'suspended') {
      const resume = () => {
        this.ctx.resume();
        window.removeEventListener('click', resume);
        window.removeEventListener('keydown', resume);
      };
      window.addEventListener('click', resume);
      window.addEventListener('keydown', resume);
    }
  }

  _attachLifecycleListeners() {
    if (!this.videoElement) return;

    // Suspend when paused or ended to save CPU
    const onPause = () => {
      // confirm video is actually paused (sometimes events fire oddly)
      if (this.videoElement.paused && this.ctx && this.ctx.state === 'running') {
        console.log("[Spatial Splitter] Suspending AudioContext (Video Paused)");
        this.ctx.suspend();
      }
    };

    // Resume when playing
    const onPlay = () => {
      if (this.ctx && this.ctx.state === 'suspended') {
        console.log("[Spatial Splitter] Resuming AudioContext (Video Playing)");
        this.ctx.resume();
      }
    };

    this.videoElement.addEventListener('pause', onPause);
    this.videoElement.addEventListener('ended', onPause);
    this.videoElement.addEventListener('play', onPlay);

    // Also hook into seeking, just in case
    this.videoElement.addEventListener('seeking', onPlay);
  }

  async init(video) {
    if (this.isAttached && this.videoElement === video) return;

    try {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      }

      this._handleAutoplayPolicy();

      // Create Source
      this.source = this.ctx.createMediaElementSource(video);

      // Create Processing Nodes
      this.nodes.stereo = this.ctx.createStereoPanner();

      // [NEW] ASMR Filters
      this.nodes.lowShelf = this.ctx.createBiquadFilter();
      this.nodes.lowShelf.type = 'lowshelf';
      this.nodes.lowShelf.frequency.value = 150;
      this.nodes.lowShelf.gain.value = 0;

      this.nodes.highShelf = this.ctx.createBiquadFilter();
      this.nodes.highShelf.type = 'highshelf';
      this.nodes.highShelf.frequency.value = 5000;
      this.nodes.highShelf.gain.value = 0;

      // [NEW] Splitter for Dual Panner implementation
      this.nodes.splitter = this.ctx.createChannelSplitter(2);

      // [NEW] Create two panners for Virtual Stereo Speakers
      const createPanner = () => {
        const p = this.ctx.createPanner();
        p.panningModel = 'HRTF';
        p.distanceModel = 'inverse';
        p.refDistance = 1;
        p.maxDistance = 10000;
        p.rolloffFactor = 1;
        return p;
      };

      this.nodes.hrtfL = createPanner();
      this.nodes.hrtfR = createPanner();

      // Initial Connect
      this._connectGraph();

      this.videoElement = video;
      this._attachLifecycleListeners(); // Attach listeners for suspend/resume

      this.isAttached = true;
      console.log("[Spatial Splitter] Audio graph constructed (Dual Panner Ready)");

    } catch (e) {
      console.error("[Spatial Splitter] Setup error:", e);
    }
  }



  // [NEW] Apply rich state
  applyState(degrees, radius, panningMode) {
    if (!this.ctx) return;

    // Update Panning Mode if changed (Speaker vs Binaural)
    if (panningMode && this.panningMode !== panningMode) {
      this.panningMode = panningMode;
      this._updatePannerAttributes();
    }

    // [NEW] Binaural ASMR Effect
    if (this.panningMode === 'HRTF') {
      this._applyAsmrEffect(radius);
    } else {
      this._resetAsmrEffect();
    }

    this._apply360(degrees, radius);
  }

  // [NEW] Proximity EQ
  _applyAsmrEffect(radius) {
    const THRESHOLD = 0.4; // Effect starts when closer than 40%

    if (radius < THRESHOLD) {
      const intensity = 1.0 - (radius / THRESHOLD);

      // Boost parameters
      const lowGain = intensity * 6; // +6dB max
      const highGain = intensity * 4; // +4dB max

      const t = this.ctx.currentTime + 0.1;
      if (this.nodes.lowShelf) this.nodes.lowShelf.gain.setTargetAtTime(lowGain, t, 0.1);
      if (this.nodes.highShelf) this.nodes.highShelf.gain.setTargetAtTime(highGain, t, 0.1);
    } else {
      this._resetAsmrEffect();
    }
  }

  _resetAsmrEffect() {
    if (this.nodes.lowShelf && this.nodes.highShelf) {
      const t = this.ctx.currentTime + 0.1;
      this.nodes.lowShelf.gain.setTargetAtTime(0, t, 0.1);
      this.nodes.highShelf.gain.setTargetAtTime(0, t, 0.1);
    }
  }

  _updatePannerAttributes() {
    const panners = [this.nodes.hrtfL, this.nodes.hrtfR];
    const isSpeaker = (this.panningMode === 'speaker');

    // Map 'speaker' -> 'equalpower', 'binaural' -> 'HRTF'
    const model = isSpeaker ? 'equalpower' : 'HRTF';

    panners.forEach(p => {
      if (!p) return;
      if (p.panningModel !== model) p.panningModel = model;

      if (isSpeaker) {
        // Speaker: No attenuation
        p.distanceModel = 'inverse';
        p.refDistance = 10000;
        p.rolloffFactor = 1;
      } else {
        // Binaural: Sharp proximity effect
        p.distanceModel = 'inverse';
        p.refDistance = 0.5; // Closer ref distance for intimacy
        p.rolloffFactor = 2; // sharper falloff
      }
    });
  }

  _connectGraph() {
    if (!this.source || !this.ctx) return;

    // Disconnect all
    try { this.source.disconnect(); } catch (e) { }
    try { this.nodes.stereo.disconnect(); } catch (e) { }
    try { this.nodes.splitter.disconnect(); } catch (e) { }
    try { this.nodes.lowShelf.disconnect(); } catch (e) { }
    try { this.nodes.highShelf.disconnect(); } catch (e) { }
    try { this.nodes.hrtfL.disconnect(); } catch (e) { }
    try { this.nodes.hrtfR.disconnect(); } catch (e) { }

    // Connect based on mode
    // Source -> LowShelf -> HighShelf -> Splitter -> Panners
    this.source.connect(this.nodes.lowShelf);
    this.nodes.lowShelf.connect(this.nodes.highShelf);
    this.nodes.highShelf.connect(this.nodes.splitter);

    this.nodes.splitter.connect(this.nodes.hrtfL, 0);
    this.nodes.splitter.connect(this.nodes.hrtfR, 1);
    this.nodes.hrtfL.connect(this.ctx.destination);
    this.nodes.hrtfR.connect(this.ctx.destination);

    // Ensure attributes are correct for current panningMode
    this._updatePannerAttributes();

    console.log(`[Spatial Splitter] Audio Graph Connected (360 Only)`);
  }

  _apply360(degrees, radius = 1.0) {
    const SPREAD = 45; // Wider spread for better separation

    const angleL = degrees - SPREAD;
    const angleR = degrees + SPREAD;

    const setPosition = (panner, ang, r) => {
      // 0°(Front) -> x=0, z=-1
      const rad = (ang - 90) * (Math.PI / 180);
      const x = r * Math.cos(rad);
      const z = r * Math.sin(rad);

      if (panner.positionX) {
        panner.positionX.setTargetAtTime(x, this.ctx.currentTime, 0.1);
        panner.positionY.setTargetAtTime(0, this.ctx.currentTime, 0.1);
        panner.positionZ.setTargetAtTime(z, this.ctx.currentTime, 0.1);
      } else {
        panner.setPosition(x, 0, z);
      }
    };

    if (this.nodes.hrtfL) setPosition(this.nodes.hrtfL, angleL, radius);
    if (this.nodes.hrtfR) setPosition(this.nodes.hrtfR, angleR, radius);
  }


}

// --- Main Execution ---

const audioGraph = new AudioGraph();
let currentVideo = null;

// Init
console.log("[Spatial Splitter] Content script initialized");
chrome.runtime.sendMessage({ type: "CONTENT_Script_READY" });
scanForVideo();

// Observer
// Polling changed (checks once every 1s)
// This reduces CPU load to near zero
setInterval(() => scanForVideo(), 1000);

function scanForVideo() {
  const video = document.querySelector("video");
  if (video && video !== currentVideo) {
    console.log("[Spatial Splitter] New video detected");
    currentVideo = video;
    audioGraph.init(video);
  }
}

// Messages
// Messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "APPLY_STATE") {

    // 2. Update Tab State & Audio
    // message.mode might be 'speaker'/'binaural' now
    // We treat 'message.mode' as panningMode if it is speaker/binaural
    let panningMode = null;
    if (message.mode === 'speaker' || message.mode === 'binaural') {
      panningMode = message.mode;
    }

    const radius = (typeof message.radius === 'number') ? message.radius : 1.0;
    const angle = (typeof message.angle === 'number') ? message.angle : 0;

    audioGraph.applyState(angle, radius, panningMode);
  }
});