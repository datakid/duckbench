import json
import os
import sys

from playwright.sync_api import sync_playwright

url = sys.argv[1]
chromium = os.environ.get("PW_CHROMIUM")

with sync_playwright() as p:
    options = {"args": ["--no-sandbox"]}
    if chromium:
        options["executable_path"] = chromium
    browser = p.chromium.launch(**options)
    page = browser.new_page()
    logs = []
    page.on("console", lambda m: logs.append(m.text))
    page.goto(url)
    try:
        page.wait_for_function("window.__selftest", timeout=180000)
    except Exception as e:
        print("Self-test did not finish:", str(e)[:200])
        print("\n".join(logs[-20:]))
        sys.exit(1)
    result = page.evaluate("window.__selftest")
    browser.close()

print(f"Self-test: {result['passed']}/{result['total']} passed")
for f in result["failures"]:
    print(f"FAIL {f.get('name')}: {str(f.get('error'))[:200]}")
sys.exit(0 if result["passed"] == result["total"] and result["total"] > 0 else 1)
