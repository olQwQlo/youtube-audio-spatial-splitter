// Background Service Worker

// State
let activeVideoTabs = new Set(); // tabIds that are audible and on YouTube
let tabAngles = new Map(); // tabId -> angle (degrees), default 0
let audioMode = 'stereo'; // 'stereo' | '360'

// --- Storage & Initialization ---

async function loadState() {
  const data = await chrome.storage.local.get(['tabAngles', 'audioMode']);
  if (data.tabAngles) {
    // Convert object back to Map (keys are strings in JSON)
    for (const [key, value] of Object.entries(data.tabAngles)) {
      tabAngles.set(parseInt(key), value);
    }
  }
  if (data.audioMode) {
    audioMode = data.audioMode;
  }

  // Re-scan for active tabs
  const tabs = await chrome.tabs.query({ url: "*://*.youtube.com/*" });
  for (const tab of tabs) {
    checkAndTrackTab(tab);
  }
}

function saveState() {
  const anglesObj = Object.fromEntries(tabAngles);
  chrome.storage.local.set({
    tabAngles: anglesObj,
    audioMode: audioMode
  });
}

// Initialize on start
loadState();

// --- Event Listeners ---

// Fix for "navigation preload request was cancelled" error
// The error often happens when an extension has 'webNavigation' or other permissions
// that trigger a worker wake-up for a fetch, but doesn't handle it.
// Adding an empty fetch listener can sometimes stabilize this,
// though technically Manifest V3 handles fetches differently.
// However, the error usually indicates the worker was killed mid-request.
self.addEventListener('fetch', (event) => {
  // Pass-through
});

// Update Tab (Audible / URL / Status)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.audible !== undefined || changeInfo.url) {
    checkAndTrackTab(tab);
  }
});

// Remove Tab
chrome.tabs.onRemoved.addListener((tabId) => {
  activeVideoTabs.delete(tabId);
  tabAngles.delete(tabId); // Clean up state
  saveState();
});

// Activate Tab - Just purely for tracking if we needed it, but for manual mode it's less critical
// We keep tracking it to ensure state is consistent if needed
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await tryGetTab(activeInfo.tabId);
  if (tab && isYouTubeTab(tab) && activeVideoTabs.has(activeInfo.tabId)) {
    // Ensure angle is applied if needed
    applyStateToTab(activeInfo.tabId);
  }
});

// Messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_STATUS") {
    // If we just woke up and haven't scanned yet, we might return empty.
    // But loadState() is async. Popup handles 'Loading...' UI?
    // Let's rely on activeVideoTabs logic.
    const anglesObj = Object.fromEntries(tabAngles);
    sendResponse({
      activeVideoTabs: Array.from(activeVideoTabs),
      tabAngles: anglesObj,
      audioMode: audioMode
    });
  }
  else if (message.type === "SET_ANGLE") {
    const { tabId, angle } = message;
    if (activeVideoTabs.has(tabId)) {
      tabAngles.set(tabId, angle);
      applyStateToTab(tabId);
      saveState();
    }
  }
  else if (message.type === "SET_MODE") {
    audioMode = message.mode;
    saveState();
    // Broadcast new mode to all active tabs
    for (const tabId of activeVideoTabs) {
      applyStateToTab(tabId);
    }
  }
  else if (message.type === "CONTENT_Script_READY") {
    if (sender.tab) {
      checkAndTrackTab(sender.tab);
      applyStateToTab(sender.tab.id);
    }
  }
  return true; // Keep channel open for async response if needed
});

// --- Logic ---

function isYouTubeTab(tab) {
  return tab.url && (tab.url.includes("youtube.com") || tab.url.includes("youtu.be"));
}

function checkAndTrackTab(tab) {
  if (!tab) return;

  const isYT = isYouTubeTab(tab);
  const isAudible = tab.audible;

  // Track if audible OR if we have a saved angle for it (meaning user manually set it)
  // Logic: 
  // - If it's YouTube AND Audible -> Track it.
  // - If it's YouTube AND NOT Audible BUT matches a known active tab -> Keep tracking unless closed?
  // Problem: Non-audible tabs (paused) might want to be kept in the list?
  // User says "disappear from popup menu". If paused, 'audible' goes false.
  // We should probably keep tracking if it's YouTube and we've seen it play before, 
  // OR rely on content script telling us it's ready.
  // Maybe only list if Content Script says "I have a video element".
  // The current content script sends CONTENT_Script_READY when initialized.
  // Let's trust that signal heavily.

  // Strategy:
  // 1. If we see a YT tab that is audible, add it.
  // 2. If a tracked tab becomes non-audible, KEEP it in the list (don't delete) until it's closed or navigated away.

  if (isYT) {
    if (isAudible) {
      if (!activeVideoTabs.has(tab.id)) {
        activeVideoTabs.add(tab.id);
        // Initialize angle if not present
        if (!tabAngles.has(tab.id)) {
          tabAngles.set(tab.id, 0);
        }
        applyStateToTab(tab.id);
      }
    } else {
      // It's YT but not audible.
      // If it was already active, we keep it active.
      // This solves "paused video disappears".

      // However, if we refresh extension, we scan tabs. If paused, isAudible is false.
      // Then we won't add it.
      // Fix: If we rely on ContentScriptReady, we add it regardless of audible?
      // But we don't want to list EVERY YouTube tab (e.g. search results).
      // Maybe only list if Content Script says "I have a video element".
      // The current content script sends CONTENT_Script_READY when initialized.
      // Let's trust that signal heavily.
    }
  } else {
    // Not YouTube anymore
    if (activeVideoTabs.has(tab.id)) {
      activeVideoTabs.delete(tab.id);
      // Don't delete angles immediately, maybe user navigates back?
      // But for now clear it to be clean.
      // tabAngles.delete(tab.id); 
      // saveState();
    }
  }
}

async function applyStateToTab(tabId) {
  const angle = tabAngles.get(tabId) || 0;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "APPLY_STATE",
      angle: angle,
      mode: audioMode
    });
  } catch (e) {
    // Content script might not be ready
  }
}

async function tryGetTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (e) {
    return null;
  }
}
