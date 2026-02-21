"""Dash callbacks for all dashboard interactivity."""

from datetime import datetime, timedelta, timezone, date

import numpy as np
import plotly.graph_objects as go
from dash import Input, Output, State, callback, html, no_update

from .api import get_classified_markets, fetch_all_histories
from .data import (
    build_cdf_points,
    interpolate_cdf,
    compute_pdf,
    build_snapshot,
    get_history_time_range,
    _ordinal_to_date,
)
from .joy_plot import create_joy_figure


def _empty_chart(message: str) -> go.Figure:
    fig = go.Figure()
    fig.add_annotation(text=message, showarrow=False, font=dict(size=14))
    fig.update_layout(
        xaxis=dict(visible=False), yaxis=dict(visible=False), plot_bgcolor="white"
    )
    return fig


def _serialize_markets(markets: list[dict]) -> list[dict]:
    """Make market dicts JSON-serializable for dcc.Store."""
    out = []
    for m in markets:
        d = dict(m)
        d["deadline_date"] = d["deadline_date"].isoformat()
        out.append(d)
    return out


def _deserialize_markets(data: list[dict]) -> list[dict]:
    """Restore date objects from serialized market dicts."""
    out = []
    for d in data:
        d = dict(d)
        d["deadline_date"] = date.fromisoformat(d["deadline_date"])
        out.append(d)
    return out


def _serialize_histories(histories: dict[str, list[dict]]) -> dict[str, list[dict]]:
    """Histories are already JSON-serializable (timestamps + floats)."""
    return histories


def _slider_to_datetime(time_idx, time_min, time_max):
    """Convert slider position (0-100) to a datetime."""
    frac = (time_idx or 100) / 100.0
    total_seconds = (time_max - time_min).total_seconds()
    return time_min + timedelta(seconds=frac * total_seconds)


def _parse_time_range(time_range):
    """Parse time range from store, with fallback."""
    if time_range:
        return (
            datetime.fromisoformat(time_range["min"]),
            datetime.fromisoformat(time_range["max"]),
        )
    now = datetime.now(timezone.utc)
    return now - timedelta(days=30), now


def _get_historical_prices(markets, histories, as_of):
    """Look up each market's price at a given historical time. Returns {token_id: price}."""
    as_of_ts = as_of.timestamp()
    prices = {}
    for m in markets:
        tid = m["yes_token_id"]
        if tid is None or tid not in histories:
            continue
        history = histories[tid]
        if not history:
            continue
        best_entry = None
        for entry in history:
            t = entry["t"]
            if t <= as_of_ts:
                if best_entry is None or t > best_entry["t"]:
                    best_entry = entry
        if best_entry is not None:
            prices[tid] = best_entry["p"]
    return prices


def _add_markers(fig, used_markets, fine_dates, fine_pdf, dist_type, historical_prices=None):
    """Add scatter markers at actual market data points."""
    marker_dates = []
    marker_y = []
    marker_text = []
    marker_sizes = []
    marker_opacities = []

    for m in used_markets:
        if m is None:
            continue
        d = m["deadline_date"]

        # Use historical price if available, otherwise current
        if historical_prices and m["yes_token_id"] in historical_prices:
            p = historical_prices[m["yes_token_id"]]
        else:
            p = m["yes_price"]

        if dist_type == "cdf":
            marker_dates.append(d)
            marker_y.append(p)
        else:
            ord_val = d.toordinal()
            idx = np.searchsorted(fine_dates, ord_val)
            idx = min(idx, len(fine_pdf) - 1)
            marker_dates.append(d)
            marker_y.append(float(fine_pdf[idx]))

        vol = m["volume"]
        label_parts = [
            f"{d.strftime('%b %d, %Y')}",
            f"Price: {p:.1%}",
            f"Volume: ${vol:,.0f}",
        ]
        if m["is_low_volume"]:
            label_parts.append("LOW VOLUME")
        if m["is_new"]:
            label_parts.append("NEW MARKET")
        marker_text.append("<br>".join(label_parts))

        if m["is_low_volume"]:
            marker_sizes.append(6)
            marker_opacities.append(0.4)
        else:
            size = min(14, 7 + np.log10(max(vol, 1)) * 1.2)
            marker_sizes.append(size)
            marker_opacities.append(0.9)

    if marker_dates:
        fig.add_trace(
            go.Scatter(
                x=marker_dates,
                y=marker_y,
                mode="markers",
                name="Market Data",
                marker=dict(
                    size=marker_sizes,
                    color="#ff7f0e",
                    opacity=marker_opacities,
                    line=dict(width=1, color="white"),
                ),
                hovertemplate="%{text}<extra></extra>",
                text=marker_text,
            )
        )


