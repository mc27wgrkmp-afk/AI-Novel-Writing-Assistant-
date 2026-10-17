"""Synthetic source fixtures only: no author manuscript or production DB writes."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCANNER = Path(__file__).resolve().parents[1] / "src/modules/unification/infrastructure/source_scan.py"
spec = importlib.util.spec_from_file_location("unification_source_scan", SCANNER)
scan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan)


class SourceScanTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="novel-source-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.library = self.root / "library"
        self.library.mkdir()
        self.db = self.root / "source.sqlite3"

    def write(self, path: Path, content: str):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content.encode("utf-8"))

    def book(self, name="测试作品", source_id="test-book") -> Path:
        book = self.library / name
        self.write(book / "作品契约/契约.md", f"---\n书id: {source_id}\n---\n# 写作契约\n每章要求。\n")
        self.outline(book, 1, 1, "第一章 夜班")
        self.write(book / "大纲/卷规划/卷01/近期窗口.md", "# 近期窗口\n- 第一章 夜班 〔已确认〕\n- 第二章 找零 〔已确认〕\n- 第三章 收银 〔已确认〕\n")
        return book

    def outline(self, book: Path, volume: int, order: int, title: str):
        self.write(book / f"大纲/卷规划/卷{volume:02d}/章细纲/{order:04d}-{title}.md",
                   f"---\n身份:\n  卷: {volume}\n  章: {order}\n  章名: {title}\n---\n# 细纲\n测试规划。\n")

    def draft(self, book: Path, version=1, folder="卷01-第一章 夜班", body="# 第一章 夜班\n甲乙丙。", facts="- 人物说：测试。", newline="\n") -> tuple[str, str]:
        path = f"草稿区/草稿/{folder}/稿{version}.md"
        raw = f"---\n版本: {version}\n父版本: {version - 1 if version > 1 else ''}\n角色: 待审稿\n---\n\n{body}\n\n## 草稿候选事实\n{facts}\n".replace("\n", newline)
        self.write(book / path, raw)
        return path, raw

    def database(self, wal=False) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db)
        if wal:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA wal_autocheckpoint=0")
        connection.executescript("""
            CREATE TABLE books(id TEXT PRIMARY KEY, title TEXT NOT NULL, word_count INTEGER);
            CREATE TABLE chapters(id TEXT PRIMARY KEY, book_id TEXT REFERENCES books(id), chapter_number INTEGER,
                title TEXT, raw_text TEXT, local_word_count INTEGER, word_count INTEGER);
            CREATE TABLE opening_analysis_runs(id TEXT PRIMARY KEY, book_id TEXT REFERENCES books(id), status TEXT,
                prompt_version TEXT, created_at TEXT);
            CREATE TABLE opening_analyses(run_id TEXT PRIMARY KEY REFERENCES opening_analysis_runs(id), analysis_json TEXT);
            CREATE TABLE writing_projects(project_id TEXT PRIMARY KEY, title TEXT);
            CREATE TABLE writing_drafts(draft_id TEXT PRIMARY KEY, project_id TEXT REFERENCES writing_projects(project_id),
                chapter_number INTEGER, title TEXT, raw_text TEXT, created_at TEXT);
            CREATE TABLE app_settings(key TEXT PRIMARY KEY, value TEXT);
        """)
        connection.execute("INSERT INTO books VALUES ('ref-uuid','参考作品',100)")
        connection.execute("INSERT INTO chapters VALUES ('ch-uuid','ref-uuid',1,'开篇','示例正文。',5,5)")
        connection.commit()
        self.addCleanup(connection.close)
        return connection

    def test_seven_raw_versions_frontmatter_candidates_and_plans(self):
        book = self.book()
        raws = []
        for version in range(1, 8):
            raws.append(self.draft(book, version, newline="\r\n" if version == 1 else "\n"))
        warnings = []
        result = scan.scan_scriptor(self.library, warnings)[0]
        self.assertEqual([], warnings)
        self.assertEqual("scriptor:test-book", result["key"])
        self.assertEqual([1, 2, 3], [c["order"] for c in result["chapters"]])
        chapter = result["chapters"][0]
        self.assertEqual(7, len(chapter["drafts"]))
        for draft, (path, raw) in zip(chapter["drafts"], raws):
            self.assertEqual(raw, draft["raw"])
            self.assertEqual(hashlib.sha256(raw.encode()).hexdigest(), draft["hash"])
            self.assertEqual(hashlib.sha256(draft["content"].encode()).hexdigest(), draft["bodyHash"])
            self.assertNotIn("候选事实", draft["content"])
            self.assertNotIn("版本:", draft["content"])
            self.assertEqual("- 人物说：测试。", draft["candidateFacts"])
            self.assertTrue(any(a["path"] == path + "#frontmatter" for a in result["artifacts"]))
            self.assertEqual(scan.han_count(draft["content"]), draft["han"])
        for chapter in result["chapters"][1:]:
            self.assertEqual("", chapter["content"])
            self.assertEqual([], chapter["drafts"])
        self.assertEqual(0, result["metadata"]["finalCount"])
        self.assertIsNone(result["metadata"]["authorApproval"])

    def test_cross_volume_same_title_is_not_merged(self):
        book = self.book()
        self.outline(book, 2, 1, "第一章 夜班")
        self.draft(book, folder="卷01-第一章 夜班", body="第一卷。")
        self.draft(book, folder="卷02-第一章 夜班", body="第二卷。")
        warnings = []
        result = scan.scan_scriptor(self.library, warnings)[0]
        chapters = {(c["volume"], c["order"]): c for c in result["chapters"]}
        self.assertEqual("第一卷。", chapters[1, 1]["content"])
        self.assertEqual("第二卷。", chapters[2, 1]["content"])
        self.assertNotEqual(chapters[1, 1]["key"], chapters[2, 1]["key"])
        self.assertFalse(warnings)

    def test_identity_conflict_keeps_raw_artifact_without_assigning_draft(self):
        book = self.book()
        path, raw = self.draft(book, folder="卷01-0002-第一章 夜班")
        warnings = []
        result = scan.scan_scriptor(self.library, warnings)[0]
        self.assertTrue(any("细纲冲突" in warning for warning in warnings))
        self.assertFalse(any(c["drafts"] for c in result["chapters"]))
        self.assertEqual(raw, next(a["content"] for a in result["artifacts"] if a["path"] == path))

    def test_frontmatter_identity_must_match_outline_path(self):
        book = self.book()
        path = book / "大纲/卷规划/卷01/章细纲/0001-第一章 夜班.md"
        self.write(path, "---\n身份:\n  卷: 2\n  章: 1\n  章名: 第一章 夜班\n---\n细纲。")
        self.draft(book)
        warnings = []
        result = scan.scan_scriptor(self.library, warnings)[0]
        self.assertTrue(any("身份冲突" in w for w in warnings))
        self.assertEqual(0, sum(len(c["drafts"]) for c in result["chapters"]))

    def test_malformed_boundaries_never_become_prose(self):
        book = self.book()
        path, _ = self.draft(book)
        self.write(book / path, "---\n版本: 1\n# 未闭合元数据\n正文。")
        warnings = []
        result = scan.scan_scriptor(self.library, warnings)[0]
        self.assertTrue(any("未闭合" in w for w in warnings))
        self.assertEqual("", result["chapters"][0]["content"])
        fm, body, candidates = scan.split_manuscript("正文\n## 草稿候选事实\n候选\n## 草稿候选事实\n另一段", "fixture", warnings)
        self.assertEqual(("", ""), (body, candidates))

    def test_hash_covers_materials_and_candidate_changes_but_body_hash_does_not(self):
        book = self.book()
        path, _ = self.draft(book)
        first = scan.scan_scriptor(self.library, [])[0]
        second = scan.scan_scriptor(self.library, [])[0]
        self.assertEqual(first, second)
        self.draft(book, facts="- 改动候选材料。")
        changed = scan.scan_scriptor(self.library, [])[0]
        self.assertNotEqual(first["hash"], changed["hash"])
        self.assertEqual(first["chapters"][0]["drafts"][0]["bodyHash"], changed["chapters"][0]["drafts"][0]["bodyHash"])
        self.write(book / "草稿区/材料包/01.md", "上下文材料。")
        self.assertNotEqual(changed["hash"], scan.scan_scriptor(self.library, [])[0]["hash"])

    def test_pending_final_frontmatter_is_not_final_approval(self):
        book = self.book()
        self.draft(book)
        self.write(book / "草稿区/定稿准备/卷01-第一章 夜班/正文.md", "---\n状态: 已定稿\n---\n待定正文。")
        self.write(book / "草稿区/审核/old.json", '{"完成": true}')
        self.write(book / "草稿区/定稿准备/卷01-第一章 夜班/章摘要.md", "摘要候选。")
        result = scan.scan_scriptor(self.library, [])[0]
        self.assertEqual(0, result["metadata"]["finalCount"])
        self.assertEqual(1, len(result["chapters"][0]["drafts"]))
        self.assertTrue(any(a["kind"] == "legacy-review" for a in result["artifacts"]))
        self.assertTrue(any(a["kind"] == "pending-summary" for a in result["artifacts"]))
        self.write(book / "定稿/卷01/0001-第一章 夜班/正文.md", "实际定稿正文。")
        result = scan.scan_scriptor(self.library, [])[0]
        self.assertEqual(1, result["metadata"]["finalCount"])
        self.assertEqual("实际定稿正文。", result["chapters"][0]["content"])
        self.assertIsNone(result["metadata"]["authorApproval"])

    def test_symlinks_traversal_and_private_files_are_refused(self):
        book = self.book()
        outside = self.root / "outside.md"
        outside.write_text("SHOULD_NOT_EXPORT", encoding="utf-8")
        (book / "世界书").mkdir()
        (book / "世界书/link.md").symlink_to(outside)
        (self.library / "linked-book").symlink_to(book, target_is_directory=True)
        self.write(book / ".git/private.md", "SHOULD_NOT_EXPORT")
        self.write(book / "世界书/.env.local", "SHOULD_NOT_EXPORT")
        self.write(book / ".scriptor/credentials/secret.json", '"SHOULD_NOT_EXPORT"')
        self.write(book / ".webnovel/operations/private.json", '"SHOULD_NOT_EXPORT"')
        warnings = []
        result = scan.scan_scriptor(self.library, warnings)
        self.assertTrue(any("软链接" in w for w in warnings))
        self.assertNotIn("SHOULD_NOT_EXPORT", json.dumps(result))
        with self.assertRaises(ValueError):
            scan.read_source(book, "../outside.md")
        with self.assertRaises(ValueError):
            scan.read_source(book, str(outside))
        with self.assertRaises(ValueError):
            scan.read_source(book, "世界书/link.md")
        with self.assertRaises(ValueError):
            scan.checked_root(self.root / "library/../outside.md")
        with self.assertRaises(ValueError):
            scan.checked_root(self.library / "linked-book/世界书")

    def test_reference_history_and_uuid_dependencies_preserved(self):
        connection = self.database()
        for run in ("run-old", "run-new"):
            connection.execute("INSERT INTO opening_analysis_runs VALUES (?, 'ref-uuid', 'succeeded', 'v1', '2026-01-01')", (run,))
            evidence = json.dumps({"evidence": [{"chapter_id": "ch-uuid", "quote": "示例证据"}], "history": run}, ensure_ascii=False)
            connection.execute("INSERT INTO opening_analyses VALUES (?, ?)", (run, evidence))
        connection.commit()
        before = self.db.read_bytes()
        before_stat = self.db.stat().st_mtime_ns
        warnings = []
        books = scan.scan_webfictionlab(self.db, warnings)
        result = next(b for b in books if b["key"] == "webfictionlab:ref-uuid")
        self.assertEqual([], warnings)
        self.assertEqual("reference", result["kind"])
        self.assertEqual("示例正文。", result["chapters"][0]["content"])
        histories = [json.loads(a["content"]) for a in result["artifacts"] if a["path"].startswith("records/opening_analyses/")]
        self.assertEqual(2, len(histories))
        self.assertEqual({"run-old", "run-new"}, {h["row"]["run_id"] for h in histories})
        for history in histories:
            self.assertEqual("ch-uuid", json.loads(history["row"]["analysis_json"])["evidence"][0]["chapter_id"])
            self.assertTrue(any("opening_analysis_runs" in link["target"] for link in history["links"]))
        self.assertEqual(before, self.db.read_bytes())
        self.assertEqual(before_stat, self.db.stat().st_mtime_ns)
        self.assertEqual(books, scan.scan_webfictionlab(self.db, []))

    def test_writing_projects_are_novels_and_retain_each_draft(self):
        connection = self.database()
        connection.execute("INSERT INTO writing_projects VALUES ('project-uuid','创作项目')")
        connection.execute("INSERT INTO writing_drafts VALUES ('d-1','project-uuid',1,'一章','第一稿正文。','2026-01-01')")
        connection.execute("INSERT INTO writing_drafts VALUES ('d-2','project-uuid',1,'一章','第二稿正文。','2026-01-02')")
        connection.commit()
        books = scan.scan_webfictionlab(self.db, [])
        reference = next(b for b in books if b["key"] == "webfictionlab:ref-uuid")
        novel = next(b for b in books if b["key"] == "webfictionlab:project:project-uuid")
        self.assertEqual("reference", reference["kind"])
        self.assertEqual("novel", novel["kind"])
        self.assertEqual(2, len(novel["chapters"][0]["drafts"]))
        self.assertEqual("第二稿正文。", novel["chapters"][0]["content"])
        self.assertIsNone(novel["metadata"]["authorApproval"])
        self.assertTrue(all("project-uuid" not in a["path"] for a in reference["artifacts"]))

    def test_unknown_research_assets_preserved_credentials_excluded(self):
        connection = self.database()
        connection.executescript("""
            CREATE TABLE new_research_assets(id TEXT PRIMARY KEY, evidence_json TEXT, payload BLOB);
            CREATE TABLE account_credentials(id TEXT PRIMARY KEY, access_token TEXT);
            INSERT INTO new_research_assets VALUES ('unknown-uuid', '{"chapter":"ch-uuid"}', X'0102');
            INSERT INTO account_credentials VALUES ('account', 'SHOULD_NOT_EXPORT');
            INSERT INTO app_settings VALUES ('secret', 'SHOULD_NOT_EXPORT');
        """)
        connection.commit()
        warnings = []
        books = scan.scan_webfictionlab(self.db, warnings)
        self.assertNotIn("SHOULD_NOT_EXPORT", json.dumps(books))
        self.assertTrue(any("new_research_assets" in w for w in warnings))
        asset = next(a for b in books for a in b["artifacts"] if a["path"].startswith("records/new_research_assets/"))
        envelope = json.loads(asset["content"])
        self.assertEqual('{"chapter":"ch-uuid"}', envelope["row"]["evidence_json"])
        self.assertEqual({"$binaryBase64": "AQI="}, envelope["row"]["payload"])
        self.assertTrue(all(b["kind"] == "reference" for b in books))

    def test_wal_committed_data_and_consistent_snapshot(self):
        connection = self.database(wal=True)
        connection.execute("INSERT INTO opening_analysis_runs VALUES ('already-committed','ref-uuid','succeeded','v1','2026-01-01')")
        connection.commit()
        self.assertTrue(self.db.with_name(self.db.name + "-wal").is_file())

        def concurrent_commit():
            connection.execute("INSERT INTO chapters VALUES ('later-ch','ref-uuid',2,'二章','后续正文。',5,5)")
            connection.execute("INSERT INTO opening_analysis_runs VALUES ('later-run','ref-uuid','succeeded','v2','2026-01-02')")
            connection.commit()

        pinned = scan.scan_webfictionlab(self.db, [], concurrent_commit)
        reference = next(b for b in pinned if b["key"] == "webfictionlab:ref-uuid")
        self.assertEqual(1, len(reference["chapters"]))
        paths = [a["path"] for a in reference["artifacts"]]
        self.assertTrue(any("already-committed" in p for p in paths))
        self.assertFalse(any("later-run" in p for p in paths))
        latest = next(b for b in scan.scan_webfictionlab(self.db, []) if b["key"] == "webfictionlab:ref-uuid")
        self.assertEqual(2, len(latest["chapters"]))
        self.assertTrue(any("later-run" in a["path"] for a in latest["artifacts"]))
        self.assertNotEqual(reference["hash"], latest["hash"])

    def test_environment_source_paths_and_mode_ro(self):
        self.book()
        self.database()
        real_connect = sqlite3.connect
        opened = []

        def readonly_connection(database, **kwargs):
            opened.append((database, kwargs))
            return real_connect(database, **kwargs)

        with patch.dict(os.environ, {"UNIFICATION_SCRIPTOR_LIBRARY": str(self.library), "UNIFICATION_WFL_DATABASE": str(self.db)}):
            with patch.object(scan.sqlite3, "connect", readonly_connection):
                bundle = scan.scan_sources()
        self.assertEqual(1, bundle["schema"])
        self.assertEqual(2, len(bundle["books"]))
        self.assertTrue(opened[0][1]["uri"])
        self.assertIn("?mode=ro", opened[0][0])

    def test_duplicate_book_identity_is_visible(self):
        self.book("作品甲", "same-id")
        self.book("作品乙", "same-id")
        self.database()
        bundle = scan.scan_sources(self.library, self.db)
        self.assertTrue(any("身份重复" in w for w in bundle["warnings"]))
        self.assertEqual(2, sum(b["source"] == "scriptor" for b in bundle["books"]))


if __name__ == "__main__":
    unittest.main()
