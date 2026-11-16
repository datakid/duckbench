import os
import re
import sys
import time

from playwright.sync_api import sync_playwright

url = sys.argv[1]
chromium = os.environ.get("PW_CHROMIUM")

result = None
for attempt in (1, 2):
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
            deadline = time.time() + 300
            text = ""
            while time.time() < deadline:
                text = page.evaluate("document.getElementById('score').textContent")
                if re.search(r"DuckDB parity \d+/\d+", text or ""):
                    break
                time.sleep(3)
            else:
                raise TimeoutError("parity page did not report a score within 300s")
            fails = page.evaluate(
                "[...document.querySelectorAll('#list li')].filter(li => li.children[0].textContent === 'FAIL').map(li => li.children[1].textContent + ' :: ' + (li.children[2] ? li.children[2].textContent : ''))"
            )
            result = (text, fails)
            browser.close()
            break
        except Exception as e:
            print(f"Parity run {attempt} did not finish:", str(e)[:200])
            print("\n".join(logs[-20:]))
            tail = " | ".join(logs[-6:]).replace("\n", " ")[:600]
            print(f"::error title=parity run {attempt} did not finish::{str(e)[:160]} || console: {tail}")
            browser.close()

if result is None:
    sys.exit(1)

text, fails = result
m = re.search(r"(\d+)/(\d+)", text)
passed, total = int(m.group(1)), int(m.group(2))
print(f"{text}")
print(f"::notice title=parity score::{text}")
for f in fails[:10]:
    print(f"FAIL {f[:300]}")
    print(f"::error title=parity failure::{f[:400]}")
sys.exit(0 if passed == total and total > 0 else 1)
