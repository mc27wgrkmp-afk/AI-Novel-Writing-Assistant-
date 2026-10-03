"""Validate a newly copied Gemini Cookie header before updating local credentials."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.request
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent


class SameOriginRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old, new = urlsplit(req.full_url), urlsplit(newurl)
        origin = lambda url: (url.scheme.lower(), url.hostname, url.port or (443 if url.scheme == "https" else 80))
        if origin(old) != origin(new):
            raise ValueError("cross-origin authentication redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def write_private(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".gemini-session-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(data)
        os.chmod(name, 0o600)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def fetch_page(config, cookie):
    proxy = config.get("proxy")
    handler = urllib.request.ProxyHandler({"http": proxy, "https": proxy}) if proxy else urllib.request.ProxyHandler()
    opener = urllib.request.build_opener(handler, SameOriginRedirectHandler())
    account = config.get("auth_user")
    prefix = f"/u/{account}" if account is not None and account != "" else ""
    request = urllib.request.Request("https://gemini.google.com" + prefix + "/app", headers={
        "Cookie": cookie,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    })
    with opener.open(request, timeout=20) as response:
        return response.url, response.read().decode("utf-8", "replace")


def refresh_session(config_path, cookie_header, backup_root, page_loader=fetch_page):
    config_bytes = config_path.read_bytes()
    config = json.loads(config_bytes)
    cookie = cookie_header.strip()
    if cookie.lower().startswith("cookie:"):
        cookie = cookie.split(":", 1)[1].strip()
    if not cookie or "\n" in cookie or "\r" in cookie:
        raise ValueError("invalid cookie header")
    pairs = dict(part.strip().split("=", 1) for part in cookie.split(";") if "=" in part)
    sapisid = pairs.get("SAPISID")
    if not sapisid:
        raise ValueError("SAPISID missing")
    url, html = page_loader(config, cookie)
    # Only accept the expected HTTPS origin; login/challenge redirects never qualify.
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname != "gemini.google.com" or parsed.port not in (None, 443):
        raise ValueError("unexpected page origin")
    token = re.search(r'"SNlM0e"\s*:\s*"([^"\\]*)"', html)
    build = re.search(r'"cfb2h"\s*:\s*"([^"\\]*)"', html)
    sign_in = re.search(r'aria-label=[\"\']Sign in[\"\']', html)
    if sign_in or not token or not token[1] or not build or not build[1]:
        raise ValueError("authenticated session fields missing")
    cookie_path = Path(config.get("cookie_file") or ROOT / ".local-data/gemini-cookie.txt")
    if not cookie_path.is_absolute():
        cookie_path = config_path.parent / cookie_path
    old_cookie = cookie_path.read_bytes() if cookie_path.exists() else None
    backup = backup_root / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup.mkdir(parents=True, mode=0o700)
    os.chmod(backup, 0o700)
    write_private(backup / "config.json", config_bytes)
    if old_cookie is not None:
        write_private(backup / "cookie.txt", old_cookie)
    config.update(cookie_file=str(cookie_path), xsrf_token=token[1], gemini_bl=build[1])
    new_cookie = json.dumps({"cookie": cookie, "sapisid": sapisid}, ensure_ascii=False).encode()
    new_config = json.dumps(config, ensure_ascii=False, indent=2).encode()
    try:
        write_private(cookie_path, new_cookie)
        write_private(config_path, new_config)
    except Exception:
        # Restore from protected in-memory originals if the second replacement fails.
        if old_cookie is not None:
            write_private(cookie_path, old_cookie)
        elif cookie_path.exists():
            cookie_path.unlink()
        write_private(config_path, config_bytes)
        raise
    return backup


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clipboard", required=True, action="store_true", help="Use a newly copied Cookie request header")
    parser.parse_args()
    if sys.platform != "darwin":
        print("此工具需要 macOS 剪贴板。", file=sys.stderr)
        return 1
    try:
        cookie = subprocess.run(["pbpaste"], check=True, capture_output=True, text=True).stdout
        refresh_session(ROOT / ".local/gemini-web2api/config.json", cookie, ROOT / ".local-data/gemini-session-backups")
    except Exception as error:
        # Never print exception text, page bodies, cookies, tokens, or clipboard content.
        print(f"会话更新未完成（{type(error).__name__}）。请复制当前 Gemini 请求的 Cookie 单行值；确认网页已登录且账户路径与网关一致。", file=sys.stderr)
        return 1
    print("已验证登录页面并保存本地会话，旧配置已私密备份。请重启 Gemini 网关，再运行最小生成检测；本次未验证生成。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
