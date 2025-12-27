// Popup App Logic

class PopupApp {
  constructor() {
    // State
    this.currentTabs = [];
    this.tabAngles = {}; // Legacy simple map, kept for safety but tabStates is source of truth
    this.tabStates = {}; // [NEW] { tabId: { angle, radius, mode } }
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
    this.RADAR_RADIUS = 135; // Visual max radius (Container is 280px -> R=140, minus padding)
    this.CENTER_X = 140;
    this.CENTER_Y = 140;

    // Throttled message sender
    this.throttledSendMessage = this.throttle((tabId) => {
      this.sendState(tabId);
    }, 50); // 50ms throttle
  }

  sendState(tabId) {
    if (!this.tabStates[tabId]) return;
    const { angle, radius, mode } = this.tabStates[tabId];
    chrome.runtime.sendMessage({
      type: "SET_STATE", // New comprehensive message type
      tabId: tabId,
      angle: angle,
      radius: radius,
      mode: mode
    });
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

      const { activeVideoTabs, tabStates, audioMode } = response;

      this.tabStates = tabStates || {};

      // Backfill missing states
      activeVideoTabs.forEach(tid => {
        if (!this.tabStates[tid]) {
          this.tabStates[tid] = { angle: 0, radius: 1.0, mode: 'speaker' };
        }
      });

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

  toggleTabMode(tabId) {
    if (!this.tabStates[tabId]) return;

    const current = this.tabStates[tabId].mode;
    const newMode = (current === 'speaker') ? 'binaural' : 'speaker';

    this.tabStates[tabId].mode = newMode;

    // If switching to speaker, snap to outer rim
    if (newMode === 'speaker') {
      this.tabStates[tabId].radius = 1.0;
    }

    this.updateUiForTab(tabId);
    this.sendState(tabId);

    // Persist config change
    chrome.runtime.sendMessage({ type: "PERSIST_STATE" });
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
      const state = this.tabStates[tab.id] || { angle: 0, radius: 1, mode: 'speaker' };

      const item = document.createElement('div');
      item.className = `tab-item ${this.selectedTabId === tab.id ? 'selected' : ''}`;
      item.dataset.tabId = tab.id;
      item.onclick = () => this.selectTab(tab.id);

      // Wrapper for text info
      const info = document.createElement('div');
      info.className = 'tab-info';

      const title = document.createElement('div');
      title.className = 'tab-title';
      title.textContent = tab.title;
      title.title = tab.title;

      const meta = document.createElement('div');
      meta.className = 'tab-meta';
      const angle = Math.round(state.angle || 0);
      meta.textContent = `${angle}°`;

      info.appendChild(title);
      info.appendChild(meta);

      // Mode Toggle Button
      const btn = document.createElement('button');
      const isBinaural = state.mode === 'binaural';
      btn.className = `mode-btn ${isBinaural ? 'binaural' : ''}`;
      btn.textContent = isBinaural ? '🎧' : '🔈';
      btn.title = isBinaural ? 'Binaural Mode (Immersive)' : 'Speaker Mode (Monitor)';

      btn.onclick = (e) => {
        e.stopPropagation();
        this.toggleTabMode(tab.id);
      };

      item.appendChild(info);
      item.appendChild(btn);
      this.ui.tabList.appendChild(item);
    });
  }

  renderRadar() {
    // Clear dots
    const existingDots = this.ui.radarContainer.querySelectorAll('.audio-dot');
    existingDots.forEach(dot => dot.remove());

    this.currentTabs.forEach(tab => {
      const state = this.tabStates[tab.id] || { angle: 0, radius: 1, mode: 'speaker' };

      // Force constraints just in case state is stale
      if (state.mode === 'speaker' && state.radius < 0.99) {
        state.radius = 1.0;
      }

      const dot = document.createElement('div');
      dot.className = `audio-dot ${this.selectedTabId === tab.id ? 'selected' : ''}`;
      dot.dataset.tabId = tab.id;
      dot.title = `${tab.title} (${Math.round(state.angle)}°)`;

      const pos = this.calculateDotPosition(state.angle, state.radius);
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
    this.hasDragged = true;

    this._updatePositionFromEvent(e, this.draggingTabId);
  }

  // --- Click Logic ---
  handleRadarBackgroundMouseDown(e) {
    if (!this.selectedTabId) return;

    // Move & Start Drag
    this._updatePositionFromEvent(e, this.selectedTabId);
    this.startDragging(e, this.selectedTabId);
  }

  // Shared logic for calculating position from mouse event
  _updatePositionFromEvent(e, tabId) {
    if (!this.tabStates[tabId]) this.tabStates[tabId] = { angle: 0, radius: 1, mode: 'speaker' };

    const rect = this.ui.radarContainer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Angle
    const newAngle = this.calculateAngleFromPosition(x, y);

    // Radius
    const dx = x - this.CENTER_X;
    const dy = y - this.CENTER_Y;
    let dist = Math.sqrt(dx * dx + dy * dy) / this.RADAR_RADIUS;
    if (dist > 1) dist = 1; // Clamp max

    // Constraints
    const mode = this.tabStates[tabId].mode;
    if (mode === 'speaker') {
      dist = 1.0; // Force outer rim
    }

    // Update State
    this.tabStates[tabId].angle = newAngle;
    this.tabStates[tabId].radius = dist;

    // Update UI & Send
    this.updateUiForTab(tabId);
    this.throttledSendMessage(tabId);
  }

  // Direct DOM update to avoid full re-render
  updateUiForTab(tabId) {
    const state = this.tabStates[tabId];
    if (!state) return;

    // 1. Update List Item
    const listItem = this.ui.tabList.querySelector(`.tab-item[data-tab-id="${tabId}"]`);
    if (listItem) {
      const meta = listItem.querySelector('.tab-meta');
      if (meta) meta.textContent = `${Math.round(state.angle)}°`;

      const btn = listItem.querySelector('.mode-btn');
      if (btn) {
        const isBinaural = state.mode === 'binaural';
        btn.className = `mode-btn ${isBinaural ? 'binaural' : ''}`;
        btn.textContent = isBinaural ? '🎧' : '🔈';
        btn.title = isBinaural ? 'Binaural Mode (Immersive)' : 'Speaker Mode (Monitor)';
      }
    }

    // 2. Update Radar Dot Position
    const dot = this.ui.radarContainer.querySelector(`.audio-dot[data-tab-id="${tabId}"]`);
    if (dot) {
      const pos = this.calculateDotPosition(state.angle, state.radius);
      dot.style.left = pos.x + 'px';
      dot.style.top = pos.y + 'px';
    }
  }

  // --- Math ---

  calculateDotPosition(angleDeg, radius = 1.0) {
    // 0 degrees is UP (Front).
    // -90 is Left, 90 is Right.
    // In Math/Canvas: 0 is Right (3 o'clock), -90 is Top (12 o'clock).
    // So: MathAngle = AngleDeg - 90
    const mathAngleRad = (angleDeg - 90) * (Math.PI / 180);
    const r = this.RADAR_RADIUS * radius;
    const x = this.CENTER_X + r * Math.cos(mathAngleRad);
    const y = this.CENTER_Y + r * Math.sin(mathAngleRad);
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
