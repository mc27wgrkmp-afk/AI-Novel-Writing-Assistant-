"""Keep accepted Gemini response cookies private; never log credential values."""
import http.cookiejar
import json
import os
from pathlib import Path
import tempfile
from urllib.parse import urlsplit


def merge_response_cookies(cookie, response, request):
    allowed = lambda url: url.scheme == 'https' and url.hostname == 'gemini.google.com' and url.port in (None, 443)
    if not allowed(urlsplit(request.full_url)) or not allowed(urlsplit(response.geturl())):
        raise ValueError('unexpected cookie response origin')
    jar = http.cookiejar.CookieJar()
    jar.extract_cookies(response, request)
    pairs = dict(part.strip().split('=', 1) for part in cookie.split(';') if '=' in part)
    for entry in jar:
        pairs[entry.name] = entry.value
    return '; '.join(name + '=' + value for name, value in pairs.items())


def persist_response_cookies(config, response, request):
    path = config.get('cookie_file')
    if not path:
        return
    path = Path(path)
    original = path.read_bytes()
    data = json.loads(original) if original.lstrip().startswith(b'{') else None
    cookie = data['cookie'] if data else original.decode().strip()
    updated = merge_response_cookies(cookie, response, request)
    # Formatting differences alone should not create snapshots.
    pairs = lambda value: dict(part.strip().split('=', 1) for part in value.split(';') if '=' in part)
    if pairs(updated) == pairs(cookie):
        return
    sapisid = pairs(updated).get('SAPISID')
    if not sapisid:
        raise ValueError('updated session missing SAPISID')
    if data is not None:
        data.update(cookie=updated, sapisid=sapisid)
        content = json.dumps(data, ensure_ascii=False).encode()
    else:
        content = updated.encode()
    # Preserve a concrete private copy before replacing a rotating credential.
    backup_fd, _ = tempfile.mkstemp(prefix='.gemini-cookie-before-rotation-', dir=path.parent)
    with os.fdopen(backup_fd, 'wb') as file:
        file.write(original)
    fd, name = tempfile.mkstemp(prefix='.gemini-cookie-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as file:
            file.write(content)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)
