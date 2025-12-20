// Popup Logic

// State
let currentTabs = [];
let tabAngles = {};
let selectedTabId = null;
let audioMode = 'stereo'; // 'stereo' | '360'

// DOM Elements
const tabListEl = document.getElementById('tab-list');
const radarContainerEl = document.getElementById('radar-container');
const refreshBtn = document.getElementById('refresh');
const modeToggleEl = document.getElementById('mode-toggle');

// Init
document.addEventListener('DOMContentLoaded', () => {
  refresh();
  refreshBtn.addEventListener('click', refresh);
  modeToggleEl.addEventListener('change', toggleMode);

  // Global mouse up to stop dragging anywhere
  document.addEventListener('mouseup', stopDragging);
  document.addEventListener('mousemove', handleDrag);
});

async function refresh() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    if (!response) {
      renderError("Cannot connect to background service");
      return;
    }

    const { activeVideoTabs, tabAngles: savedAngles, audioMode: savedMode } = response;
    tabAngles = savedAngles || {};
    audioMode = savedMode || 'stereo';
    modeToggleEl.checked = (audioMode === '360');

    // Fetch tab details
    currentTabs = [];
    for (const tabId of activeVideoTabs) {
      try {
        const tab = await chrome.tabs.get(tabId);
        currentTabs.push(tab);
      } catch (e) {
        console.warn("Tab not found", tabId);
      }
    }

    render();
  } catch (e) {
    renderError(e.message);
  }
}

async function toggleMode(e) {
  const is360 = e.target.checked;
  audioMode = is360 ? '360' : 'stereo';

  // Notify background
  await chrome.runtime.sendMessage({
    type: "SET_MODE",
    mode: audioMode
  });

  // Re-render (constraints might change)
  render();
}

function renderError(msg) {
  tabListEl.innerHTML = `<div class="error">Error: ${msg}</div>`;
}

function render() {
  renderList();
  renderRadar();
}

// --- List Render ---
function renderList() {
  tabListEl.innerHTML = '';

  if (currentTabs.length === 0) {
    tabListEl.innerHTML = '<div class="empty-state">No YouTube sounds detected</div>';
    return;
  }

  currentTabs.forEach(tab => {
    const item = document.createElement('div');
    item.className = `tab-item ${selectedTabId === tab.id ? 'selected' : ''}`;
    item.onclick = () => selectTab(tab.id);

    const title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = tab.title;
    title.title = tab.title;

    const meta = document.createElement('div');
    meta.className = 'tab-meta';
    const angle = Math.round(tabAngles[tab.id] || 0);
    meta.textContent = `${angle}°`;

    item.appendChild(title);
    item.appendChild(meta);
    tabListEl.appendChild(item);
  });
}

function selectTab(tabId) {
  selectedTabId = tabId;
  render(); // Re-render to update selection styles
}

// --- Radar Render ---
function renderRadar() {
  // Clear existing dots (keep background elements)
  const existingDots = radarContainerEl.querySelectorAll('.audio-dot');
  existingDots.forEach(dot => dot.remove());

  currentTabs.forEach(tab => {
    const dot = document.createElement('div');
    dot.className = `audio-dot ${selectedTabId === tab.id ? 'selected' : ''}`;
    dot.title = `${tab.title} (${Math.round(tabAngles[tab.id] || 0)}°)`;

    // Calculate position
    const angleDeg = tabAngles[tab.id] || 0;
    const position = calculateDotPosition(angleDeg);

    dot.style.left = position.x + 'px';
    dot.style.top = position.y + 'px';

    // Events
    dot.onmousedown = (e) => startDragging(e, tab.id);
    dot.onclick = (e) => {
      e.stopPropagation();
      selectTab(tab.id);
    };

    radarContainerEl.appendChild(dot);
  });
}

// --- Geometry ---
const RADAR_RADIUS = 100; // Radius of the dot circle
const CENTER_X = 140; // 280 / 2
const CENTER_Y = 140; // 280 / 2

function calculateDotPosition(angleDeg) {
  // Ensure angle is between -180 and 180 (though we mostly use front -90 to 90)
  // 0 degrees is UP (Front).
  // -90 is Left, 90 is Right.
  // In Math/Canvas: 0 is Right (3 o'clock), -90 is Top (12 o'clock).
  // So: MathAngle = AngleDeg - 90

  const mathAngleRad = (angleDeg - 90) * (Math.PI / 180);

  const x = CENTER_X + RADAR_RADIUS * Math.cos(mathAngleRad);
  const y = CENTER_Y + RADAR_RADIUS * Math.sin(mathAngleRad);

  return { x, y };
}

function calculateAngleFromPosition(x, y) {
  // Mouse relative to container center
  const dx = x - CENTER_X;
  const dy = y - CENTER_Y;

  // atan2(y, x) returns angle in radians from X axis (Right)
  let rad = Math.atan2(dy, dx);
  let deg = rad * (180 / Math.PI);

  // Convert back to our coordinate system:
  // Math 0 (Right) -> Our 90
  // Math -90 (Top) -> Our 0
  // OurDeg = MathDeg + 90
  let customDeg = deg + 90;

  // Normalize to -180...180
  if (customDeg > 180) customDeg -= 360;
  if (customDeg < -180) customDeg += 360;

  // Constraints based on Mode
  if (audioMode === 'stereo') {
    // Clamp to -90...90 (Front hemisphere only)
    if (customDeg < -90) customDeg = -90;
    if (customDeg > 90) customDeg = 90;
  }
  // If '360', no clamp (-180 to 180 is fine)

  return customDeg;
}

// --- Dragging ---
let isDragging = false;
let draggingTabId = null;

function startDragging(e, tabId) {
  isDragging = true;
  draggingTabId = tabId;
  selectTab(tabId); // Auto select
  e.preventDefault(); // Stop text selection
}

function stopDragging() {
  if (!isDragging) return;
  isDragging = false;
  draggingTabId = null;

  // Final render to snap if needed (though we update live)
  render();
}

function handleDrag(e) {
  if (!isDragging || !draggingTabId) return;

  // Get mouse position relative to radar container
  const rect = radarContainerEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  // Calculate new angle
  let newAngle = calculateAngleFromPosition(x, y);

  // Update local state
  tabAngles[draggingTabId] = newAngle;

  // Update UI immediately (smooth drag)
  render(); // Or just update the specific dot for performance, but render() is fast enough for <10 items

  // access list item to update text? render() does it.

  // Send to background
  // Throttle this? Maybe. But Chrome messaging is fast enough for UI events usually.
  chrome.runtime.sendMessage({
    type: "SET_ANGLE",
    tabId: draggingTabId,
    angle: newAngle
  });
}
