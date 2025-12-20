// Background Service Worker

class StateManager {
  constructor() {
    this.activeVideoTabs = new Set();
    this.tabAngles = new Map();
    this.audioMode = 'stereo';

    this.STORAGE_KEY_ANGLES = 'tabAngles';
    this.STORAGE_KEY_MODE = 'audioMode';
  }

  async init() {
    await this._load();

    // Re-scan tabs to recover active state
    const tabs = await chrome.tabs.query({ url: "*://*.youtube.com/*" });
    for (const tab of tabs) {
      this.checkAndTrack(tab);
    }
  }

  async _load() {
    const data = await chrome.storage.local.get([this.STORAGE_KEY_ANGLES, this.STORAGE_KEY_MODE]);
    if (data[this.STORAGE_KEY_ANGLES]) {
      for (const [key, value] of Object.entries(data[this.STORAGE_KEY_ANGLES])) {
        this.tabAngles.set(parseInt(key), value);
      }
    }
    if (data[this.STORAGE_KEY_MODE]) {
      this.audioMode = data[this.STORAGE_KEY_MODE];
    }
  }

  _save() {
    const anglesObj = Object.fromEntries(this.tabAngles);
    chrome.storage.local.set({
      [this.STORAGE_KEY_ANGLES]: anglesObj,
      [this.STORAGE_KEY_MODE]: this.audioMode
    });
  }

  checkAndTrack(tab) {
    if (!tab) return;
    const isYT = tab.url && (tab.url.includes("youtube.com") || tab.url.includes("youtu.be"));
    const isAudible = tab.audible;

    if (isYT) {
      // Add if audible. If already tracked, keep tracking even if paused (not audible).
      if (isAudible || this.activeVideoTabs.has(tab.id)) {
        if (!this.activeVideoTabs.has(tab.id)) {
          this.activeVideoTabs.add(tab.id);
          // Init angle if needed
          if (!this.tabAngles.has(tab.id)) {
            this.tabAngles.set(tab.id, 0);
          }
          this.broadcastStateToTab(tab.id);
        }
      }
    } else {
      this.removeTab(tab.id);
    }
  }

  removeTab(tabId) {
    if (this.activeVideoTabs.has(tabId)) {
      this.activeVideoTabs.delete(tabId);
      // We can choose to keep angle config or delete it.
      // Current strict logic: delete.
      this.tabAngles.delete(tabId);
      this._save();
    }
  }

  setAngle(tabId, angle) {
    if (this.activeVideoTabs.has(tabId)) {
      this.tabAngles.set(tabId, angle);
      this.broadcastStateToTab(tabId);
      // this._save(); // Removed for performance. Save only on drag end.
    }
  }

  setMode(mode) {
    this.audioMode = mode;
    this._save();
    // Broadcast to all
    for (const tabId of this.activeVideoTabs) {
      this.broadcastStateToTab(tabId);
    }
  }

  getStatus() {
    return {
      activeVideoTabs: Array.from(this.activeVideoTabs),
      tabAngles: Object.fromEntries(this.tabAngles),
      audioMode: this.audioMode
    };
  }

  async broadcastStateToTab(tabId) {
    const angle = this.tabAngles.get(tabId) || 0;
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "APPLY_STATE",
        angle: angle,
        mode: this.audioMode
      });
    } catch (e) {
      // Tab might be loading or closed
    }
  }
}

// --- Main Execution ---

const stateManager = new StateManager();
stateManager.init();

// --- Event Listeners ---

// Fix for "navigation preload request was cancelled" error
// The error often happens when an extension has 'webNavigation' or other permissions
// that trigger a worker wake-up for a fetch, but doesn't handle it.
// Adding an empty fetch listener can sometimes stabilize this,
// though technically Manifest V3 handles fetches differently.
// However, the error usually indicates the worker was killed mid-request.
self.addEventListener('fetch', () => {
  // Pass-through
});

// Update Tab (Audible / URL / Status)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.audible !== undefined || changeInfo.url) {
    stateManager.checkAndTrack(tab);
  }
});

// Remove Tab
chrome.tabs.onRemoved.addListener((tabId) => {
  stateManager.removeTab(tabId);
});

// Activate Tab - Just purely for tracking if we needed it, but for manual mode it's less critical
// We keep tracking it to ensure state is consistent if needed
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await tryGetTab(activeInfo.tabId);
  if (tab) {
    stateManager.checkAndTrack(tab); // Refresh state
    // Force update to ensure sound is right
    if (stateManager.activeVideoTabs.has(activeInfo.tabId)) {
      stateManager.broadcastStateToTab(activeInfo.tabId);
    }
  }
});

// Messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_STATUS") {
    sendResponse(stateManager.getStatus());
  }
  else if (message.type === "SET_ANGLE") {
    stateManager.setAngle(message.tabId, message.angle);
  }
  else if (message.type === "SET_MODE") {
    stateManager.setMode(message.mode);
  }
  else if (message.type === "PERSIST_STATE") {
    stateManager._save();
  }
  else if (message.type === "CONTENT_Script_READY") {
    if (sender.tab) {
      stateManager.checkAndTrack(sender.tab);
      stateManager.broadcastStateToTab(sender.tab.id);
    }
  }
  return true; // Keep channel open for async response if needed
});

// Helper
async function tryGetTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (e) {
    return null;
  }
}
