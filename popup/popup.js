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
  }

  init() {
    this.ui.refreshBtn.addEventListener('click', () => this.refresh());
    this.ui.modeToggle.addEventListener('change', (e) => this.toggleMode(e));

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
      const angleVal = this.tabAngles[tab.id] || 0;
      dot.title = `${tab.title} (${Math.round(angleVal)}°)`;

      const pos = this.calculateDotPosition(angleVal);
      dot.style.left = pos.x + 'px';
      dot.style.top = pos.y + 'px';

      dot.onmousedown = (e) => this.startDragging(e, tab.id);
      dot.onclick = (e) => {
        e.stopPropagation();
        this.selectTab(tab.id);
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
    this.draggingTabId = tabId;
    this.selectTab(tabId);
    e.preventDefault();
  }

  stopDragging() {
    this.isDragging = false;
    this.draggingTabId = null;
    this.render();

    // Persist state now that drag is done
    chrome.runtime.sendMessage({ type: "PERSIST_STATE" });
  }

  handleDrag(e) {
    if (!this.isDragging || !this.draggingTabId) return;

    const rect = this.ui.radarContainer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const newAngle = this.calculateAngleFromPosition(x, y);
    this.tabAngles[this.draggingTabId] = newAngle;

    this.render(); // Smooth update

    chrome.runtime.sendMessage({
      type: "SET_ANGLE",
      tabId: this.draggingTabId,
      angle: newAngle
    });
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
}

// Start
document.addEventListener('DOMContentLoaded', () => {
  const app = new PopupApp();
  app.init();
});
