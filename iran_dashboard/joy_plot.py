"""Joy/ridge plot visualization showing probability distribution over time."""

from datetime import datetime, timedelta, timezone, date

import numpy as np
import plotly.graph_objects as go

from .data import build_snapshot, _ordinal_to_date


def create_joy_figure(
    markets: list[dict],
    histories: dict[str, list[dict]],
    dist_type: str = "pdf",
    n_snapshots: int = 30,
    time_min: datetime | None = None,
    time_max: datetime | None = None,
) -> go.Figure:
    """
    Create a TensorBoard-style ridge/joy plot.

    Uses global normalization so absolute values are comparable across ridges.
    Newest at bottom, oldest at top. Opaque fills create 3D layered effect.
    """
    if time_min is None or time_max is None:
        now = datetime.now(timezone.utc)
        time_min = time_min or (now - timedelta(days=30))
        time_max = time_max or now

    total_seconds = (time_max - time_min).total_seconds()
    if total_seconds <= 0:
        return _empty("Not enough time range for ridge plot")

    timestamps = [
        time_min + timedelta(seconds=total_seconds * i / (n_snapshots - 1))
        for i in range(n_snapshots)
    ]

    curves = []
    for ts in timestamps:
        fine_dates, fine_cdf, fine_pdf, used = build_snapshot(markets, histories, ts)
        if len(fine_dates) < 2:
            continue
        y = fine_pdf if dist_type == "pdf" else fine_cdf
        curves.append((ts, fine_dates, y))

    if not curves:
        return _empty("Not enough historical data for ridge plot")

    today = date.today()
    x_start_ord = today.toordinal()

    # Keep all data from today onward (don't clip to 60 days — zoom buttons need full range)
    clipped = []
    for ts, fine_dates, y_vals in curves:
        mask = fine_dates >= x_start_ord
        if not np.any(mask):
            continue
        clipped.append((ts, fine_dates[mask], y_vals[mask]))

    if not clipped:
        return _empty("Not enough data in the visible range")

    # Global normalization — honest comparison across all ridges
    global_max = max(np.max(c[2]) for c in clipped)
    if global_max == 0:
        global_max = 1.0

    n = len(clipped)
    # Tight packing: small offset relative to the max curve height
    # This controls how much ridges overlap — smaller = more overlap
    offset_step = 0.12
    scale = 1.5  # how tall the tallest ridge is relative to offset_step units

    fig = go.Figure()

    # Draw from oldest (top, highest offset) to newest (bottom, offset=0)
    # Newest drawn LAST so it appears on top (in front)
    for i, (ts, fine_dates, y_vals) in enumerate(clipped):
        x_dates = [_ordinal_to_date(o) for o in fine_dates]
        # Oldest gets highest offset, newest gets 0
        offset = (n - 1 - i) * offset_step

        y_scaled = y_vals / global_max * scale
        y_curve = y_scaled + offset

        # Color: gradient from light peach (oldest) to vivid coral (newest)
        t = i / max(n - 1, 1)
        r = int(245 + 10 * t)
        g = int(190 - 100 * t)
        b = int(160 - 100 * t)
        fill_color = f"rgba({r}, {g}, {b}, 0.92)"
        line_color = "rgba(255, 255, 255, 0.7)"

        # Fill polygon: curve on top, flat baseline on bottom
        # We need to create a closed shape that goes: curve left→right, then baseline right→left
        x_full = list(x_dates) + list(reversed(x_dates))
        y_full = list(y_curve) + [offset] * len(x_dates)

        fig.add_trace(
            go.Scatter(
                x=x_full,
                y=y_full,
                fill="toself",
                fillcolor=fill_color,
                line=dict(color=line_color, width=0.8),
                showlegend=False,
                hoverinfo="skip",
            )
        )

        # Separate top-edge trace for hover info
        fig.add_trace(
            go.Scatter(
                x=x_dates,
                y=y_curve,
                mode="lines",
                line=dict(color=line_color, width=0.8),
                showlegend=False,
                hovertemplate=(
                    f"<b>{ts.strftime('%b %d, %Y')}</b><br>"
                    "Date: %{x}<br>"
                    + ("Density: %{customdata:.4f}/day" if dist_type == "pdf"
                       else "P(strike by date): %{customdata:.1%}")
                    + "<extra></extra>"
                ),
                customdata=y_vals,
            )
        )

    # Date labels on the right side, for a subset of ridges
    # Use the rightmost date from the last (newest) curve for label positioning
    rightmost_date = _ordinal_to_date(clipped[-1][1][-1])
    label_every = max(1, n // 8)
    for i, (ts, fine_dates, y_vals) in enumerate(clipped):
        if i % label_every != 0 and i != n - 1:
            continue
        offset = (n - 1 - i) * offset_step
        fig.add_annotation(
            x=rightmost_date,
            y=offset,
            text=ts.strftime("%b %d"),
            showarrow=False,
            xanchor="left", yanchor="middle",
            font=dict(size=9, color="#666"),
            xshift=8,
        )

    # Zoom buttons and default range — same as main chart
    default_x_end = today + timedelta(days=60)
    end_of_year = date(today.year, 12, 31)
    zoom_buttons = [
        dict(label="30 days", method="relayout",
             args=[{"xaxis.range": [today.isoformat(), (today + timedelta(days=30)).isoformat()]}]),
        dict(label="60 days", method="relayout",
             args=[{"xaxis.range": [today.isoformat(), default_x_end.isoformat()]}]),
        dict(label="End of year", method="relayout",
             args=[{"xaxis.range": [today.isoformat(), end_of_year.isoformat()]}]),
        dict(label="All", method="relayout",
             args=[{"xaxis.autorange": True}]),
    ]

    view_label = "Probability Density" if dist_type == "pdf" else "Cumulative Probability"
    fig.update_layout(
        title=dict(text=f"Ridge Plot: {view_label} Over Time", x=0.5, font=dict(size=15)),
        xaxis=dict(
            title="Date",
            range=[today.isoformat(), default_x_end.isoformat()],
            gridcolor="#eee",
        ),
        yaxis=dict(showticklabels=False, showgrid=False, zeroline=False),
        updatemenus=[
            dict(
                type="buttons", direction="right",
                x=1.0, xanchor="right", y=1.15, yanchor="top",
                buttons=zoom_buttons, showactive=True, active=1,
                bgcolor="white", bordercolor="#ccc", font=dict(size=11),
            ),
        ],
        plot_bgcolor="white",
        hovermode="closest",
        showlegend=False,
        margin=dict(l=40, r=80, t=80, b=50),
        uirevision="stable",
    )

    return fig


def _empty(message: str) -> go.Figure:
    fig = go.Figure()
    fig.add_annotation(text=message, showarrow=False, font=dict(size=14))
    fig.update_layout(
        xaxis=dict(visible=False), yaxis=dict(visible=False), plot_bgcolor="white"
    )
    return fig
