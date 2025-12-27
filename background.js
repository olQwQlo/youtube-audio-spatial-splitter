// Background Service Worker

class StateManager {
  constructor() {
    this.activeVideoTabs = new Set();
    this.tabStates = new Map(); // [NEW] Map<tabId, {angle, radius, mode}>

    this.STORAGE_KEY_STATES = 'tabStates'; // [NEW]
    this.STORAGE_KEY_ANGLES = 'tabAngles'; // Legacy
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
    const data = await chrome.storage.local.get([this.STORAGE_KEY_STATES, this.STORAGE_KEY_ANGLES]);

    // 1. Try load new states
    if (data[this.STORAGE_KEY_STATES]) {
      for (const [key, value] of Object.entries(data[this.STORAGE_KEY_STATES])) {
        this.tabStates.set(parseInt(key), value);
      }
    }
    // 2. Fallback to legacy angles if text state missing
    else if (data[this.STORAGE_KEY_ANGLES]) {
      for (const [key, angle] of Object.entries(data[this.STORAGE_KEY_ANGLES])) {
        this.tabStates.set(parseInt(key), { angle: angle, radius: 1.0, mode: 'speaker' });
      }
    }
  }

  _save() {
    const statesObj = Object.fromEntries(this.tabStates);
    chrome.storage.local.set({
      [this.STORAGE_KEY_STATES]: statesObj
    });
  }

  checkAndTrack(tab) {
    if (!tab) return;
    const isYT = tab.url && (tab.url.includes("youtube.com") || tab.url.includes("youtu.be"));
    const isAudible = tab.audible;

    if (isYT) {
      // Add if audible. If already tracked, keep tracking even if paused.
      if (isAudible || this.activeVideoTabs.has(tab.id)) {
        if (!this.activeVideoTabs.has(tab.id)) {
          this.activeVideoTabs.add(tab.id);
          // Init state if needed
          if (!this.tabStates.has(tab.id)) {
            this.tabStates.set(tab.id, { angle: 0, radius: 1.0, mode: 'speaker' });
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
      this.tabStates.delete(tabId);
      this._save();
    }
  }

  setState(tabId, newState) {
    if (this.activeVideoTabs.has(tabId)) {
      // Merge with existing
      const current = this.tabStates.get(tabId) || { angle: 0, radius: 1.0, mode: 'speaker' };
      this.tabStates.set(tabId, { ...current, ...newState });
      this.broadcastStateToTab(tabId);
    }
  }



  getStatus() {
    return {
      activeVideoTabs: Array.from(this.activeVideoTabs),
      tabStates: Object.fromEntries(this.tabStates)
    };
  }

  async broadcastStateToTab(tabId) {
    const state = this.tabStates.get(tabId) || { angle: 0, radius: 1.0, mode: 'speaker' };
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "APPLY_STATE",
        angle: state.angle,
        radius: state.radius,
        mode: state.mode
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

self.addEventListener('fetch', () => {
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.audible !== undefined || changeInfo.url) {
    stateManager.checkAndTrack(tab);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  stateManager.removeTab(tabId);
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await tryGetTab(activeInfo.tabId);
  if (tab) {
    stateManager.checkAndTrack(tab);
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
  else if (message.type === "SET_STATE") { // [NEW]
    const { tabId, angle, radius, mode } = message;
    stateManager.setState(tabId, { angle, radius, mode });
  }
  else if (message.type === "SET_ANGLE") { // [Legacy Support]
    stateManager.setState(message.tabId, { angle: message.angle });
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
  return true;
});

// Helper
async function tryGetTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (e) {
    return null;
  }
}
