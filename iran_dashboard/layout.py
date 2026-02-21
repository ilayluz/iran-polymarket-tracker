"""Dash layout definition."""

from dash import dcc, html


def create_layout() -> html.Div:
    return html.Div(
        [
            html.H1(
                "US-Iran Strike Probability Dashboard",
                style={"textAlign": "center", "marginBottom": "5px"},
            ),
            html.P(
                [
                    "Based on ",
                    html.A(
                        "Polymarket prediction markets",
                        href="https://polymarket.com/event/us-strikes-iran-by",
                        target="_blank",
                        style={"color": "#1f77b4"},
                    ),
                ],
                style={
                    "textAlign": "center",
                    "color": "#666",
                    "marginTop": "0",
                    "marginBottom": "20px",
                },
            ),
            # Controls row
            html.Div(
                [
                    html.Div(
                        [
                            html.Label(
                                "View:",
                                style={"fontWeight": "bold", "marginRight": "10px"},
                            ),
                            dcc.RadioItems(
                                id="dist-toggle",
                                options=[
                                    {
                                        "label": " Cumulative (CDF)",
                                        "value": "cdf",
                                    },
                                    {
                                        "label": " Density (PDF)",
                                        "value": "pdf",
                                    },
                                ],
                                value="cdf",
                                inline=True,
                                style={"display": "inline-block"},
                                inputStyle={"marginRight": "5px"},
                                labelStyle={"marginRight": "20px"},
                            ),
                        ],
                        style={"display": "inline-block", "marginRight": "40px"},
                    ),
                    html.Div(
                        [
                            dcc.Checklist(
                                id="joy-toggle",
                                options=[
                                    {
                                        "label": " Ridge Plot (historical overlay)",
                                        "value": "joy",
                                    }
                                ],
                                value=[],
                                inputStyle={"marginRight": "5px"},
                            ),
                        ],
                        style={"display": "inline-block"},
                    ),
                ],
                style={
                    "textAlign": "center",
                    "marginBottom": "15px",
                    "padding": "10px",
                    "backgroundColor": "#f8f9fa",
                    "borderRadius": "8px",
                },
            ),
            # Time slider
            html.Div(
                [
                    html.Label(
                        "Historical snapshot:",
                        style={"fontWeight": "bold", "marginBottom": "5px"},
                    ),
                    dcc.Slider(
                        id="time-slider",
                        min=0,
                        max=100,
                        step=1,
                        value=100,
                        marks={},
                        tooltip={"placement": "bottom", "always_visible": False},
                    ),
                ],
                style={"marginBottom": "20px", "padding": "0 20px"},
            ),
            # Main chart
            dcc.Loading(
                dcc.Graph(
                    id="main-chart",
                    style={"height": "550px"},
                    config={"displayModeBar": True, "scrollZoom": True},
                ),
                type="circle",
            ),
            # Market details table
            html.Div(
                id="market-table",
                style={"marginTop": "20px", "padding": "0 20px"},
            ),
            # Auto-refresh every 5 minutes
            dcc.Interval(
                id="auto-refresh",
                interval=5 * 60 * 1000,
                n_intervals=0,
            ),
            # Hidden data stores
            dcc.Store(id="market-data-store"),
            dcc.Store(id="history-data-store"),
            dcc.Store(id="time-range-store"),
        ],
        style={
            "maxWidth": "1100px",
            "margin": "0 auto",
            "padding": "20px",
            "fontFamily": "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        },
    )
