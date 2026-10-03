"""Probe gateway/session health without printing credentials or creative content."""
import argparse
import json
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent


class CredentialRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old, new = urlsplit(req.full_url), urlsplit(newurl)
        origin = lambda url: (url.scheme.lower(), url.hostname, url.port or (443 if url.scheme == "https" else 80))
        request = super().redirect_request(req, fp, code, msg, headers, newurl)
        if request is not None and origin(old) != origin(new):
            for name in ("Cookie", "Authorization"):
                request.remove_header(name)
        return request


def describe_page(status, url, html):
    host = urlsplit(url).hostname or ""
    return {
        "httpStatus": status,
        "loginRedirect": host == "accounts.google.com",
        "googleChallenge": host == "www.google.com" and "/sorry/" in urlsplit(url).path,
        "signInButton": bool(re.search(r'aria-label=[\"\']Sign in[\"\']', html)),
        "sessionTokenPresent": "SNlM0e" in html,
    }


def error_description(error):
    # Do not emit upstream messages: redirects can include session data or prompts.
    if isinstance(error, urllib.error.HTTPError):
        return {"type": "http", "status": error.code}
    return {"type": type(error).__name__}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--generate", action="store_true", help="Send one synthetic 'Reply only OK.' prompt")
    args = parser.parse_args()
    config = json.loads((ROOT / ".local/gemini-web2api/config.json").read_text())
    report = {"generationTested": args.generate}
    local = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    base = f"http://127.0.0.1:{int(config.get('port', 8081))}/v1"
    headers = {"Content-Type": "application/json"}
    keys = config.get("api_keys") or []
    if keys:
        headers["Authorization"] = f"Bearer {keys[0]}"
    try:
        with local.open(urllib.request.Request(base + "/models", headers=headers), timeout=10) as response:
            report["gatewayModelsStatus"] = response.status
    except Exception as error:
        report["gatewayModelsError"] = error_description(error)

    cookie = ""
    if config.get("cookie_file"):
        path = Path(config["cookie_file"])
        if not path.is_absolute():
            path = ROOT / ".local/gemini-web2api" / path
        if path.exists():
            cookie = path.read_text().strip()
            if cookie.startswith("{"):
                cookie = json.loads(cookie).get("cookie", "")
    report["cookiePresent"] = bool(cookie)
    proxy = config.get("proxy")
    report["explicitProxyConfigured"] = bool(proxy)
    proxy_handler = urllib.request.ProxyHandler({"http": proxy, "https": proxy}) if proxy else urllib.request.ProxyHandler()
    upstream = urllib.request.build_opener(proxy_handler, CredentialRedirectHandler())
    auth_user = config.get("auth_user")
    prefix = f"/u/{auth_user}" if auth_user is not None and auth_user != "" else ""
    request = urllib.request.Request("https://gemini.google.com" + prefix + "/app", headers={
        "Cookie": cookie,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    })
    try:
        with upstream.open(request, timeout=20) as response:
            report["upstreamPage"] = describe_page(response.status, response.url, response.read().decode("utf-8", "replace"))
    except Exception as error:
        report["upstreamPageError"] = error_description(error)

    if args.generate:
        body = json.dumps({"model": config.get("default_model", "gemini-3.7-flash"),
                           "messages": [{"role": "user", "content": "Reply only OK."}], "stream": False}).encode()
        request = urllib.request.Request(base + "/chat/completions", data=body, headers=headers)
        try:
            with local.open(request, timeout=240) as response:
                result = json.loads(response.read())
                choices = result.get("choices") or []
                content = choices[0].get("message", {}).get("content") if choices else None
                report["generation"] = {"httpStatus": response.status, "contentPresent": bool(content and content.strip())}
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", "replace")
            code = re.search(r"BardErrorInfo\s*\[(\d+)\]", body)
            report["generation"] = {"httpStatus": error.code, "upstreamCode": int(code[1]) if code else None,
                                    "coolingDown": "cooling down" in body}
        except Exception as error:
            report["generationError"] = error_description(error)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
