// Content Script

class AudioGraph {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.nodes = {
      stereo: null,
      hrtf: null
    };
    this.mode = 'stereo'; // 'stereo' | '360'
    this.videoElement = null;
    this.isAttached = false;
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

      this.nodes.hrtf = this.ctx.createPanner();
      this.nodes.hrtf.panningModel = 'HRTF';
      this.nodes.hrtf.distanceModel = 'linear';

      // Initial Connect
      this._connectGraph();

      this.videoElement = video;
      this.isAttached = true;
      console.log("[Spatial Splitter] Audio graph constructed");

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
    try { this.nodes.hrtf.disconnect(); } catch (e) { }

    // Connect based on mode
    if (this.mode === '360') {
      this.source.connect(this.nodes.hrtf);
      this.nodes.hrtf.connect(this.ctx.destination);
    } else {
      this.source.connect(this.nodes.stereo);
      this.nodes.stereo.connect(this.ctx.destination);
    }
    console.log(`[Spatial Splitter] Switched to ${this.mode} mode`);
  }

  _apply360(degrees) {
    // 0°(Front) -> x=0, z=-1 (Top view: 0 is -Z)
    // Math 0 is +X (Right).
    // Angle offset: -90 degrees
    const rad = (degrees - 90) * (Math.PI / 180);
    const x = Math.cos(rad);
    const z = Math.sin(rad);

    const panner = this.nodes.hrtf;
    if (panner) {
      const t = this.ctx.currentTime;
      if (panner.positionX) {
        panner.positionX.setTargetAtTime(x, t, 0.1);
        panner.positionY.setTargetAtTime(0, t, 0.1);
        panner.positionZ.setTargetAtTime(z, t, 0.1);
      } else {
        panner.setPosition(x, 0, z);
      }
    }
  }

  _applyStereo(degrees) {
    let pan = degrees / 90;
    if (pan < -1) pan = -1;
    if (pan > 1) pan = 1;

    if (this.nodes.stereo) {
      this.nodes.stereo.pan.setTargetAtTime(pan, this.ctx.currentTime, 0.1);
    }
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
}

// --- Main Execution ---

const audioGraph = new AudioGraph();
let currentVideo = null;

// Init
console.log("[Spatial Splitter] Content script initialized");
chrome.runtime.sendMessage({ type: "CONTENT_Script_READY" });
scanForVideo();

// Observer
const observer = new MutationObserver(() => scanForVideo());
observer.observe(document.body, { childList: true, subtree: true });

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