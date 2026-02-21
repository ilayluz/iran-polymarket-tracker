"""Take a screenshot of the dashboard at a given URL."""

import sys
from playwright.sync_api import sync_playwright


def screenshot(url="http://127.0.0.1:8050", output="screenshot.png", wait_ms=5000, width=1400, height=900):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": width, "height": height})
        page.goto(url, wait_until="networkidle")
        page.wait_for_timeout(wait_ms)
        page.screenshot(path=output, full_page=True)
        browser.close()
        print(f"Saved: {output}")


if __name__ == "__main__":
    screenshot(*sys.argv[1:])
