#!/usr/bin/env python3
"""Read-only, deterministic export of local Scriptor and WebFictionLab sources.

This module never imports a source platform's runtime, opens credentials, or
writes a source file. stdout is the machine-readable bundle consumed by Node;
callers must not put the returned manuscript text in application logs.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sqlite3
import stat
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

SCHEMA = 1
EXTRACTOR = "local-sources/1"
DEFAULT_LIBRARY = os.environ.get("UNIFIED_CODEX_LIBRARY", str(Path.home() / "Documents" / "Codex小说书房"))
DEFAULT_WFL = os.environ.get(
    "UNIFIED_WFL_DB",
    str(Path.home() / "Documents" / "ChatGPT" / "写文自动化辅助流程" / ".local-data" / "webfictionlab.sqlite3"),
)
SECTIONS = {"作品契约", "世界书", "大纲", "构想", "账本", "本书记忆", "草稿区", "定稿"}
PRIVATE_PARTS = {".git", ".env", ".DS_Store", ".codex", "credentials", ".credentials", "credentials.json",
                 "secrets", ".secrets", "secrets.json", "tokens", "tokens.json", "auth.json"}
KNOWN_TABLES = {
    "books", "chapters", "analysis_runs", "chapter_analyses", "book_analysis_runs", "book_analyses",
    "opening_analysis_runs", "opening_analyses", "contrast_runs", "contrast_analyses", "story_events",
    "research_patterns", "pattern_evidence", "scene_cards", "scene_card_patterns", "research_jobs",
    "research_steps", "research_step_cache", "writing_projects", "writing_drafts", "author_intents",
    "writing_word_count_events", "editor_runs", "editor_reports", "publication_feedback", "experiments",
    "agent_invocations", "model_usage",
}
SECRET_COLUMNS = {"password", "secret", "api_key", "access_token", "refresh_token", "id_token",
                  "client_secret", "private_key", "cookie", "authorization", "auth_token"}


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value: str | bytes) -> str:
    return hashlib.sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


def han_count(text: str) -> int:
    # Same Han ranges as the local Scriptor adapter; headings in prose count.
    return sum("\u3400" <= c <= "\u4dbf" or "\u4e00" <= c <= "\u9fff"
               or "\U00020000" <= c <= "\U0002ebef" for c in text)


def checked_root(value: str | Path) -> Path:
    if not str(value).strip():
        raise ValueError("来源路径不能为空")
    path = Path(value).expanduser()
    if ".." in path.parts:
        raise ValueError("来源路径不能含上级目录跳转")
    path = path.absolute()
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise ValueError("来源路径不能经过软链接；请使用实际绝对路径")
    return path


def safe_relative(root: Path, relative: str | Path) -> Path:
    rel = Path(relative)
    if rel.is_absolute() or not rel.parts or any(p in ("..", ".") for p in rel.parts):
        raise ValueError("来源相对路径不合法")
    current = root
    for part in rel.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("来源含软链接：" + str(rel))
    if not current.resolve().is_relative_to(root.resolve()):
        raise ValueError("来源路径越界")
    return current


def read_source(root: Path, relative: str | Path) -> tuple[str, str]:
    safe_relative(root, relative)
    descriptors = []
    directory_flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_DIRECTORY", 0)
    parent = os.open(root, directory_flags)
    descriptors.append(parent)
    try:
        parts = Path(relative).parts
        for part in parts[:-1]:
            parent = os.open(part, directory_flags, dir_fd=parent)
            descriptors.append(parent)
        fd = os.open(parts[-1], os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent)
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("来源不是普通文件：" + str(relative))
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw_bytes = stream.read()
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
            raise ValueError("读取时来源发生变化，请重新扫描：" + str(relative))
        return raw_bytes.decode("utf-8"), digest(raw_bytes)
    finally:
        os.close(fd)


def scalar(frontmatter: str, key: str) -> str | None:
    # Read only scalar fields of the known local format. Never execute YAML tags.
    found = re.findall(r"^[ \t]*" + re.escape(key) + r"[ \t]*:[ \t]*([^\r\n]*)$", frontmatter, re.M)
    if len(found) != 1:
        return None
    value = found[0].strip()
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        value = value[1:-1]
    return value or None


def split_manuscript(raw: str, path: str, warnings: list[str]) -> tuple[str, str, str]:
    text = raw.removeprefix("\ufeff")
    frontmatter = ""
    if re.match(r"\A---\r?\n", text):
        match = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)", text, re.S)
        if not match:
            warnings.append(f"{path}：frontmatter 未闭合，保留原稿，正文待核对")
            return "", "", ""
        frontmatter = match.group(1)
        text = text[match.end():]
    markers = list(re.finditer(r"^##[ \t]+草稿候选事实[ \t]*\r?$", text, re.M))
    if len(markers) > 1:
        warnings.append(f"{path}：候选事实边界重复，保留原稿，正文待核对")
        return frontmatter, "", ""
    if markers:
        marker = markers[0]
        return frontmatter, text[:marker.start()].strip(), text[marker.end():].strip()
    if re.search(r"^#{1,6}[ \t]+.*(?:候选事实|事实候选)", text, re.M):
        warnings.append(f"{path}：候选事实标题格式不明确，保留原稿，正文待核对")
        return frontmatter, "", ""
    return frontmatter, text.strip(), ""


def artifact(path: str, kind: str, content: str, source_hash: str | None = None) -> dict:
    return {"path": path, "kind": kind, "content": content, "hash": source_hash or digest(content)}


def classify(path: str) -> str:
    parts = Path(path).parts
    if path.startswith("草稿区/草稿/"):
        return "raw-draft"
    if path.startswith("草稿区/审核/"):
        return "legacy-review"
    if path.startswith(".scriptor/reviews/"):
        return "review-record"
    if path.startswith("草稿区/材料包/"):
        return "material"
    if path.startswith("草稿区/定稿准备/"):
        return "pending-summary" if parts[-1] == "章摘要.md" else "pending-settlement"
    if path.startswith("定稿/"):
        if parts[-1] == "章摘要.md":
            return "summary"
        if parts[-1] == "事实.json":
            return "settled-facts-source"
        return "final-source"
    return {"作品契约": "contract", "世界书": "world", "大纲": "outline", "构想": "idea",
            "账本": "ledger-source", "本书记忆": "memory-source"}.get(parts[0], "source-metadata")


def eligible_files(book: Path, warnings: list[str]) -> list[str]:
    result: list[str] = []

    def visit(folder: Path) -> None:
        for entry in sorted(folder.iterdir(), key=lambda p: p.name):
            rel = entry.relative_to(book).as_posix()
            if entry.name in PRIVATE_PARTS or entry.name.startswith(".env"):
                continue
            if entry.is_symlink():
                warnings.append(f"{book.name}/{rel}：拒绝读取软链接")
                continue
            if entry.is_dir():
                visit(entry)
            elif entry.is_file() and entry.suffix.lower() in {".md", ".json", ".txt"}:
                result.append(rel)

    for entry in sorted(book.iterdir(), key=lambda p: p.name):
        if entry.name in SECTIONS:
            if entry.is_symlink():
                warnings.append(f"{book.name}/{entry.name}：拒绝读取软链接")
            elif entry.is_dir():
                visit(entry)
        elif entry.name == ".scriptor":
            if entry.is_symlink():
                warnings.append(f"{book.name}/.scriptor：拒绝读取软链接")
                continue
            for child in sorted(entry.iterdir(), key=lambda p: p.name):
                if child.name in {"book.json", "import.json"}:
                    if child.is_symlink():
                        warnings.append(f"{book.name}/{child.relative_to(book)}：拒绝读取软链接")
                    elif child.is_file():
                        result.append(child.relative_to(book).as_posix())
                elif child.name in {"reviews", "backups"}:
                    if child.is_symlink():
                        warnings.append(f"{book.name}/{child.relative_to(book)}：拒绝读取软链接")
                    elif child.is_dir():
                        visit(child)
    return sorted(result)


def positive(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        number = int(value)
        return number if number > 0 and str(number) == str(value).lstrip("0") else None
    except (TypeError, ValueError):
        return None


def normalized_title(value: str) -> str:
    return re.sub(r"^第[零〇一二两三四五六七八九十百千\d]+章\s*", "", value).strip()


def path_identity(path: str, fm: str, warnings: list[str]) -> tuple[int | None, int | None, str]:
    volumes = {int(v) for v in re.findall(r"卷(\d+)", path)}
    orders: set[int] = set()
    title = ""
    for part in Path(path).parts:
        match = re.match(r"卷\d+-(\d+)-(.+?)(?:\.md)?$", part)
        if match:
            orders.add(int(match[1])); title = match[2]
        match = re.match(r"(\d{4,})-(.+?)(?:\.md)?$", part)
        if match:
            orders.add(int(match[1])); title = match[2]
        if not title:
            match = re.match(r"卷\d+-(.+)$", part)
            if match:
                title = match[1]
    fm_volume, fm_order = positive(scalar(fm, "卷")), positive(scalar(fm, "章") or scalar(fm, "章号"))
    if fm_volume:
        volumes.add(fm_volume)
    if fm_order:
        orders.add(fm_order)
    fm_title = scalar(fm, "章名")
    if fm_title and title and normalized_title(fm_title) != normalized_title(title):
        warnings.append(f"{path}：元数据章名与路径不一致，保留原文件待核对")
        return None, None, title
    if len(volumes) > 1 or len(orders) > 1 or 0 in volumes or 0 in orders:
        warnings.append(f"{path}：卷章身份冲突，保留原文件待核对")
        return None, None, fm_title or title
    return next(iter(volumes), None), next(iter(orders), None), fm_title or title


def chinese_number(value: str) -> int | None:
    if value.isdigit():
        return positive(value)
    digits = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
              "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
    total, current = 0, 0
    for char in value:
        if char in digits:
            current = digits[char]
        elif char in {"十", "百", "千"}:
            total += (current or 1) * {"十": 10, "百": 100, "千": 1000}[char]
            current = 0
        else:
            return None
    return total + current or None


def book_hash(book: dict) -> str:
    return digest(canonical({key: value for key, value in book.items() if key != "hash"}))


def scan_scriptor_book(book: Path, warnings: list[str]) -> dict:
    start_warning = len(warnings)
    source_files: dict[str, tuple[str, str]] = {}
    for path in eligible_files(book, warnings):
        try:
            source_files[path] = read_source(book, path)
        except (OSError, ValueError, UnicodeError) as exc:
            warnings.append(f"{book.name}/{path}：无法读取来源（{type(exc).__name__}）")
    settings: dict = {}
    if ".scriptor/book.json" in source_files:
        try:
            parsed = json.loads(source_files[".scriptor/book.json"][0])
            if isinstance(parsed, dict):
                settings = parsed
        except ValueError:
            warnings.append(f"{book.name}/.scriptor/book.json：元数据格式无效，使用目录身份")
    contract = source_files.get("作品契约/契约.md", ("", ""))[0]
    contract_fm, _, _ = split_manuscript(contract, f"{book.name}/作品契约/契约.md", warnings)
    source_id = settings.get("id") or settings.get("bookId") or settings.get("book_id") or scalar(contract_fm, "书id") or book.name
    if not isinstance(source_id, str) or not source_id.strip():
        source_id = book.name
    key = "scriptor:" + source_id
    title = settings.get("title") if isinstance(settings.get("title"), str) else book.name
    artifacts = [artifact(path, classify(path), raw, source_hash) for path, (raw, source_hash) in source_files.items()]
    outlines: dict[tuple[int, int], tuple[str, str]] = {}
    outline_names: dict[tuple[int, str], set[int]] = defaultdict(set)
    for path, (raw, _) in source_files.items():
        if "/章细纲/" not in path or not path.startswith("大纲/"):
            continue
        fm, _, _ = split_manuscript(raw, f"{book.name}/{path}", warnings)
        volume, order, chapter_title = path_identity(path, fm, warnings)
        if not volume or not order:
            warnings.append(f"{book.name}/{path}：细纲缺少可靠卷章身份")
            continue
        identity = volume, order
        if identity in outlines:
            warnings.append(f"{book.name}/{path}：同一卷章有多份细纲，标题对应需核对")
        outlines[identity] = chapter_title, path
        outline_names[volume, normalized_title(chapter_title)].add(order)
    chapters: dict[tuple[int, int], dict] = {}

    def chapter(volume: int, order: int, chapter_title: str) -> dict:
        identity = volume, order
        return chapters.setdefault(identity, {"key": f"{key}:v{volume}:c{order}", "volume": volume,
            "order": order, "title": outlines.get(identity, (chapter_title, ""))[0], "content": "", "drafts": []})

    for (volume, order), (chapter_title, _) in outlines.items():
        chapter(volume, order, chapter_title)
    for path, (raw, _) in source_files.items():
        if Path(path).name != "近期窗口.md":
            continue
        volume_match = re.search(r"卷(\d+)", path)
        if not volume_match:
            warnings.append(f"{book.name}/{path}：近期窗口缺卷号，仅保留规划原文")
            continue
        for match in re.finditer(r"^\s*-\s*(第([零〇一二两三四五六七八九十百千\d]+)章\s+[^\r\n〔（(]+)", raw, re.M):
            order = chinese_number(match[2])
            if order:
                chapter(int(volume_match[1]), order, match[1].strip())
    final_sources: dict[tuple[int, int], list[str]] = defaultdict(list)
    drafts_metadata = {}
    for path, (raw, source_hash) in source_files.items():
        is_draft = path.startswith("草稿区/草稿/") and Path(path).suffix == ".md"
        is_final = path.startswith("定稿/") and Path(path).suffix == ".md" and (
            Path(path).name == "正文.md" or re.fullmatch(r"\d{4,}-.+\.md", Path(path).name))
        if not is_draft and not is_final:
            continue
        fm, content, candidates = split_manuscript(raw, f"{book.name}/{path}", warnings)
        if fm:
            artifacts.append(artifact(path + "#frontmatter", "frontmatter", fm))
        if candidates:
            artifacts.append(artifact(path + "#candidate-facts", "candidate-facts", candidates))
        volume, order, chapter_title = path_identity(path, fm, warnings)
        if not volume:
            warnings.append(f"{book.name}/{path}：稿件缺少可靠卷号，仅保留原稿")
            continue
        matching = outline_names.get((volume, normalized_title(chapter_title)), set())
        if not order and len(matching) == 1:
            order = next(iter(matching))
        elif order and matching and matching != {order}:
            warnings.append(f"{book.name}/{path}：稿件卷章与细纲冲突，仅保留原稿")
            continue
        if not order:
            warnings.append(f"{book.name}/{path}：无法与细纲核对章号，仅保留原稿")
            continue
        identity = volume, order
        if identity in outlines and normalized_title(outlines[identity][0]) != normalized_title(chapter_title):
            warnings.append(f"{book.name}/{path}：稿件章名与细纲不一致，仅保留原稿")
            continue
        item = chapter(volume, order, chapter_title or f"第{order}章")
        if is_final:
            final_sources[identity].append(path)
            if len(final_sources[identity]) == 1:
                item["content"] = content
            else:
                item["content"] = ""
                warnings.append(f"{book.name}/{path}：同卷章有多份定稿正文，待作者核对")
            continue
        match = re.fullmatch(r"稿(\d+)\.md", Path(path).name)
        version = int(match[1]) if match else positive(scalar(fm, "版本"))
        if not version or (match and scalar(fm, "版本") and positive(scalar(fm, "版本")) != version):
            warnings.append(f"{book.name}/{path}：稿件版本不明确，仅保留原稿")
            continue
        item["drafts"].append({"key": f"{key}:{path}", "version": version, "raw": raw, "content": content,
            "candidateFacts": candidates, "hash": source_hash, "bodyHash": digest(content), "han": han_count(content)})
        drafts_metadata[path] = {"frontmatter": fm, "parentVersion": scalar(fm, "父版本"),
            "extractor": EXTRACTOR, "rawHash": source_hash, "bodyHash": digest(content),
            "sourceHan": han_count(raw), "bodyHan": han_count(content)}
    for identity, item in chapters.items():
        item["drafts"].sort(key=lambda d: (d["version"], d["key"]))
        versions = [d["version"] for d in item["drafts"]]
        if len(versions) != len(set(versions)):
            warnings.append(f"{book.name}/卷{identity[0]}第{identity[1]}章：稿件版本重复，待核对")
        if identity not in final_sources and item["drafts"]:
            item["content"] = item["drafts"][-1]["content"]
    result = {"key": key, "source": "scriptor", "kind": "novel", "title": title, "hash": "",
        "chapters": [chapters[i] for i in sorted(chapters)], "artifacts": sorted(artifacts, key=lambda a: a["path"]),
        "metadata": {"sourceId": source_id, "sourceRoot": str(book), "extractor": EXTRACTOR,
            "drafts": drafts_metadata, "outlines": {f"{v}:{c}": p for (v, c), (_, p) in outlines.items()},
            "finalSources": {f"{v}:{c}": p for (v, c), p in final_sources.items()},
            "finalCount": sum(len(p) for p in final_sources.values()), "authorApproval": None,
            "wordCountMetric": "han-scriptor/1", "excluded": [".git", ".webnovel", "credentials"],
            "warnings": warnings[start_warning:]}}
    result["hash"] = book_hash(result)
    return result


def scan_scriptor(library: Path, warnings: list[str]) -> list[dict]:
    if not library.is_dir():
        warnings.append("Scriptor 书房不存在：" + str(library))
        return []
    books = []
    for book in sorted(library.iterdir(), key=lambda p: p.name):
        if book.is_symlink():
            warnings.append("Scriptor 拒绝读取软链接：" + book.name)
            continue
        if not book.is_dir():
            continue
        if (book / "作品契约").is_symlink():
            warnings.append("Scriptor 拒绝读取软链接：" + book.name + "/作品契约")
            continue
        if not (book / "作品契约").is_dir():
            continue
        try:
            books.append(scan_scriptor_book(book, warnings))
        except (OSError, ValueError, UnicodeError) as exc:
            warnings.append(f"Scriptor/{book.name}：书仓读取失败（{type(exc).__name__}）")
    return books


def sql_name(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def json_value(value: Any) -> Any:
    return {"$binaryBase64": base64.b64encode(value).decode("ascii")} if isinstance(value, bytes) else value


def read_sqlite_snapshot(path: Path, warnings: list[str], on_snapshot: Callable[[], None] | None = None) -> dict:
    """Pin one read transaction including committed WAL; do not use immutable=1."""
    if not path.is_file():
        raise ValueError("WebFictionLab 数据库不存在")
    if path.is_symlink() or any(p.is_symlink() for p in (path.with_name(path.name + "-wal"), path.with_name(path.name + "-shm"))):
        raise ValueError("WebFictionLab 数据库或 WAL 含软链接")
    connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=10)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA query_only = ON")
        connection.execute("BEGIN")
        tables = connection.execute("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
        if on_snapshot:
            on_snapshot()
        snapshot = {}
        for table in tables:
            name = table["name"]
            columns = [dict(row) for row in connection.execute("PRAGMA table_info(" + sql_name(name) + ")")]
            if name == "app_settings" or any(c["name"].lower() in SECRET_COLUMNS for c in columns):
                continue
            foreign_keys = [dict(row) for row in connection.execute("PRAGMA foreign_key_list(" + sql_name(name) + ")")]
            rows = [{k: json_value(v) for k, v in dict(row).items()}
                    for row in connection.execute("SELECT * FROM " + sql_name(name))]
            rows.sort(key=canonical)
            snapshot[name] = {"columns": columns, "foreignKeys": foreign_keys, "rows": rows, "sql": table["sql"]}
            if name not in KNOWN_TABLES:
                warnings.append(f"WebFictionLab/{name}：未识别表结构，原始记录作为研究资料保留")
        return snapshot
    finally:
        connection.rollback()
        connection.close()


def row_id(row: dict, columns: list[dict]) -> str:
    primary = [c["name"] for c in sorted(columns, key=lambda c: c["pk"]) if c["pk"]]
    if len(primary) == 1:
        return str(row[primary[0]])
    if primary:
        return canonical({k: row[k] for k in primary})
    return digest(canonical(row))


def record_kind(table: str) -> str:
    if table == "chapters":
        return "reference-chapter-source"
    if table == "writing_drafts":
        return "writing-draft-source"
    if table.endswith("_runs") or table in {"agent_invocations", "model_usage", "research_jobs", "research_steps"}:
        return "research-run"
    if table.endswith("_analyses") or table in {"editor_reports", "research_step_cache"}:
        return "research-result"
    if table in {"pattern_evidence", "scene_card_patterns", "story_events"}:
        return "research-evidence"
    return "research-source"


def scan_webfictionlab(path: Path, warnings: list[str], on_snapshot: Callable[[], None] | None = None) -> list[dict]:
    start_warning = len(warnings)
    if not path.is_file():
        warnings.append("WebFictionLab 数据库不存在：" + str(path))
        return []
    snapshot = read_sqlite_snapshot(path, warnings, on_snapshot)
    records: dict[str, dict] = {}
    table_records: dict[str, list[str]] = defaultdict(list)
    primary_index: dict[str, set[str]] = defaultdict(set)
    duplicates: dict[str, int] = defaultdict(int)
    for table, data in snapshot.items():
        for row in data["rows"]:
            identity = row_id(row, data["columns"])
            base = f"records/{quote(table, safe='')}/{quote(identity, safe='')}.json"
            duplicates[base] += 1
            record_path = base if duplicates[base] == 1 else base[:-5] + f"~{duplicates[base]}.json"
            records[record_path] = {"table": table, "identity": identity, "row": row, "links": [], "owners": set()}
            table_records[table].append(record_path)
            for column in data["columns"]:
                if column["pk"] and isinstance(row[column["name"]], (str, int)):
                    primary_index[str(row[column["name"]])].add(record_path)
    books: dict[str, dict] = {}
    for table, id_field, kind, prefix in [("books", "id", "reference", ""), ("writing_projects", "project_id", "novel", "project:")]:
        for record_path in table_records[table]:
            record = records[record_path]
            row = record["row"]
            if not isinstance(row.get(id_field), str) or not row.get(id_field) or not isinstance(row.get("title"), str):
                warnings.append(f"WebFictionLab/{table}/{record['identity']}：身份结构不明确，保留研究原始记录")
                continue
            key = "webfictionlab:" + prefix + row[id_field]
            record["owners"].add(key)
            books[key] = {"key": key, "source": "webfictionlab", "kind": kind, "title": row["title"], "hash": "",
                "chapters": [], "artifacts": [], "metadata": {"sourceId": row[id_field], "sourceTable": table,
                    "sourcePath": str(path), "extractor": EXTRACTOR, "sourceRecord": row,
                    "wordCountMetric": "unicode-alphanumeric-webfictionlab/1", "authorApproval": None}}
    # Foreign-key links retain UUIDs and composite dependency fields verbatim.
    for record_path, record in records.items():
        table, row = record["table"], record["row"]
        grouped: dict[int, list[dict]] = defaultdict(list)
        for fk in snapshot[table]["foreignKeys"]:
            grouped[fk["id"]].append(fk)
        for group in grouped.values():
            if any(row.get(fk["from"]) is None for fk in group):
                continue
            target_table = group[0]["table"]
            targets = []
            for target in table_records[target_table]:
                target_row = records[target]["row"]
                if all(target_row.get(fk["to"] or "id") == row[fk["from"]] for fk in group):
                    targets.append(target)
            if not targets:
                warnings.append(f"WebFictionLab/{table}/{record['identity']}：外键依赖缺失（{target_table}）")
            for target in targets:
                record["links"].append({"fields": [fk["from"] for fk in group], "target": target, "type": "foreign-key"})
        for field, value in row.items():
            if field.endswith("_id") and isinstance(value, (str, int)):
                for target in sorted(primary_index.get(str(value), set()) - {record_path}):
                    if not any(link["target"] == target for link in record["links"]):
                        record["links"].append({"fields": [field], "target": target, "type": "identity-reference"})
        record["links"].sort(key=canonical)
    # Child records inherit source ownership. A multi-book comparison belongs to
    # each referenced book; disconnected reusable assets get a reference bundle.
    changed = True
    while changed:
        changed = False
        for record in records.values():
            owners = set(record["owners"])
            for link in record["links"]:
                owners.update(records[link["target"]]["owners"])
            if owners != record["owners"]:
                record["owners"] = owners
                changed = True
    unowned = [r for r in records.values() if not r["owners"]]
    if unowned:
        key = "webfictionlab:research-assets"
        books[key] = {"key": key, "source": "webfictionlab", "kind": "reference", "title": "WebFictionLab 研究资料",
            "hash": "", "chapters": [], "artifacts": [], "metadata": {"sourceId": "research-assets", "sourcePath": str(path),
                "extractor": EXTRACTOR, "authorApproval": None, "unattached": True}}
        for record in unowned:
            record["owners"].add(key)
    for record_path, record in records.items():
        envelope = {"schema": 1, "source": "webfictionlab", "table": record["table"], "identity": record["identity"],
                    "row": record["row"], "links": record["links"]}
        item = artifact(record_path, record_kind(record["table"]), canonical(envelope))
        for owner in sorted(record["owners"]):
            books[owner]["artifacts"].append(item)
    schemas = {table: {k: v for k, v in data.items() if k != "rows"} for table, data in snapshot.items()}
    for book in books.values():
        book["artifacts"].append(artifact("schema/tables.json", "source-schema", canonical(schemas)))
        book["metadata"]["tableCounts"] = {t: len(d["rows"]) for t, d in snapshot.items()}
        book["metadata"]["warnings"] = warnings[start_warning:]
        book["metadata"]["excludedTables"] = ["app_settings", "credential-bearing tables"]
        chapter_map: dict[tuple[int, int], dict] = {}
        table = "chapters" if book["kind"] == "reference" else "writing_drafts"
        for record_path in table_records[table]:
            record = records[record_path]
            if book["key"] not in record["owners"]:
                continue
            row = record["row"]
            order = positive(row.get("chapter_number"))
            volume = positive(row.get("volume_number") or row.get("volume") or 1)
            if not order or not volume or not isinstance(row.get("raw_text"), str):
                warnings.append(f"WebFictionLab/{table}/{record['identity']}：章节结构不明确，仅保留原始记录")
                continue
            identity = volume, order
            chapter = chapter_map.setdefault(identity, {"key": f"{book['key']}:v{volume}:c{order}", "volume": volume,
                "order": order, "title": str(row.get("title") or f"第{order}章"), "content": "", "drafts": []})
            content = row["raw_text"]
            if book["kind"] == "reference":
                if chapter["content"]:
                    warnings.append(f"WebFictionLab/{table}/{record['identity']}：同卷章多条正文，完整原文保留在来源记录")
                else:
                    chapter["content"] = content
            else:
                version = positive(row.get("version")) or len(chapter["drafts"]) + 1
                chapter["drafts"].append({"key": "webfictionlab:" + record_path, "version": version, "raw": content,
                    "content": content, "candidateFacts": "", "hash": digest(content), "bodyHash": digest(content), "han": han_count(content)})
                chapter["content"] = content
        book["chapters"] = [chapter_map[i] for i in sorted(chapter_map)]
        book["artifacts"].sort(key=lambda a: a["path"])
        book["metadata"]["warnings"] = warnings[start_warning:]
        book["hash"] = book_hash(book)
    return [books[key] for key in sorted(books)]


def scan_sources(library: str | Path | None = None, wfl: str | Path | None = None) -> dict:
    warnings: list[str] = []
    books: list[dict] = []
    for label, value, scanner in [("Scriptor", library or os.environ.get("UNIFICATION_SCRIPTOR_LIBRARY", DEFAULT_LIBRARY), scan_scriptor),
                                  ("WebFictionLab", wfl or os.environ.get("UNIFICATION_WFL_DATABASE", DEFAULT_WFL), scan_webfictionlab)]:
        try:
            books.extend(scanner(checked_root(value), warnings))
        except (OSError, ValueError, sqlite3.Error, UnicodeError) as exc:
            warnings.append(f"{label}：只读扫描失败（{type(exc).__name__}：{exc}）")
    seen: set[str] = set()
    for book in books:
        if book["key"] in seen:
            warnings.append("来源作品身份重复，导入前需核对：" + book["key"])
        seen.add(book["key"])
    return {"schema": SCHEMA, "books": sorted(books, key=lambda b: b["key"]), "warnings": sorted(set(warnings))}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scriptor-library")
    parser.add_argument("--wfl-database")
    args = parser.parse_args()
    # Deliberately no debug/summary printing: stdout is one JSON document.
    json.dump(scan_sources(args.scriptor_library, args.wfl_database), sys.stdout, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