@callback(
    Output("market-data-store", "data"),
    Output("history-data-store", "data"),
    Output("time-range-store", "data"),
    Output("time-slider", "marks"),
    Input("auto-refresh", "n_intervals"),
)
def fetch_data(n_intervals):
    """Fetch market data and price histories from Polymarket."""
    try:
        markets = get_classified_markets()
    except Exception:
        return no_update, no_update, no_update, no_update

    if not markets:
        return [], {}, {}, {}

    try:
        histories = fetch_all_histories(markets)
    except Exception:
        histories = {}

    time_min, time_max = get_history_time_range(histories)
    time_range = {
        "min": time_min.isoformat(),
        "max": time_max.isoformat(),
    }

    # Build slider marks at ~weekly intervals
    total_days = (time_max - time_min).days
    n_marks = min(total_days, 10)
    marks = {}
    if n_marks > 0:
        for i in range(n_marks + 1):
            frac = i / n_marks
            idx = int(frac * 100)
            dt = time_min + timedelta(days=frac * total_days)
            marks[idx] = dt.strftime("%b %d")

    return (
        _serialize_markets(markets),
        _serialize_histories(histories),
        time_range,
        marks,
    )


@callback(
    Output("main-chart", "figure"),
    Input("dist-toggle", "value"),
    Input("joy-toggle", "value"),
    Input("time-slider", "value"),
    Input("market-data-store", "data"),
    Input("history-data-store", "data"),
    Input("time-range-store", "data"),
)
def update_chart(dist_type, joy_value, time_idx, market_data, history_data, time_range):
    """Render the main chart based on current controls."""
    if not market_data:
        return _empty_chart("Loading data from Polymarket...")

    markets = _deserialize_markets(market_data)
    histories = history_data or {}
    time_min, time_max = _parse_time_range(time_range)

    joy_enabled = "joy" in (joy_value or [])
    if joy_enabled:
        return create_joy_figure(
            markets, histories, dist_type=dist_type,
            time_min=time_min, time_max=time_max,
        )

    # Determine as_of from slider
    as_of = _slider_to_datetime(time_idx, time_min, time_max)
    is_latest = (time_idx or 100) >= 99

    historical_prices = None
    if is_latest:
        raw_dates, raw_cdf, used_markets = build_cdf_points(markets)
        if len(raw_dates) < 2:
            return _empty_chart("Not enough data for current view")
        fine_dates, fine_cdf = interpolate_cdf(raw_dates, raw_cdf)
        fine_pdf = compute_pdf(fine_dates, fine_cdf)
        title_suffix = "Current"
    else:
        fine_dates, fine_cdf, fine_pdf, used_markets = build_snapshot(
            markets, histories, as_of
        )
        if len(fine_dates) < 2:
            return _empty_chart("Not enough data for this time period")
        historical_prices = _get_historical_prices(markets, histories, as_of)
        title_suffix = as_of.strftime("%b %d, %Y %H:%M UTC")

    x_dates = [_ordinal_to_date(o) for o in fine_dates]

    fig = go.Figure()

    if dist_type == "cdf":
        fig.add_trace(
            go.Scatter(
                x=x_dates,
                y=fine_cdf,
                mode="lines",
                name="Interpolated CDF",
                line=dict(color="#1f77b4", width=2.5),
                hovertemplate="Date: %{x}<br>P(strike by date): %{y:.1%}<extra></extra>",
            )
        )
        y_title = "Cumulative Probability"
        y_format = ".0%"
    else:
        fig.add_trace(
            go.Scatter(
                x=x_dates,
                y=fine_pdf,
                mode="lines",
                fill="tozeroy",
                name="Probability Density",
                line=dict(color="#1f77b4", width=2),
                fillcolor="rgba(31, 119, 180, 0.15)",
                hovertemplate="Date: %{x}<br>Density: %{y:.4f}/day<extra></extra>",
            )
        )
        y_title = "Probability Density (per day)"
        y_format = None

    # Add markers for ALL modes (latest + historical)
    _add_markers(fig, used_markets, fine_dates, fine_pdf, dist_type, historical_prices)

    # Today line
    today = date.today()
    fig.add_shape(
        type="line",
        x0=today, x1=today,
        y0=0, y1=1,
        yref="paper",
        line=dict(dash="dash", color="red", width=1),
    )
    fig.add_annotation(
        x=today, y=1, yref="paper",
        text="Today", showarrow=False,
        xanchor="left", yanchor="bottom",
        font=dict(color="red", size=11),
    )

    # Zoom preset ranges
    end_of_year = date(today.year, 12, 31)
    zoom_buttons = [
        dict(
            label="30 days",
            method="relayout",
            args=[{"xaxis.range": [today.isoformat(), (today + timedelta(days=30)).isoformat()]}],
        ),
        dict(
            label="60 days",
            method="relayout",
            args=[{"xaxis.range": [today.isoformat(), (today + timedelta(days=60)).isoformat()]}],
        ),
        dict(
            label="End of year",
            method="relayout",
            args=[{"xaxis.range": [today.isoformat(), end_of_year.isoformat()]}],
        ),
        dict(
            label="All",
            method="relayout",
            args=[{"xaxis.autorange": True}],
        ),
    ]

    # Default: 60 days
    default_x_end = today + timedelta(days=60)
    fig.update_layout(
        title=dict(
            text=f"US-Iran Strike Probability — {title_suffix}",
            x=0.5,
        ),
        xaxis_title="Date",
        xaxis=dict(range=[today.isoformat(), default_x_end.isoformat()]),
        yaxis_title=y_title,
        yaxis=dict(
            tickformat=y_format,
            rangemode="tozero",
        ),
        updatemenus=[
            dict(
                type="buttons",
                direction="right",
                x=1.0,
                xanchor="right",
                y=1.15,
                yanchor="top",
                buttons=zoom_buttons,
                showactive=True,
                active=1,  # "60 days" is default (0-indexed)
                bgcolor="white",
                bordercolor="#ccc",
                font=dict(size=11),
            ),
        ],
        plot_bgcolor="white",
        hovermode="x unified",
        legend=dict(
            yanchor="top",
            y=0.99,
            xanchor="left",
            x=0.01,
        ),
        margin=dict(l=60, r=40, t=80, b=40),
        # Preserve zoom/pan state across toggles and slider changes
        uirevision="stable",
    )

    fig.update_xaxes(gridcolor="#eee", gridwidth=1)
    fig.update_yaxes(gridcolor="#eee", gridwidth=1)

    return fig


