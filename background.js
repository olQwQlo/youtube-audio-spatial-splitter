// Background Service Worker

// State
let activeVideoTabs = new Set(); // tabIds that are audible and on YouTube
let tabAngles = new Map(); // tabId -> angle (degrees), default 0
let audioMode = 'stereo'; // 'stereo' | '360'

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
  // No need to update others, as positions are absolute now
});

// Activate Tab - Just purely for tracking if we needed it, but for manual mode it's less critical
// We keep tracking it to ensure state is consistent if needed
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await tryGetTab(activeInfo.tabId);
  if (tab && isYouTubeTab(tab) && activeVideoTabs.has(activeInfo.tabId)) {
    // Maybe ensure angle is applied?
    applyStateToTab(activeInfo.tabId);
  }
});

// Messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_STATUS") {
    // Send back active tabs and their current angles
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
    }
  }
  else if (message.type === "SET_MODE") {
    audioMode = message.mode;
    // Broadcast new mode to all active tabs
    for (const tabId of activeVideoTabs) {
      applyStateToTab(tabId);
    }
  }
  else if (message.type === "CONTENT_Script_READY") {
    if (sender.tab) {
      checkAndTrackTab(sender.tab);
      // Force re-apply angle if we have one, or default 0
      applyStateToTab(sender.tab.id);
    }
  }
});

// --- Logic ---

function isYouTubeTab(tab) {
  return tab.url && (tab.url.includes("youtube.com") || tab.url.includes("youtu.be"));
}

function checkAndTrackTab(tab) {
  if (!tab) return;

  const isYT = isYouTubeTab(tab);
  const isAudible = tab.audible;

  if (isYT && isAudible) {
    if (!activeVideoTabs.has(tab.id)) {
      activeVideoTabs.add(tab.id);
      // Initialize angle if not present
      if (!tabAngles.has(tab.id)) {
        tabAngles.set(tab.id, 0);
      }
      applyStateToTab(tab.id);
    }
  } else {
    // If lost audible status or navigated away
    if (activeVideoTabs.has(tab.id)) {
      activeVideoTabs.delete(tab.id);
      tabAngles.delete(tab.id);
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
