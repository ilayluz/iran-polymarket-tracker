"""Main Dash application entry point."""

from dash import Dash

from .layout import create_layout


def create_app() -> Dash:
    app = Dash(__name__, title="US-Iran Strike Probabilities")
    app.layout = create_layout()

    # Import callbacks to register them with Dash
    from . import callbacks  # noqa: F401

    return app


def main():
    app = create_app()
    app.run(debug=True, host="127.0.0.1", port=8050)


if __name__ == "__main__":
    main()
