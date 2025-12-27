// Popup App Logic

class PopupApp {
  constructor() {
    // State
    this.currentTabs = [];
    this.tabAngles = {};
    this.selectedTabId = null;
    this.audioMode = 'stereo';

    // Dragging state
    this.isDragging = false;
    this.hasDragged = false; // [NEW] Distinguish click vs drag
    this.draggingTabId = null;

    // DOM Elements
    this.ui = {
      tabList: document.getElementById('tab-list'),
      radarContainer: document.getElementById('radar-container'),
      refreshBtn: document.getElementById('refresh'),
      modeToggle: document.getElementById('mode-toggle')
    };

    // Constants
    this.RADAR_RADIUS = 100;
    this.CENTER_X = 140;
    this.CENTER_Y = 140;

    // Throttled message sender
    this.throttledSendMessage = this.throttle((tabId, angle) => {
      chrome.runtime.sendMessage({
        type: "SET_ANGLE",
        tabId: tabId,
        angle: angle
      });
    }, 50); // 50ms throttle
  }

  init() {
    this.ui.refreshBtn.addEventListener('click', () => this.refresh());
    this.ui.modeToggle.addEventListener('change', (e) => this.toggleMode(e));

    // Radar interaction: MouseDown for seamless move+drag
    this.ui.radarContainer.addEventListener('mousedown', (e) => this.handleRadarBackgroundMouseDown(e));

    // Dragging
    document.addEventListener('mouseup', () => this.stopDragging());
    document.addEventListener('mousemove', (e) => this.handleDrag(e));

    // Initial Load
    this.refresh();
  }

  async refresh() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
      if (!response) {
        this.renderError("Cannot connect to background service");
        return;
      }

      const { activeVideoTabs, tabAngles, audioMode } = response;
      this.tabAngles = tabAngles || {};
      this.audioMode = audioMode || 'stereo';
      this.ui.modeToggle.checked = (this.audioMode === '360');

      this.currentTabs = [];
      for (const tabId of activeVideoTabs) {
        try {
          const tab = await chrome.tabs.get(tabId);
          this.currentTabs.push(tab);
        } catch (e) {
          // Tab might be closed during fetch
          console.warn("Tab not found", tabId);
        }
      }

