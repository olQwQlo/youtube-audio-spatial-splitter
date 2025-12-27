// Content Script

class AudioGraph {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.nodes = {
      stereo: null,
      splitter: null, // [NEW] Splits L/R for independent processing
      hrtfL: null,    // [NEW] Virtual Left Speaker
      hrtfR: null     // [NEW] Virtual Right Speaker
    };
    this.mode = 'stereo'; // 'stereo' | '360'
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

      // [NEW] Splitter for Dual Panner implementation
      this.nodes.splitter = this.ctx.createChannelSplitter(2);

      // [NEW] Create two panners for Virtual Stereo Speakers
      const createPanner = () => {
        const p = this.ctx.createPanner();
        p.panningModel = 'HRTF';
        p.distanceModel = 'linear';
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

  setMode(newMode) {
    if (this.mode === newMode) return;
    this.mode = newMode;
    this._connectGraph();
  }

  applyAngle(degrees) {
    if (!this.ctx) return;

    // console.debug(`[AudioGraph] Angle: ${degrees} Mode: ${this.mode}`);

    if (this.mode === '360') {
      this._apply360(degrees);
    } else {
      this._applyStereo(degrees);
    }
  }

  _connectGraph() {
    if (!this.source || !this.ctx) return;

    // Disconnect all
    try { this.source.disconnect(); } catch (e) { }
    try { this.nodes.stereo.disconnect(); } catch (e) { }
    try { this.nodes.splitter.disconnect(); } catch (e) { }
    try { this.nodes.hrtfL.disconnect(); } catch (e) { }
    try { this.nodes.hrtfR.disconnect(); } catch (e) { }

    // Connect based on mode
    if (this.mode === '360') {
      // Source -> Splitter -> Panner L/R -> Destination
      // Implementation of "Virtual Stereo Speakers"
      this.source.connect(this.nodes.splitter);

      // Channel 0 (Left) -> Panner L
      this.nodes.splitter.connect(this.nodes.hrtfL, 0);
      // Channel 1 (Right) -> Panner R
      this.nodes.splitter.connect(this.nodes.hrtfR, 1);

      this.nodes.hrtfL.connect(this.ctx.destination);
      this.nodes.hrtfR.connect(this.ctx.destination);
    } else {
      // Standard Stereo Panner
      this.source.connect(this.nodes.stereo);
      this.nodes.stereo.connect(this.ctx.destination);
    }
    console.log(`[Spatial Splitter] Switched to ${this.mode} mode`);
  }

  _apply360(degrees) {
    const SPREAD = 30; // Degrees. Separation between "Virtual L" and "Virtual R"

    // Calculate angles for Left and Right virtual speakers
    // L is shifted -SPREAD, R is shifted +SPREAD
    const angleL = degrees - SPREAD;
    const angleR = degrees + SPREAD;

    const setPosition = (panner, ang) => {
      // 0°(Front) -> x=0, z=-1 (Top view: 0 is -Z)
      // angle offset: -90 degrees to match Math unit circle
      const rad = (ang - 90) * (Math.PI / 180);
      const x = Math.cos(rad);
      const z = Math.sin(rad);

      if (panner.positionX) {
        panner.positionX.setTargetAtTime(x, this.ctx.currentTime, 0.1);
        panner.positionY.setTargetAtTime(0, this.ctx.currentTime, 0.1);
        panner.positionZ.setTargetAtTime(z, this.ctx.currentTime, 0.1);
      } else {
        panner.setPosition(x, 0, z);
      }
    };

    if (this.nodes.hrtfL) setPosition(this.nodes.hrtfL, angleL);
    if (this.nodes.hrtfR) setPosition(this.nodes.hrtfR, angleR);
  }

  _applyStereo(degrees) {
    let pan = degrees / 90;
    if (pan < -1) pan = -1;
    if (pan > 1) pan = 1;

    if (this.nodes.stereo) {
      this.nodes.stereo.pan.setTargetAtTime(pan, this.ctx.currentTime, 0.1);
    }
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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "APPLY_STATE") {
    if (message.mode) {
      audioGraph.setMode(message.mode);
    }
    if (typeof message.angle === 'number') {
      audioGraph.applyAngle(message.angle);
    }
  }
});