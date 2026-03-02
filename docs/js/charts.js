/**
 * Chart rendering with Plotly.js.
 *
 * Ports callbacks.py chart logic + joy_plot.py ridge plot.
 */

// ─── HTML escaping ──────────────────────────────────────────────────────

/** Escape HTML special characters to prevent XSS from API data. */
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Helpers ───────────────────────────────────────────────────────────

function todayDate() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function formatDate(d) {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function zoomButtons(today) {
  const eoy = new Date(Date.UTC(today.getUTCFullYear(), 11, 31));
  return [
    { label: "30 days", method: "relayout",
      args: [{ "xaxis.range": [isoDate(today), isoDate(addDays(today, 30))] }] },
    { label: "60 days", method: "relayout",
      args: [{ "xaxis.range": [isoDate(today), isoDate(addDays(today, 60))] }] },
    { label: "End of year", method: "relayout",
      args: [{ "xaxis.range": [isoDate(today), isoDate(eoy)] }] },
    { label: "All", method: "relayout",
      args: [{ "xaxis.autorange": true }] },
  ];
}

// ─── Marker construction ───────────────────────────────────────────────

function buildMarkers(usedMarkets, fineDates, finePdf, distType, historicalPrices) {
  const dates = [], yVals = [], texts = [], sizes = [], opacities = [];

  for (const m of usedMarkets) {
    if (!m) continue;

    const d = m.deadlineDate;
    let p;
    if (historicalPrices && m.yesTokenId in historicalPrices) {
      p = historicalPrices[m.yesTokenId];
    } else {
      p = m.yesPrice;
    }

    if (distType === "cdf") {
      dates.push(isoDate(d));
      yVals.push(p);
    } else {
      const ord = dateToOrdinal(d);
      // Find nearest index in fineDates
      let idx = 0;
      for (let j = 0; j < fineDates.length; j++) {
        if (fineDates[j] <= ord) idx = j;
        else break;
      }
      dates.push(isoDate(d));
      yVals.push(finePdf[idx] * 100);
    }

    const vol = m.volume;
    const parts = [
      formatDate(d),
      `Price: ${(p * 100).toFixed(1)}%`,
      `Volume: $${vol.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    ];
    if (m.isLowVolume) parts.push("LOW VOLUME");
    if (m.isNew) parts.push("NEW MARKET");
    texts.push(parts.join("<br>"));

    if (m.isLowVolume) {
      sizes.push(6);
      opacities.push(0.4);
    } else {
      sizes.push(Math.min(14, 7 + Math.log10(Math.max(vol, 1)) * 1.2));
      opacities.push(0.9);
    }
  }

  if (dates.length === 0) return null;

  return {
    x: dates, y: yVals, mode: "markers", name: "Market Data",
    marker: { size: sizes, color: "#ff7f0e", opacity: opacities, line: { width: 1, color: "white" } },
    hovertemplate: "%{text}<extra></extra>",
    text: texts,
  };
}

// ─── Main chart ────────────────────────────────────────────────────────

/**
 * Render the main CDF or PDF chart.
 */
function renderMainChart(markets, histories, distType, sliderValue) {
  const today = todayDate();
  const isLatest = sliderValue >= 99;
  let fineDates, fineCdf, finePdf, usedMarkets, titleSuffix, historicalPrices = null;

  if (isLatest) {
    const cdf = buildCdfPoints(markets);
    if (cdf.dates.length < 2) {
      renderEmptyChart("Not enough data for current view");
      return;
    }
    const interp = interpolateCdf(cdf.dates, cdf.cdfValues);
    fineDates = interp.fineDates;
    fineCdf = interp.fineCdf;
    finePdf = computePdf(fineDates, fineCdf);
    usedMarkets = cdf.usedMarkets;
    titleSuffix = "Current";
  } else {
    const timeRange = state.timeRange;
    const asOf = sliderToDatetime(sliderValue, timeRange.min, timeRange.max);
    const snap = buildSnapshot(markets, histories, asOf);
    if (!snap || snap.fineDates.length < 2) {
      renderEmptyChart("Not enough data for this time period");
      return;
    }
    fineDates = snap.fineDates;
    fineCdf = snap.fineCdf;
    finePdf = snap.finePdf;
    usedMarkets = snap.usedMarkets;
    historicalPrices = getHistoricalPrices(markets, histories, asOf);
    titleSuffix = asOf.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  }

  // X-axis as ISO date strings
  const xDates = Array.from(fineDates).map(ordinalToIso);

  const traces = [];

  if (distType === "cdf") {
    traces.push({
      x: xDates, y: Array.from(fineCdf), mode: "lines", name: "Probability curve",
      line: { color: "#1f77b4", width: 2.5 },
      hovertemplate: "Date: %{x}<br>Chance of ceasefire by this date: %{y:.1%}<extra></extra>",
    });
  } else {
    traces.push({
      x: xDates, y: Array.from(finePdf).map(v => v * 100), mode: "lines", fill: "tozeroy",
      name: "Daily probability",
      line: { color: "#1f77b4", width: 2 },
      fillcolor: "rgba(31, 119, 180, 0.15)",
      hovertemplate: "Date: %{x}<br>Likelihood: %{y:.2f}%/day<extra></extra>",
    });
  }

  // Market data point markers
  const markers = buildMarkers(usedMarkets, fineDates, finePdf, distType, historicalPrices);
  if (markers) traces.push(markers);

  const defaultEnd = addDays(today, 60);
  const layout = {
    title: { text: `US-Iran Ceasefire Probability \u2014 ${titleSuffix}`, x: 0.5 },
    xaxis: {
      title: "Date",
      range: [isoDate(today), isoDate(defaultEnd)],
      gridcolor: "#eee", gridwidth: 1,
    },
    yaxis: {
      title: distType === "cdf" ? "Chance of ceasefire by this date" : "Daily ceasefire likelihood (%/day)",
      tickformat: distType === "cdf" ? ".0%" : undefined,
      ticksuffix: distType === "cdf" ? undefined : "%",
      rangemode: "tozero",
      gridcolor: "#eee", gridwidth: 1,
    },
    shapes: [{
      type: "line", x0: isoDate(today), x1: isoDate(today),
      y0: 0, y1: 1, yref: "paper",
      line: { dash: "dash", color: "red", width: 1 },
    }],
    annotations: [{
      x: isoDate(today), y: 1, yref: "paper",
      text: "Today", showarrow: false,
      xanchor: "left", yanchor: "bottom",
      font: { color: "red", size: 11 },
    }],
    updatemenus: [{
      type: "buttons", direction: "right",
      x: 1.0, xanchor: "right", y: 1.15, yanchor: "top",
      buttons: zoomButtons(today), showactive: true, active: 1,
      bgcolor: "white", bordercolor: "#ccc", font: { size: 11 },
    }],
    plot_bgcolor: "white",
    hovermode: "x unified",
    legend: { yanchor: "top", y: 0.99, xanchor: "left", x: 0.01 },
    margin: { l: 60, r: 40, t: 80, b: 40 },
    uirevision: "stable",
  };

  Plotly.react("main-chart", traces, layout, { displayModeBar: true, scrollZoom: true });
}

// ─── Ridge / Joy plot ──────────────────────────────────────────────────

function renderJoyPlot(markets, histories, distType, timeRange) {
  const today = todayDate();
  const nSnapshots = 30;
  const timeMin = timeRange.min;
  const timeMax = timeRange.max;
  const totalMs = timeMax.getTime() - timeMin.getTime();

  if (totalMs <= 0) {
    renderEmptyChart("Not enough time range for ridge plot");
    return;
  }

  // Generate snapshot timestamps
  const timestamps = [];
  for (let i = 0; i < nSnapshots; i++) {
    timestamps.push(new Date(timeMin.getTime() + (totalMs * i) / (nSnapshots - 1)));
  }

  // Build curves
  const curves = [];
  for (const ts of timestamps) {
    const snap = buildSnapshot(markets, histories, ts);
    if (!snap || snap.fineDates.length < 2) continue;
    const yData = distType === "pdf" ? snap.finePdf : snap.fineCdf;
    curves.push({ ts, fineDates: snap.fineDates, y: yData });
  }

  if (curves.length === 0) {
    renderEmptyChart("Not enough historical data for ridge plot");
    return;
  }

  const xStartOrd = dateToOrdinal(today);

  // Clip to dates from today onward
  const clipped = [];
  for (const c of curves) {
    const indices = [];
    for (let i = 0; i < c.fineDates.length; i++) {
      if (c.fineDates[i] >= xStartOrd) indices.push(i);
    }
    if (indices.length === 0) continue;
    const fd = new Float64Array(indices.length);
    const yv = new Float64Array(indices.length);
    for (let j = 0; j < indices.length; j++) {
      fd[j] = c.fineDates[indices[j]];
      yv[j] = c.y[indices[j]];
    }
    clipped.push({ ts: c.ts, fineDates: fd, y: yv });
  }

  if (clipped.length === 0) {
    renderEmptyChart("Not enough data in the visible range");
    return;
  }

  // Global normalization
  let globalMax = 0;
  for (const c of clipped) {
    for (let i = 0; i < c.y.length; i++) {
      if (c.y[i] > globalMax) globalMax = c.y[i];
    }
  }
  if (globalMax === 0) globalMax = 1;

  const n = clipped.length;
  const offsetStep = 0.12;
  const scale = 1.5;

  const traces = [];

  // Draw oldest first (highest offset) → newest last (on top)
  for (let i = 0; i < n; i++) {
    const { ts, fineDates: fd, y: yVals } = clipped[i];
    const xDates = Array.from(fd).map(ordinalToIso);
    const offset = (n - 1 - i) * offsetStep;

    // Scale + offset
    const yCurve = Array.from(yVals).map(v => (v / globalMax) * scale + offset);

    // Color gradient: peach (oldest) → coral (newest)
    const t = i / Math.max(n - 1, 1);
    const r = Math.round(245 + 10 * t);
    const g = Math.round(190 - 100 * t);
    const b = Math.round(160 - 100 * t);
    const fillColor = `rgba(${r}, ${g}, ${b}, 0.92)`;
    const lineColor = "rgba(255, 255, 255, 0.7)";

    // Fill polygon: curve left→right, baseline right→left
    const xFull = [...xDates, ...xDates.slice().reverse()];
    const yFull = [...yCurve, ...new Array(xDates.length).fill(offset)];

    traces.push({
      x: xFull, y: yFull, fill: "toself", fillcolor: fillColor,
      line: { color: lineColor, width: 0.8 },
      showlegend: false, hoverinfo: "skip",
    });

    // Top-edge trace with hover
    const hoverLabel = distType === "pdf" ? "Likelihood: %{customdata:.2f}%/day" : "Chance of ceasefire by date: %{customdata:.1%}";
    traces.push({
      x: xDates, y: yCurve, mode: "lines",
      line: { color: lineColor, width: 0.8 },
      showlegend: false,
      hovertemplate: `<b>${formatDate(ts)}</b><br>Date: %{x}<br>${hoverLabel}<extra></extra>`,
      customdata: distType === "pdf" ? Array.from(yVals).map(v => v * 100) : Array.from(yVals),
    });
  }

  // Date labels on right side
  const rightmostDate = ordinalToIso(clipped[n - 1].fineDates[clipped[n - 1].fineDates.length - 1]);
  const labelEvery = Math.max(1, Math.floor(n / 8));
  const annotations = [];
  for (let i = 0; i < n; i++) {
    if (i % labelEvery !== 0 && i !== n - 1) continue;
    const offset = (n - 1 - i) * offsetStep;
    const ts = clipped[i].ts;
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    annotations.push({
      x: rightmostDate, y: offset,
      text: `${months[ts.getUTCMonth()]} ${ts.getUTCDate()}`,
      showarrow: false, xanchor: "left", yanchor: "middle",
      font: { size: 9, color: "#666" }, xshift: 8,
    });
  }

  const defaultEnd = addDays(today, 60);
  const viewLabel = distType === "pdf" ? "Daily Ceasefire Likelihood" : "Ceasefire Probability by Date";
  const layout = {
    title: { text: `Ridge Plot: ${viewLabel} Over Time`, x: 0.5, font: { size: 15 } },
    xaxis: {
      title: "Date",
      range: [isoDate(today), isoDate(defaultEnd)],
      gridcolor: "#eee",
    },
    yaxis: { showticklabels: false, showgrid: false, zeroline: false },
    updatemenus: [{
      type: "buttons", direction: "right",
      x: 1.0, xanchor: "right", y: 1.15, yanchor: "top",
      buttons: zoomButtons(today), showactive: true, active: 1,
      bgcolor: "white", bordercolor: "#ccc", font: { size: 11 },
    }],
    annotations,
    plot_bgcolor: "white",
    hovermode: "closest",
    showlegend: false,
    margin: { l: 40, r: 80, t: 80, b: 50 },
    uirevision: "stable",
  };

  Plotly.react("main-chart", traces, layout, { displayModeBar: true, scrollZoom: true });
}

// ─── Median timeline chart ──────────────────────────────────────────────

/**
 * Render the median timeline chart showing how the predicted ceasefire date
 * (and 25th–75th percentile confidence band) evolved over time.
 */
function renderTimelineChart(markets, histories) {
  const timeline = buildMedianTimeline(markets, histories);

  if (timeline.times.length === 0) {
    Plotly.react("timeline-chart", [], {
      annotations: [{ text: "Not enough history for timeline", showarrow: false, font: { size: 14 } }],
      xaxis: { visible: false }, yaxis: { visible: false },
      plot_bgcolor: "white", height: 300,
    });
    return;
  }

  // Format snapshot timestamps as ISO strings for Plotly date axis
  const xTimes = timeline.times.map(d => d.toISOString());

  const traces = [];

  // Confidence band fill (where both p25 and p75 exist)
  const bandX = [];
  const bandY = [];
  for (let i = 0; i < xTimes.length; i++) {
    if (timeline.p25[i] !== null && timeline.p75[i] !== null) {
      bandX.push(xTimes[i]);
      bandY.push(timeline.p75[i]);
    }
  }
  const bandXRev = [];
  const bandYRev = [];
  for (let i = xTimes.length - 1; i >= 0; i--) {
    if (timeline.p25[i] !== null && timeline.p75[i] !== null) {
      bandXRev.push(xTimes[i]);
      bandYRev.push(timeline.p25[i]);
    }
  }

  if (bandX.length > 0) {
    traces.push({
      x: [...bandX, ...bandXRev],
      y: [...bandY, ...bandYRev],
      fill: "toself",
      fillcolor: "rgba(31, 119, 180, 0.12)",
      line: { color: "transparent" },
      name: "25th–75th percentile",
      showlegend: false,
      hoverinfo: "skip",
    });
  }

  // 25th percentile dashed line (visible even when p75 is null)
  const p25X = [], p25Y = [];
  for (let i = 0; i < xTimes.length; i++) {
    if (timeline.p25[i] !== null) {
      p25X.push(xTimes[i]);
      p25Y.push(timeline.p25[i]);
    }
  }
  if (p25X.length > 0) {
    traces.push({
      x: p25X, y: p25Y, mode: "lines",
      name: "25th percentile",
      line: { color: "rgba(31, 119, 180, 0.4)", width: 1, dash: "dot" },
      hoverinfo: "skip",
    });
  }

  // 75th percentile dashed line
  const p75X = [], p75Y = [];
  for (let i = 0; i < xTimes.length; i++) {
    if (timeline.p75[i] !== null) {
      p75X.push(xTimes[i]);
      p75Y.push(timeline.p75[i]);
    }
  }
  if (p75X.length > 0) {
    traces.push({
      x: p75X, y: p75Y, mode: "lines",
      name: "75th percentile",
      line: { color: "rgba(31, 119, 180, 0.4)", width: 1, dash: "dot" },
      hoverinfo: "skip",
    });
  }

  // Median line (p50)
  const medX = [], medY = [], medCustom = [];
  for (let i = 0; i < xTimes.length; i++) {
    if (timeline.p50[i] !== null) {
      medX.push(xTimes[i]);
      medY.push(timeline.p50[i]);
      medCustom.push({
        p25: timeline.p25[i],
        p50: timeline.p50[i],
        p75: timeline.p75[i],
      });
    }
  }

  if (medX.length > 0) {
    traces.push({
      x: medX, y: medY, mode: "lines",
      name: "Median (50th)",
      line: { color: "#1f77b4", width: 2 },
      customdata: medCustom,
      hovertemplate: medCustom.map(d => {
        const parts = [`Median: ${d.p50}`];
        if (d.p25) parts.push(`25th: ${d.p25}`);
        if (d.p75) parts.push(`75th: ${d.p75}`);
        return parts.join("<br>") + "<extra></extra>";
      }),
    });
  }

  const layout = {
    title: { text: "Predicted Ceasefire Date Over Time", x: 0.5, font: { size: 15 } },
    xaxis: {
      title: "Snapshot Time",
      type: "date",
      gridcolor: "#eee",
      gridwidth: 1,
    },
    yaxis: {
      title: "Predicted Ceasefire Date",
      type: "date",
      gridcolor: "#eee",
      gridwidth: 1,
    },
    plot_bgcolor: "white",
    hovermode: "x unified",
    legend: { yanchor: "top", y: 0.99, xanchor: "left", x: 0.01 },
    margin: { l: 80, r: 40, t: 50, b: 40 },
    height: 300,
    uirevision: "timeline-stable",
  };

  Plotly.react("timeline-chart", traces, layout, { displayModeBar: true, scrollZoom: true });
}

// ─── Market table ──────────────────────────────────────────────────────

function renderMarketTable(markets, histories, sliderValue, timeRange) {
  const container = document.getElementById("market-table");
  const today = todayDate();
  const todayOrd = dateToOrdinal(today);
  const isLatest = sliderValue >= 99;

  const openMarkets = markets.filter(m => !m.isClosed);
  if (openMarkets.length === 0) {
    container.innerHTML = '<p style="color:#999">No open markets found.</p>';
    return;
  }

  let html = "";

  // Historical snapshot section
  if (!isLatest && timeRange) {
    const asOf = sliderToDatetime(sliderValue, timeRange.min, timeRange.max);
    const histPrices = getHistoricalPrices(markets, histories, asOf);

    if (Object.keys(histPrices).length > 0) {
      html += `<h3>Markets at ${escapeHtml(asOf.toISOString().replace("T", " ").slice(0, 19))} UTC</h3>`;
      html += buildTableHtml(markets, histPrices, asOf);
      html += "<hr>";
    }
  }

  // Current open markets (always shown)
  html += "<h3>Current Open Markets</h3>";
  html += buildTableHtml(markets, null, today);

  container.innerHTML = html;
}

function buildTableHtml(markets, historicalPrices, anchorDate) {
  const anchorOrd = dateToOrdinal(anchorDate);

  let rows = "";
  for (const m of markets) {
    const deadlineOrd = dateToOrdinal(m.deadlineDate);
    if (deadlineOrd <= anchorOrd) continue;

    let price;
    if (historicalPrices !== null) {
      if (!(m.yesTokenId in historicalPrices)) continue;
      price = historicalPrices[m.yesTokenId];
    } else {
      if (m.isClosed) continue;
      price = m.yesPrice;
    }

    let badges = "";
    if (m.isLowVolume) {
      badges += '<span class="badge badge-low-volume">Low Volume</span>';
    }
    if (m.isNew) {
      badges += '<span class="badge badge-new">New</span>';
    }
    if (!m.isLowVolume && !m.isNew) {
      badges += '<span class="badge-active">Active</span>';
    }

    const rowClass = m.isLowVolume ? ' class="row-faded"' : '';
    rows += `<tr${rowClass}>
      <td>${formatDate(m.deadlineDate)}</td>
      <td class="td-right td-bold">${(price * 100).toFixed(1)}%</td>
      <td class="td-right">$${m.volume.toLocaleString("en-US", { maximumFractionDigits: 0 })}</td>
      <td class="td-center">${badges}</td>
    </tr>`;
  }

  if (!rows) {
    return '<p style="color:#999">No markets available for this time.</p>';
  }

  return `<table>
    <thead><tr>
      <th>Deadline</th>
      <th class="th-right">Probability</th>
      <th class="th-right">Volume</th>
      <th class="th-center">Status</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ─── Empty chart helper ────────────────────────────────────────────────

function renderEmptyChart(message) {
  const layout = {
    annotations: [{ text: message, showarrow: false, font: { size: 14 } }],
    xaxis: { visible: false }, yaxis: { visible: false },
    plot_bgcolor: "white",
  };
  Plotly.react("main-chart", [], layout);
}
