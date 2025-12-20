// Content Script

let audioCtx;
let source;
let currentVideoElement = null;

// Audio Nodes
let stereoPanner;
let hrtfPanner;
let currentMode = 'stereo'; // 'stereo' | '360'

// Initialize when page loads (or when this script is injected)
initialize();

// Also watch for navigation (SPA) or video element changes
const observer = new MutationObserver((mutations) => {
  checkForVideo();
});
observer.observe(document.body, { childList: true, subtree: true });

function initialize() {
  console.log("[Spatial Splitter] Content script initialized");
  // Notify background immediately
  chrome.runtime.sendMessage({ type: "CONTENT_Script_READY" });
  checkForVideo();
}

function checkForVideo() {
  // YouTube uses a main video element usually with class 'video-stream html5-main-video'
  // But simple 'video' query is safer.
  const video = document.querySelector("video");

  // Case A: New video element found
  if (video && video !== currentVideoElement) {
    console.log("[Spatial Splitter] Video element found / changed");
    setupAudio(video);
  }
}

function setupAudio(video) {
  if (video._spatialSplitterAttached) return;

  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    // Resume context on user interaction if needed
    if (audioCtx.state === 'suspended') {
      const resume = () => {
        audioCtx.resume();
        window.removeEventListener('click', resume);
        window.removeEventListener('keydown', resume);
      };
      window.addEventListener('click', resume);
      window.addEventListener('keydown', resume);
    }

    // Connect nodes
    // Note: If the page already has WebAudio hooked to this video (unlikely for raw YT, but possible in some apps),
    // MediaElementSource might throw if re-connected. 
    // However, for standard YouTube, we are usually the first/only ones if we run early.
    // YouTube uses Media Source Extensions (MSE) but usually outputs to a generic AudioDestination unless they use WebAudio themselves.
    // Most reports say createMediaElementSource works on YT.

    source = audioCtx.createMediaElementSource(video);

    // Create Nodes
    stereoPanner = audioCtx.createStereoPanner();

    // HRTF Panner Setup
    hrtfPanner = audioCtx.createPanner();
    hrtfPanner.panningModel = 'HRTF';
    hrtfPanner.distanceModel = 'linear';

    // Connect default
    connectGraph(currentMode);

    video._spatialSplitterAttached = true;
    currentVideoElement = video;
    console.log("[Spatial Splitter] Audio graph constructed");

  } catch (e) {
    console.error("[Spatial Splitter] Error setting up audio:", e);
  }
}

function connectGraph(mode) {
  if (!source || !audioCtx) return;

  // Disconnect everything first
  try { source.disconnect(); } catch (e) { }
  try { stereoPanner.disconnect(); } catch (e) { }
  try { hrtfPanner.disconnect(); } catch (e) { }

  currentMode = mode;

  if (mode === '360') {
    source.connect(hrtfPanner);
    hrtfPanner.connect(audioCtx.destination);
  } else {
    source.connect(stereoPanner);
    stereoPanner.connect(audioCtx.destination);
  }

  console.log(`[Spatial Splitter] Switched to ${mode} mode`);
}

// Handle Messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "APPLY_STATE") {
    // Check mode change
    if (message.mode && message.mode !== currentMode) {
      connectGraph(message.mode);
    }
    // Apply angle
    applyAngle(message.angle);
  }
});

function applyAngle(degrees) {
  if (!audioCtx) return;

  // console.log(`[Spatial Splitter] applyAngle called: ${ degrees }° Mode: ${ currentMode } `);

  if (currentMode === '360') {
    // 360 Mode (PannerNode)
    // Math convention: 0 is Right (x=1, z=0). 
    // Our 0 is Top/Front (x=0, z=-1).
    // Angle offset = -90 degrees.

    const rad = (degrees - 90) * (Math.PI / 180);
    // PannerNode (HRTF) coordinate system:
    // X: Right positive, Left negative
    // Y: Up positive, Down negative
    // Z: Front negative, Back positive (Right-handed system usually, but check browser implementation)
    // Actually standard WebAudio: 
    // +X is Right
    // +Y is Up
    // +Z is Behind listener (Out of screen) -> So -Z is Front.

    const x = Math.cos(rad);
    const z = Math.sin(rad);

    if (hrtfPanner) {
      const time = audioCtx.currentTime;
      if (hrtfPanner.positionX) {
        hrtfPanner.positionX.setTargetAtTime(x, time, 0.1);
        hrtfPanner.positionY.setTargetAtTime(0, time, 0.1);
        hrtfPanner.positionZ.setTargetAtTime(z, time, 0.1);
      } else {
        hrtfPanner.setPosition(x, 0, z);
      }
      // console.log(`[Spatial Splitter]360 Panner set: x = ${ x.toFixed(2) }, z = ${ z.toFixed(2) } `);
    }

  } else {
    // Stereo Mode (StereoPannerNode)
    let panValue = degrees / 90;
    if (panValue < -1) panValue = -1;
    if (panValue > 1) panValue = 1;

    if (stereoPanner) {
      stereoPanner.pan.setTargetAtTime(panValue, audioCtx.currentTime, 0.1);
      // console.log(`[Spatial Splitter] Stereo Panner set: ${ panValue.toFixed(2) } `);
    }
  }
}