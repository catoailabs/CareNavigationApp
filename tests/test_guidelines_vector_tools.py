from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from server.tool_catalog_support import build_catalog_overview, get_tool_details
from tools.guidelines.vector_store import query_guideline_vector_store, upsert_guideline_source


def _fake_embed_texts(texts: list[str]) -> list[list[float]]:
    vectors: list[list[float]] = []
    for text in texts:
        encoded = text.encode("utf-8")
        checksum = float(sum(encoded) % 997)
        vectors.append([float(len(encoded)), checksum, float(len(set(encoded)))])
    return vectors


def _fake_embed_text(text: str) -> list[float]:
    return _fake_embed_texts([text])[0]


class CatalogDiscoveryTests(unittest.TestCase):
    def test_healthcare_guideline_tools_are_discoverable(self) -> None:
        overview = build_catalog_overview(None)
        healthcare = next(category for category in overview["categories"] if category["id"] == "healthcare")
        names = {tool["name"] for tool in healthcare["tools"]}

        self.assertIn("guidelines_vector_health", names)
        self.assertIn("guidelines_vector_query", names)
        self.assertIn("guidelines_vector_upsert", names)
        self.assertIn("guidelines_vector_replace", names)

    def test_vendored_ronbrowser_tools_fill_catalog_gaps_without_overriding_local_tools(self) -> None:
        overview = build_catalog_overview(None)
        orchestration = next(category for category in overview["categories"] if category["id"] == "agent_orchestration")
        orchestration_names = {tool["name"] for tool in orchestration["tools"]}

        self.assertIn("swarm", orchestration_names)
        self.assertIn("graph", orchestration_names)
        self.assertIn("workflow", orchestration_names)

        swarm = get_tool_details(None, "swarm")
        self.assertIsNotNone(swarm)
        self.assertEqual(swarm["category"], "agent_orchestration")
        self.assertIn(
            "tools.ronbrowser_agent_tools.src.strands_tools.agent_orchestration.swarm",
            swarm["module_path"],
        )

        tool_catalog = get_tool_details(None, "tool_catalog")
        self.assertIsNotNone(tool_catalog)
        self.assertTrue(tool_catalog["path"].endswith("/tools/tool_catalog.py"))


class GuidelineStoreMutationTests(unittest.TestCase):
    def test_upsert_and_replace_update_faiss_store(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store_path = Path(temp_dir) / "guidelines_vector_store.json"

            inserted = upsert_guideline_source(
                _fake_embed_texts,
                source_path="standards/medical-necessity.md",
                document_text="Initial medical necessity criteria.",
                store_path=store_path,
                source_name="medical-necessity.md",
            )
            self.assertEqual(inserted["action"], "inserted")
            self.assertEqual(inserted["chunks_removed"], 0)
            self.assertGreater(inserted["chunks_added"], 0)

            queried = query_guideline_vector_store(
                "Initial medical necessity criteria.",
                _fake_embed_text,
                store_path=store_path,
                top_k=1,
            )
            self.assertEqual(queried["count"], 1)
            self.assertEqual(queried["results"][0]["source_path"], "standards/medical-necessity.md")

            replaced = upsert_guideline_source(
                _fake_embed_texts,
                source_path="standards/medical-necessity.md",
                document_text="Updated current standard for medical necessity review.",
                store_path=store_path,
                source_name="medical-necessity.md",
                replace_existing=True,
                require_existing=True,
            )
            self.assertEqual(replaced["action"], "replaced")
            self.assertGreater(replaced["chunks_removed"], 0)

            records_path = Path(replaced["records_path"])
            records = [json.loads(line) for line in records_path.read_text(encoding="utf-8").splitlines() if line.strip()]
            self.assertEqual(len(records), replaced["record_count"])
            self.assertTrue(
                all(record["source_path"] == "standards/medical-necessity.md" for record in records),
            )
            self.assertTrue(
                any("Updated current standard" in record["text"] for record in records),
            )
            self.assertFalse(
                any("Initial medical necessity criteria." in record["text"] for record in records),
            )


if __name__ == "__main__":
    unittest.main()