@callback(
    Output("market-table", "children"),
    Input("market-data-store", "data"),
    Input("time-slider", "value"),
    Input("history-data-store", "data"),
    Input("time-range-store", "data"),
)
def update_table(market_data, time_idx, history_data, time_range):
    """Render a table of markets: historical snapshot + always the latest list."""
    if not market_data:
        return html.P("Loading market data...", style={"color": "#999"})

    markets = _deserialize_markets(market_data)
    histories = history_data or {}
    time_min, time_max = _parse_time_range(time_range)
    is_latest = (time_idx or 100) >= 99

    open_markets = [m for m in markets if not m["is_closed"]]
    if not open_markets:
        return html.P("No open markets found.")

    sections = []

    # If viewing a historical snapshot, show that first
    if not is_latest:
        as_of = _slider_to_datetime(time_idx, time_min, time_max)
        hist_prices = _get_historical_prices(markets, histories, as_of)

        if hist_prices:
            sections.append(
                html.H3(
                    f"Markets at {as_of.strftime('%b %d, %Y %H:%M UTC')}",
                    style={"marginBottom": "10px"},
                )
            )
            sections.append(
                _build_market_table(markets, historical_prices=hist_prices, anchor_date=as_of.date())
            )
            sections.append(html.Hr(style={"margin": "20px 0"}))

    # Always show latest market list
    sections.append(
        html.H3("Current Open Markets", style={"marginBottom": "10px"})
    )
    sections.append(_build_market_table(markets))

    return html.Div(sections)


def _build_market_table(markets, historical_prices=None, anchor_date=None):
    """Build an HTML table of markets."""
    if anchor_date is None:
        anchor_date = date.today()

    header = html.Tr(
        [
            html.Th("Deadline", style={"textAlign": "left", "padding": "6px 8px"}),
            html.Th("Probability", style={"textAlign": "right", "padding": "6px 8px"}),
            html.Th("Volume", style={"textAlign": "right", "padding": "6px 8px"}),
            html.Th("Status", style={"textAlign": "center", "padding": "6px 8px"}),
        ]
    )

    rows = []
    for m in markets:
        if m["deadline_date"] <= anchor_date:
            continue

        if historical_prices is not None:
            tid = m["yes_token_id"]
            if tid not in historical_prices:
                continue
            price = historical_prices[tid]
        else:
            if m["is_closed"]:
                continue
            price = m["yes_price"]

        badges = []
        if m["is_low_volume"]:
            badges.append(
                html.Span(
                    "Low Volume",
                    style={
                        "backgroundColor": "#fff3cd",
                        "color": "#856404",
                        "padding": "2px 6px",
                        "borderRadius": "4px",
                        "fontSize": "11px",
                        "marginRight": "4px",
                    },
                )
            )
        if m["is_new"]:
            badges.append(
                html.Span(
                    "New",
                    style={
                        "backgroundColor": "#d4edda",
                        "color": "#155724",
                        "padding": "2px 6px",
                        "borderRadius": "4px",
                        "fontSize": "11px",
                    },
                )
            )
        if not badges:
            badges.append(
                html.Span(
                    "Active",
                    style={"color": "#28a745", "fontSize": "11px"},
                )
            )

        row_style = {"opacity": "0.5"} if m["is_low_volume"] else {}

        rows.append(
            html.Tr(
                [
                    html.Td(
                        m["deadline_date"].strftime("%b %d, %Y"),
                        style={"textAlign": "left", "padding": "4px 8px"},
                    ),
                    html.Td(
                        f"{price:.1%}",
                        style={"textAlign": "right", "fontWeight": "bold", "padding": "4px 8px"},
                    ),
                    html.Td(
                        f"${m['volume']:,.0f}",
                        style={"textAlign": "right", "padding": "4px 8px"},
                    ),
                    html.Td(badges, style={"textAlign": "center", "padding": "4px 8px"}),
                ],
                style=row_style,
            )
        )

    if not rows:
        return html.P("No markets available for this time.", style={"color": "#999"})

    return html.Table(
        [html.Thead(header), html.Tbody(rows)],
        style={
            "width": "100%",
            "borderCollapse": "collapse",
            "fontSize": "13px",
        },
    )
