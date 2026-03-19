/**
 * Chart rendering with Plotly.js.
 *
 * Ports callbacks.py chart logic.
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

// ─── Key statistics ─────────────────────────────────────────────────────

function renderStats(markets) {
  const cdf = buildCdfPoints(markets);
  if (cdf.dates.length < 2) return;

  const { fineDates, fineCdf } = interpolateCdf(cdf.dates, cdf.cdfValues);
  const today = todayDate();
  const todayOrd = dateToOrdinal(today);

  const q25 = getPercentileDate(fineDates, fineCdf, 0.25);
  const q50 = getPercentileDate(fineDates, fineCdf, 0.50);
  const q75 = getPercentileDate(fineDates, fineCdf, 0.75);

  if (q50 !== null) {
    const daysFromNow = Math.round(q50 - todayOrd);
    document.getElementById("stat-days").textContent = daysFromNow;
    document.getElementById("stat-p50").textContent = formatDate(ordinalToDate(q50));
  } else {
    document.getElementById("stat-days").textContent = ">1yr";
    document.getElementById("stat-p50").textContent = "Beyond market range";
  }

  document.getElementById("stat-p25").textContent =
    q25 !== null ? formatDate(ordinalToDate(q25)) : "N/A";
  document.getElementById("stat-p75").textContent =
    q75 !== null ? formatDate(ordinalToDate(q75)) : "Beyond market range";
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
      hovertemplate: "Date: %{x}<br>Chance of conflict ending by this date: %{y:.1%}<extra></extra>",
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
    title: { text: `Conflict End Probability \u2014 ${titleSuffix}`, x: 0.5 },
    xaxis: {
      title: "Date",
      range: [isoDate(today), isoDate(defaultEnd)],
      gridcolor: "#eee", gridwidth: 1,
    },
    yaxis: {
      title: distType === "cdf" ? "Chance of conflict ending by this date" : "Daily likelihood of conflict ending (%/day)",
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

// ─── Median timeline chart ──────────────────────────────────────────────

/**
 * Render the median timeline chart showing how the predicted end date
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
      name: "25th\u201375th percentile",
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

  // Compute y-axis range from actual data (p25 min to p75 max) with padding
  const allYDates = [];
  for (const arr of [p25Y, medY, p75Y]) {
    for (const d of arr) allYDates.push(new Date(d).getTime());
  }
  let yRange;
  if (allYDates.length > 0) {
    const yMin = Math.min(...allYDates);
    const yMax = Math.max(...allYDates);
    const pad = (yMax - yMin) * 0.1 || 7 * 86400000;
    yRange = [new Date(yMin - pad).toISOString(), new Date(yMax + pad).toISOString()];
  }

  const layout = {
    title: { text: "Predicted End Date Over Time", x: 0.5, font: { size: 15 } },
    xaxis: {
      title: "Snapshot Time",
      type: "date",
      gridcolor: "#eee",
      gridwidth: 1,
    },
    yaxis: {
      title: "Predicted End Date",
      type: "date",
      gridcolor: "#eee",
      gridwidth: 1,
      range: yRange,
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