      this.render();
    } catch (e) {
      this.renderError(e.message);
    }
  }

  async toggleMode(e) {
    const is360 = e.target.checked;
    this.audioMode = is360 ? '360' : 'stereo';
    await chrome.runtime.sendMessage({ type: "SET_MODE", mode: this.audioMode });
    this.render();
  }

  render() {
    this.renderList();
    this.renderRadar();
  }

  renderList() {
    this.ui.tabList.innerHTML = '';

    if (this.currentTabs.length === 0) {
      this.ui.tabList.innerHTML = '<div class="empty-state">No YouTube sounds detected</div>';
      return;
    }

    this.currentTabs.forEach(tab => {
      const item = document.createElement('div');
      item.className = `tab-item ${this.selectedTabId === tab.id ? 'selected' : ''}`;
      item.dataset.tabId = tab.id; // Identifier for direct update
      item.onclick = () => this.selectTab(tab.id);

      const title = document.createElement('div');
      title.className = 'tab-title';
      title.textContent = tab.title;
      title.title = tab.title;

      const meta = document.createElement('div');
      meta.className = 'tab-meta';
      const angle = Math.round(this.tabAngles[tab.id] || 0);
      meta.textContent = `${angle}°`;

      item.appendChild(title);
      item.appendChild(meta);
      this.ui.tabList.appendChild(item);
    });
  }

  renderRadar() {
    // Clear dots
    const existingDots = this.ui.radarContainer.querySelectorAll('.audio-dot');
    existingDots.forEach(dot => dot.remove());

    this.currentTabs.forEach(tab => {
      const dot = document.createElement('div');
      dot.className = `audio-dot ${this.selectedTabId === tab.id ? 'selected' : ''}`;
      dot.dataset.tabId = tab.id; // Identifier for direct update
      const angleVal = this.tabAngles[tab.id] || 0;
      dot.title = `${tab.title} (${Math.round(angleVal)}°)`;

      const pos = this.calculateDotPosition(angleVal);
      dot.style.left = pos.x + 'px';
      dot.style.top = pos.y + 'px';

      dot.onmousedown = (e) => {
        // Prevent background handler from firing
        // But allow startDragging to work
        e.stopPropagation();
        this.startDragging(e, tab.id);
      };

      this.ui.radarContainer.appendChild(dot);
    });
  }

  renderError(msg) {
    this.ui.tabList.innerHTML = `<div class="error">Error: ${msg}</div>`;
  }

  selectTab(tabId) {
    this.selectedTabId = tabId;
    this.render();
  }

  // --- Drag Logic ---

  startDragging(e, tabId) {
    this.isDragging = true;
    this.hasDragged = false; // Reset drag flag
    this.draggingTabId = tabId;
    this.selectTab(tabId);
    e.preventDefault();
  }

  stopDragging() {
    // If was dragging, save state
    if (this.isDragging) {
      chrome.runtime.sendMessage({ type: "PERSIST_STATE" });
    }

    this.isDragging = false;
    this.draggingTabId = null;

    // Note: We don't reset hasDragged here immediately because 'click' fires after 'mouseup'.
    // We let the click handler check hasDragged, then it's done.
    setTimeout(() => { this.hasDragged = false; }, 100);
  }

  handleDrag(e) {
    if (!this.isDragging || !this.draggingTabId) return;

    this.hasDragged = true; // Mark as actual drag movement

    const rect = this.ui.radarContainer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const newAngle = this.calculateAngleFromPosition(x, y);
    this.tabAngles[this.draggingTabId] = newAngle;

    // Optimized Update: Direct DOM manipulation + Throttled IPC
    this.updateUiForTab(this.draggingTabId);
    this.throttledSendMessage(this.draggingTabId, newAngle);
  }

  // --- Click Logic ---
  handleRadarBackgroundMouseDown(e) {
    // 1. Must have a selected tab
    if (!this.selectedTabId) return;

    // 2. Move the selected tab to this position immediately
    const rect = this.ui.radarContainer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const newAngle = this.calculateAngleFromPosition(x, y);
    this.tabAngles[this.selectedTabId] = newAngle;

    this.updateUiForTab(this.selectedTabId);
    this.throttledSendMessage(this.selectedTabId, newAngle);

    // 3. Enter drag mode immediately
    this.startDragging(e, this.selectedTabId);
  }

  // Direct DOM update to avoid full re-render
  updateUiForTab(tabId) {
    const angle = this.tabAngles[tabId] || 0;

    // 1. Update List Item Text
    const listItem = this.ui.tabList.querySelector(`.tab-item[data-tab-id="${tabId}"] .tab-meta`);
    if (listItem) {
      listItem.textContent = `${Math.round(angle)}°`;
    }

    // 2. Update Radar Dot Position
    const dot = this.ui.radarContainer.querySelector(`.audio-dot[data-tab-id="${tabId}"]`);
    if (dot) {
      const pos = this.calculateDotPosition(angle);
      dot.style.left = pos.x + 'px';
      dot.style.top = pos.y + 'px';
      // Update title tooltips if needed, but maybe skipping for perf is fine?
      // dot.title = ... (Accessing tab title requires lookup, maybe skip for drag perf)
    }
  }

  // --- Math ---

  calculateDotPosition(angleDeg) {
    // 0 degrees is UP (Front).
    // -90 is Left, 90 is Right.
    // In Math/Canvas: 0 is Right (3 o'clock), -90 is Top (12 o'clock).
    // So: MathAngle = AngleDeg - 90
    const mathAngleRad = (angleDeg - 90) * (Math.PI / 180);
    const x = this.CENTER_X + this.RADAR_RADIUS * Math.cos(mathAngleRad);
    const y = this.CENTER_Y + this.RADAR_RADIUS * Math.sin(mathAngleRad);
    return { x, y };
  }

  calculateAngleFromPosition(x, y) {
    // Mouse relative to container center
    const dx = x - this.CENTER_X;
    const dy = y - this.CENTER_Y;

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
    if (this.audioMode === 'stereo') {
      // Clamp to -90...90 (Front hemisphere only)
      if (customDeg < -90) customDeg = -90;
      if (customDeg > 90) customDeg = 90;
    }
    // If '360', no clamp (-180 to 180 is fine)
    return customDeg;
  }

  // --- Utils ---

  throttle(func, limit) {
    let inThrottle;
    return function () {
      const args = arguments;
      const context = this;
      if (!inThrottle) {
        func.apply(context, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    }
  }
}

// Start
document.addEventListener('DOMContentLoaded', () => {
  const app = new PopupApp();
  app.init();
});
