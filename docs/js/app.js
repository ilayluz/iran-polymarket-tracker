/**
 * App wiring: state management, event listeners, render loop.
 *
 * Replaces the Dash callback model with explicit state + events.
 */

// ─── State ─────────────────────────────────────────────────────────────

const state = {
  markets: [],
  histories: {},
  timeRange: null,      // {min: Date, max: Date}
  distType: "cdf",
  joyEnabled: false,
  sliderValue: 100,
  loading: false,
};

// ─── Helpers ───────────────────────────────────────────────────────────

function sliderToDatetime(idx, timeMin, timeMax) {
  const frac = (idx || 100) / 100;
  const totalMs = timeMax.getTime() - timeMin.getTime();
  return new Date(timeMin.getTime() + frac * totalMs);
}

function setLoading(on) {
  state.loading = on;
  document.getElementById("loading-overlay").classList.toggle("hidden", !on);
  document.getElementById("update-btn").disabled = on;
}

// ─── Data fetching ─────────────────────────────────────────────────────

async function fetchAndUpdate() {
  if (state.loading) return;
  setLoading(true);

  try {
    const { markets, histories } = await fetchAllData();
    state.markets = markets;
    state.histories = histories;

    if (markets.length > 0) {
      state.timeRange = getHistoryTimeRange(histories);
      updateSliderMarks();
    }

    render();
  } catch (err) {
    console.error("Fetch error:", err);
    renderEmptyChart("Error loading data from Polymarket. Click Update to retry.");
  } finally {
    setLoading(false);
  }
}

// ─── Slider marks ──────────────────────────────────────────────────────

function updateSliderMarks() {
  const container = document.getElementById("slider-marks");
  if (!state.timeRange) {
    container.innerHTML = "";
    return;
  }

  const { min: tMin, max: tMax } = state.timeRange;
  const totalDays = (tMax - tMin) / 86400000;
  const nMarks = Math.min(Math.floor(totalDays), 10);
  if (nMarks <= 0) {
    container.innerHTML = "";
    return;
  }

  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  let html = "";
  for (let i = 0; i <= nMarks; i++) {
    const frac = i / nMarks;
    const dt = new Date(tMin.getTime() + frac * totalDays * 86400000);
    html += `<span>${months[dt.getUTCMonth()]} ${dt.getUTCDate()}</span>`;
  }
  container.innerHTML = html;
}

// ─── Render ────────────────────────────────────────────────────────────

function render() {
  const { markets, histories, distType, joyEnabled, sliderValue, timeRange } = state;

  if (!markets || markets.length === 0) {
    renderEmptyChart("Loading data from Polymarket...");
    return;
  }

  if (joyEnabled && timeRange) {
    renderJoyPlot(markets, histories, distType, timeRange);
  } else {
    renderMainChart(markets, histories, distType, sliderValue);
  }

  renderMarketTable(markets, histories, sliderValue, timeRange);
}

// ─── Event listeners ───────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  // Radio buttons: CDF/PDF toggle
  for (const radio of document.querySelectorAll('input[name="dist-type"]')) {
    radio.addEventListener("change", (e) => {
      state.distType = e.target.value;
      render();
    });
  }

  // Checkbox: ridge plot toggle
  document.getElementById("joy-toggle").addEventListener("change", (e) => {
    state.joyEnabled = e.target.checked;
    render();
  });

  // Range slider: historical snapshot
  document.getElementById("time-slider").addEventListener("input", (e) => {
    state.sliderValue = parseInt(e.target.value, 10);
    render();
  });

  // Update button
  document.getElementById("update-btn").addEventListener("click", () => {
    fetchAndUpdate();
  });

  // Initial load
  fetchAndUpdate();

  // Auto-refresh
  setInterval(fetchAndUpdate, REFRESH_INTERVAL_MS);
});
