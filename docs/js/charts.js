/**
 * Chart rendering with Plotly.js.
 *
 * Ports callbacks.py chart logic + joy_plot.py ridge plot.
 */

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
      yVals.push(finePdf[idx]);
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
      x: xDates, y: Array.from(fineCdf), mode: "lines", name: "Interpolated CDF",
      line: { color: "#1f77b4", width: 2.5 },
      hovertemplate: "Date: %{x}<br>P(strike by date): %{y:.1%}<extra></extra>",
    });
  } else {
    traces.push({
      x: xDates, y: Array.from(finePdf), mode: "lines", fill: "tozeroy",
      name: "Probability Density",
      line: { color: "#1f77b4", width: 2 },
      fillcolor: "rgba(31, 119, 180, 0.15)",
      hovertemplate: "Date: %{x}<br>Density: %{y:.4f}/day<extra></extra>",
    });
  }

  // Market data point markers
  const markers = buildMarkers(usedMarkets, fineDates, finePdf, distType, historicalPrices);
  if (markers) traces.push(markers);

  const defaultEnd = addDays(today, 60);
  const layout = {
    title: { text: `US-Iran Strike Probability \u2014 ${titleSuffix}`, x: 0.5 },
    xaxis: {
      title: "Date",
      range: [isoDate(today), isoDate(defaultEnd)],
      gridcolor: "#eee", gridwidth: 1,
    },
    yaxis: {
      title: distType === "cdf" ? "Cumulative Probability" : "Probability Density (per day)",
      tickformat: distType === "cdf" ? ".0%" : undefined,
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
    const hoverLabel = distType === "pdf" ? "Density: %{customdata:.4f}/day" : "P(strike by date): %{customdata:.1%}";
    traces.push({
      x: xDates, y: yCurve, mode: "lines",
      line: { color: lineColor, width: 0.8 },
      showlegend: false,
      hovertemplate: `<b>${formatDate(ts)}</b><br>Date: %{x}<br>${hoverLabel}<extra></extra>`,
      customdata: Array.from(yVals),
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
  const viewLabel = distType === "pdf" ? "Probability Density" : "Cumulative Probability";
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
      html += `<h3>Markets at ${asOf.toISOString().replace("T", " ").slice(0, 19)} UTC</h3>`;
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
