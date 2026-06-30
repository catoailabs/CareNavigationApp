"""Guideline corpus embedding index + query helpers."""

from __future__ import annotations

import json
import logging
import os
import shutil
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

import httpx

logger = logging.getLogger(__name__)
logging.getLogger("pypdf").setLevel(logging.ERROR)
logging.getLogger("pypdf._reader").setLevel(logging.ERROR)
logging.getLogger("pypdf._utils").setLevel(logging.ERROR)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_GUIDELINES_DIR = PROJECT_ROOT / "src" / "data" / "Guidelines"
DEFAULT_VECTOR_STORE_PATH = PROJECT_ROOT / "src" / "data" / "runtime" / "guidelines_vector_store.json"
PERPLEXITY_GUIDELINE_EMBEDDING_MODEL = "pplx-embed-context-v1-4b"
GUIDELINE_CONTEXT_WINDOW_CHARS = 220
FAISS_BACKEND = "faiss"
DEFAULT_TEXT_SUFFIXES = {
    ".txt",
    ".md",
    ".csv",
    ".json",
    ".yml",
    ".yaml",
    ".xml",
    ".html",
    ".htm",
    ".rst",
    ".pdf",
}
MAX_TEXT_BYTES = 2_000_000
MAX_PDF_PAGE_CONTENT_STREAM_BYTES = 32_000_000
SCHEMA_VERSION = 1
CHECKPOINT_DIR_SUFFIX = ".checkpoint"
CHECKPOINT_META_FILENAME = "meta.json"
CHECKPOINT_RECORDS_FILENAME = "records.jsonl"
RECORDS_FILENAME_SUFFIX = ".records.jsonl"
OFFSETS_FILENAME_SUFFIX = ".offsets.json"
INDEX_FILENAME_SUFFIX = ".faiss"
MAX_SAFE_MANIFEST_BYTES = 32_000_000
DEFAULT_EMBED_BATCH_SIZE = 64
CHECKPOINT_FSYNC_EVERY_BATCHES = 8
RESUME_META_WRITE_EVERY_CHUNKS = 512
CONTEXTUALIZED_EMBEDDINGS_DOC_TOKEN_BUDGET = 30_000
CONTEXTUALIZED_EMBEDDINGS_HARD_TOKEN_LIMIT = 32_000
APPROX_CHARS_PER_TOKEN = 3


@dataclass
class GuidelineChunkRecord:
    """One embedded guideline chunk persisted in the vector store."""

    chunk_id: str
    source_path: str
    source_name: str
    chunk_index: int
    text: str
    vector: list[float]
    model: str
    metadata: dict[str, Any]


def _faiss_imports() -> tuple[Any, Any]:
    try:
        import faiss  # type: ignore
    except Exception as exc:
        raise RuntimeError(
            "faiss is required for guideline semantic retrieval. "
            "Install faiss-cpu in the runtime environment."
        ) from exc

    try:
        import numpy as np
    except Exception as exc:
        raise RuntimeError("numpy is required for FAISS guideline retrieval.") from exc

    return faiss, np


def _store_prefix(store_path: Path) -> Path:
    return store_path.parent / store_path.stem


def _faiss_index_path(store_path: Path) -> Path:
    return store_path.parent / f"{store_path.stem}{INDEX_FILENAME_SUFFIX}"


def _faiss_records_path(store_path: Path) -> Path:
    return store_path.parent / f"{store_path.stem}{RECORDS_FILENAME_SUFFIX}"


def _faiss_offsets_path(store_path: Path) -> Path:
    return store_path.parent / f"{store_path.stem}{OFFSETS_FILENAME_SUFFIX}"


def _normalize_vectors(vectors: list[list[float]], np: Any, faiss: Any) -> Any:
    matrix = np.asarray(vectors, dtype="float32")
    if matrix.ndim == 1:
        matrix = matrix.reshape(1, -1)
    if matrix.size == 0:
        return matrix
    faiss.normalize_L2(matrix)
    return matrix


def _sample_records_by_offsets(
    records_path: Path,
    offsets_path: Path,
    indices: list[int],
) -> list[dict[str, Any]]:
    if not records_path.exists() or not offsets_path.exists():
        return []
    offsets = json.loads(offsets_path.read_text(encoding="utf-8"))
    if not isinstance(offsets, list):
        return []

    results: list[dict[str, Any]] = []
    with records_path.open("r", encoding="utf-8") as handle:
        for idx in indices:
            if idx < 0 or idx >= len(offsets):
                continue
            handle.seek(int(offsets[idx]))
            line = handle.readline()
            if not line:
                continue
            results.append(json.loads(line))
    return results


def _chunk_text(text: str, chunk_chars: int, chunk_overlap: int) -> list[str]:
    text = (text or "").strip()
    if not text:
        return []
    if chunk_chars <= 0:
        raise ValueError("chunk_chars must be > 0")
    if chunk_overlap < 0:
        raise ValueError("chunk_overlap must be >= 0")
    if chunk_overlap >= chunk_chars:
        raise ValueError("chunk_overlap must be smaller than chunk_chars")

    chunks: list[str] = []
    start = 0
    length = len(text)
    while start < length:
        end = min(length, start + chunk_chars)
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= length:
            break
        start = end - chunk_overlap
    return chunks


def _contextualize_chunk(
    *,
    source_path: str,
    source_name: str,
    chunk_index: int,
    total_chunks: int,
    current_chunk: str,
    previous_chunk: str | None,
    next_chunk: str | None,
    context_window_chars: int,
) -> str:
    """Build contextualized embedding text with local document context."""
    prev_excerpt = (previous_chunk or "")[-context_window_chars:].strip()
    next_excerpt = (next_chunk or "")[:context_window_chars].strip()

    parts: list[str] = [
        "[CHUNK_METADATA]",
        f"source_path: {source_path}",
        f"source_name: {source_name}",
        f"chunk_position: {chunk_index + 1}/{total_chunks}",
        "[/CHUNK_METADATA]",
    ]

    if prev_excerpt:
        parts.extend(
            [
                "[PREVIOUS_CONTEXT]",
                prev_excerpt,
                "[/PREVIOUS_CONTEXT]",
            ]
        )
    if next_excerpt:
        parts.extend(
            [
                "[NEXT_CONTEXT]",
                next_excerpt,
                "[/NEXT_CONTEXT]",
            ]
        )
    parts.extend(["[CURRENT_CHUNK]", current_chunk, "[/CURRENT_CHUNK]"])
    return "\n".join(parts)


def _read_text_file(path: Path) -> str | None:
    suffix = path.suffix.lower()
    try:
        if suffix == ".pdf":
            try:
                from pypdf import PdfReader  # type: ignore
            except Exception:
                logger.warning("Skipping PDF without pypdf installed: %s", path)
                return None
            reader = PdfReader(str(path), strict=False)
            pages: list[str] = []
            total_pages = 0
            text_pages = 0
            accumulated_chars = 0
            for page_number, page in enumerate(reader.pages, start=1):
                total_pages += 1
                try:
                    page_contents = page.get_contents()
                    if page_contents is not None:
                        content_bytes = len(page_contents.get_data())
                        if content_bytes > MAX_PDF_PAGE_CONTENT_STREAM_BYTES:
                            logger.warning(
                                "Skipping oversized PDF page content stream | path=%s page=%s bytes=%s limit=%s",
                                path,
                                page_number,
                                content_bytes,
                                MAX_PDF_PAGE_CONTENT_STREAM_BYTES,
                            )
                            continue
                except Exception as exc:
                    logger.warning(
                        "Unable to inspect PDF page content stream | path=%s page=%s error=%s",
                        path,
                        page_number,
                        exc,
                    )
                page_text = page.extract_text() or ""
                if page_text:
                    text_pages += 1
                    remaining_chars = MAX_TEXT_BYTES - accumulated_chars
                    if remaining_chars <= 0:
                        logger.info(
                            "Truncating PDF extraction at MAX_TEXT_BYTES | path=%s pages=%s text_pages=%s chars=%s",
                            path,
                            total_pages,
                            text_pages,
                            accumulated_chars,
                        )
                        break
                    clipped = page_text[:remaining_chars]
                    pages.append(clipped)
                    accumulated_chars += len(clipped)
            extracted = "\n".join(pages).strip()
            if extracted:
                logger.info(
                    "PDF extracted | path=%s total_pages=%s text_pages=%s chars=%s",
                    path,
                    total_pages,
                    text_pages,
                    len(extracted),
                )
                return extracted
            logger.warning(
                "PDF produced no extractable text | path=%s total_pages=%s text_pages=%s",
                path,
                total_pages,
                text_pages,
            )
            return None

        raw = path.read_bytes()
        if len(raw) > MAX_TEXT_BYTES:
            raw = raw[:MAX_TEXT_BYTES]
        return raw.decode("utf-8", errors="ignore").strip() or None
    except Exception as exc:
        logger.warning("Failed reading guideline file %s: %s", path, exc)
        return None


def _iter_guideline_files(
    guidelines_dir: Path,
    include_suffixes: set[str] | None = None,
    max_files: int | None = None,
) -> Iterable[Path]:
    suffixes = include_suffixes or DEFAULT_TEXT_SUFFIXES
    if max_files is not None and max_files <= 0:
        return
    seen = 0
    for path in sorted(guidelines_dir.rglob("*")):
        if not path.is_file():
            continue
        if path.name.startswith("."):
            continue
        if path.suffix.lower() not in suffixes:
            continue
        if max_files is not None and seen >= max_files:
            return
        yield path
        seen += 1


def load_guideline_vector_store(
    store_path: Path = DEFAULT_VECTOR_STORE_PATH,
) -> dict[str, Any]:
    """Load vector store payload; return empty skeleton when missing."""
    if not store_path.exists():
        return {
            "schema_version": SCHEMA_VERSION,
            "backend": FAISS_BACKEND,
            "created_at": None,
            "stats": {"files_indexed": 0, "chunks_indexed": 0},
            "index_path": str(_faiss_index_path(store_path)),
            "records_path": str(_faiss_records_path(store_path)),
            "offsets_path": str(_faiss_offsets_path(store_path)),
        }
    payload = json.loads(store_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Invalid vector store payload type at {store_path}")
    if "records" in payload:
        raise ValueError(
            f"Legacy inline-record guideline stores are no longer supported: {store_path}"
        )
    payload.setdefault("backend", FAISS_BACKEND)
    if payload.get("backend") != FAISS_BACKEND:
        raise ValueError(f"Unsupported guideline vector store backend at {store_path}")
    payload.setdefault("stats", {})
    payload.setdefault("index_path", str(_faiss_index_path(store_path)))
    payload.setdefault("records_path", str(_faiss_records_path(store_path)))
    payload.setdefault("offsets_path", str(_faiss_offsets_path(store_path)))
    return payload


def _checkpoint_dir_for_store(store_path: Path) -> Path:
    return store_path.parent / f"{store_path.name}{CHECKPOINT_DIR_SUFFIX}"


def _checkpoint_meta_path(store_path: Path) -> Path:
    return _checkpoint_dir_for_store(store_path) / CHECKPOINT_META_FILENAME


def _checkpoint_records_path(store_path: Path) -> Path:
    return _checkpoint_dir_for_store(store_path) / CHECKPOINT_RECORDS_FILENAME


def _load_checkpoint_meta(meta_path: Path) -> dict[str, Any] | None:
    if not meta_path.exists():
        return None
    try:
        payload = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("Ignoring unreadable checkpoint meta %s: %s", meta_path, exc)
        return None
    if not isinstance(payload, dict):
        logger.warning("Ignoring invalid checkpoint meta type at %s", meta_path)
        return None
    return payload


def _write_checkpoint_meta(meta_path: Path, payload: dict[str, Any]) -> None:
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(payload, ensure_ascii=True, indent=2), encoding="utf-8")


def _checkpoint_run_config_key(payload: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    return {
        "guidelines_dir": payload.get("guidelines_dir"),
        "store_path": payload.get("store_path"),
        "model": payload.get("model"),
        "max_files": payload.get("max_files"),
        "max_chunks": payload.get("max_chunks"),
        "chunk_chars": payload.get("chunk_chars"),
        "chunk_overlap": payload.get("chunk_overlap"),
        "use_contextualized_embeddings": payload.get("use_contextualized_embeddings"),
        "context_window_chars": payload.get("context_window_chars"),
    }


def _count_jsonl_records(records_path: Path) -> int:
    if not records_path.exists():
        return 0
    count = 0
    with records_path.open("r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line:
                continue
            try:
                json.loads(line)
            except Exception:
                break
            count += 1
    return count


def _iter_jsonl_records(records_path: Path) -> Iterable[dict[str, Any]]:
    if not records_path.exists():
        return
    with records_path.open("r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line:
                continue
            yield json.loads(line)


def _read_last_jsonl_record(records_path: Path) -> dict[str, Any] | None:
    if not records_path.exists() or records_path.stat().st_size == 0:
        return None
    with records_path.open("rb") as handle:
        handle.seek(0, os.SEEK_END)
        file_size = handle.tell()
        buffer = bytearray()
        position = file_size
        while position > 0:
            read_size = min(8192, position)
            position -= read_size
            handle.seek(position)
            block = handle.read(read_size)
            buffer[:0] = block
            lines = buffer.splitlines()
            while lines:
                candidate = lines.pop()
                if not candidate.strip():
                    continue
                try:
                    return json.loads(candidate.decode("utf-8"))
                except Exception:
                    continue
        line = buffer.decode("utf-8").strip()
        if not line:
            return None
        try:
            return json.loads(line)
        except Exception:
            return None


def _derive_resume_cursor(
    *,
    candidate_files: list[Path],
    guidelines_dir: Path,
    checkpoint_meta: dict[str, Any],
    checkpoint_records_path: Path,
    resume_index: int,
) -> dict[str, int | str] | None:
    cursor = checkpoint_meta.get("resume_cursor")
    if isinstance(cursor, dict):
        try:
            return {
                "file_index": int(cursor["file_index"]),
                "source_path": str(cursor["source_path"]),
                "next_chunk_index": int(cursor["next_chunk_index"]),
            }
        except Exception:
            logger.warning("Ignoring invalid resume cursor in checkpoint meta")

    if resume_index <= 0:
        return None

    last_record = _read_last_jsonl_record(checkpoint_records_path)
    if not isinstance(last_record, dict):
        return None

    source_path = str(last_record.get("source_path", ""))
    if not source_path:
        return None

    candidate_index_by_source_path = {
        str(path.relative_to(guidelines_dir)): idx
        for idx, path in enumerate(candidate_files)
    }
    file_index = candidate_index_by_source_path.get(source_path)
    if file_index is None:
        logger.warning("Resume cursor source path not found in candidate files: %s", source_path)
        return None
    try:
        chunk_index = int(last_record.get("chunk_index", -1))
    except Exception:
        return None
    return {
        "file_index": file_index,
        "source_path": source_path,
        "next_chunk_index": chunk_index + 1,
    }


def _iter_chunk_items(
    *,
    candidate_files: list[Path],
    guidelines_dir: Path,
    chunk_chars: int,
    chunk_overlap: int,
    max_chunks: int | None,
    start_file_index: int = 0,
    start_chunk_index: int = 0,
    initial_files_indexed: int = 0,
    initial_files_skipped: int = 0,
    initial_emitted_chunks: int = 0,
) -> Iterable[tuple[dict[str, Any], dict[str, int]]]:
    files_indexed = initial_files_indexed
    files_skipped = initial_files_skipped
    emitted_chunks = initial_emitted_chunks
    total_candidates = len(candidate_files)

    for file_index in range(start_file_index, total_candidates):
        file_path = candidate_files[file_index]
        file_idx = file_index + 1
        rel_path = str(file_path.relative_to(guidelines_dir))
        logger.info(
            "Guideline file %s/%s | reading=%s",
            file_idx,
            total_candidates,
            rel_path,
        )
        text = _read_text_file(file_path)
        if not text:
            files_skipped += 1
            logger.info(
                "Guideline file %s/%s | skipped=%s",
                file_idx,
                total_candidates,
                rel_path,
            )
            continue
        file_chunks = _chunk_text(text, chunk_chars=chunk_chars, chunk_overlap=chunk_overlap)
        if not file_chunks:
            files_skipped += 1
            logger.info(
                "Guideline file %s/%s | no_chunks=%s",
                file_idx,
                total_candidates,
                rel_path,
            )
            continue
        source_path = str(file_path.relative_to(guidelines_dir))
        total_chunks = len(file_chunks)
        logger.info(
            "Guideline file %s/%s | prepared_chunks=%s path=%s",
            file_idx,
            total_candidates,
            total_chunks,
            rel_path,
        )
        resume_chunk_index = start_chunk_index if file_index == start_file_index else 0
        file_already_counted = file_index == start_file_index and resume_chunk_index > 0
        if not file_already_counted:
            files_indexed += 1
        if resume_chunk_index >= total_chunks:
            continue
        for idx in range(resume_chunk_index, total_chunks):
            chunk = file_chunks[idx]
            previous_chunk = file_chunks[idx - 1] if idx > 0 else None
            next_chunk = file_chunks[idx + 1] if idx + 1 < total_chunks else None
            emitted_chunks += 1
            yield (
                {
                    "file_index": file_index,
                    "file_path": file_path,
                    "source_path": source_path,
                    "chunk_index": idx,
                    "chunk_text": chunk,
                    "embedding_text": _contextualize_chunk(
                        source_path=source_path,
                        source_name=file_path.name,
                        chunk_index=idx,
                        total_chunks=total_chunks,
                        current_chunk=chunk,
                        previous_chunk=previous_chunk,
                        next_chunk=next_chunk,
                        context_window_chars=GUIDELINE_CONTEXT_WINDOW_CHARS,
                    ),
                    "total_chunks": total_chunks,
                },
                {
                    "files_indexed": files_indexed,
                    "files_skipped": files_skipped,
                    "chunks_discovered": emitted_chunks,
                    "candidate_files": total_candidates,
                },
            )
            if max_chunks is not None and emitted_chunks >= max_chunks:
                logger.info(
                    "Reached max_chunks=%s after file %s/%s",
                    max_chunks,
                    file_idx,
                    total_candidates,
                )
                return


def _estimate_token_count(text: str) -> int:
    """Return a conservative token estimate for contextual embedding payload limits."""
    if not text:
        return 0
    return max(1, (len(text) + (APPROX_CHARS_PER_TOKEN - 1)) // APPROX_CHARS_PER_TOKEN)


def build_guideline_vector_store(
    embed_texts: Callable[[list[str]], list[list[float]]],
    *,
    guidelines_dir: Path = DEFAULT_GUIDELINES_DIR,
    store_path: Path = DEFAULT_VECTOR_STORE_PATH,
    max_files: int | None = None,
    max_chunks: int | None = None,
    chunk_chars: int = 1200,
    chunk_overlap: int = 160,
    batch_size: int = DEFAULT_EMBED_BATCH_SIZE,
    batch_pause_seconds: float = 0.0,
    force_rebuild: bool = False,
) -> dict[str, Any]:
    """Build and persist guideline embedding vector store from local corpus."""
    if not guidelines_dir.exists():
        raise FileNotFoundError(f"Guidelines directory not found: {guidelines_dir}")
    if batch_size <= 0:
        raise ValueError("batch_size must be > 0")
    if batch_pause_seconds < 0:
        raise ValueError("batch_pause_seconds must be >= 0")

    checkpoint_dir = _checkpoint_dir_for_store(store_path)
    checkpoint_meta_path = _checkpoint_meta_path(store_path)
    checkpoint_records_path = _checkpoint_records_path(store_path)

    if force_rebuild:
        if store_path.exists():
            store_path.unlink()
        if checkpoint_dir.exists():
            shutil.rmtree(checkpoint_dir, ignore_errors=True)

    if not force_rebuild and store_path.exists():
        store_size_bytes = store_path.stat().st_size
        index_path = _faiss_index_path(store_path)
        records_path = _faiss_records_path(store_path)
        offsets_path = _faiss_offsets_path(store_path)
        if store_size_bytes > MAX_SAFE_MANIFEST_BYTES:
            logger.warning(
                "Removing oversized non-FAISS guideline manifest at %s (%s bytes)",
                store_path,
                store_size_bytes,
            )
            store_path.unlink()
            store_size_bytes = 0
        if (
            store_path.exists()
            and store_size_bytes <= MAX_SAFE_MANIFEST_BYTES
            and index_path.exists()
            and records_path.exists()
            and offsets_path.exists()
        ):
            existing = load_guideline_vector_store(store_path)
            return {
                "ok": True,
                "reused": True,
                "store_path": str(store_path),
                "stats": existing.get("stats", {}),
                "record_count": int(
                    existing.get(
                        "record_count",
                        existing.get("stats", {}).get("chunks_indexed", 0),
                    )
                ),
                "backend": FAISS_BACKEND,
                "index_path": str(existing.get("index_path")),
                "records_path": str(existing.get("records_path")),
                "offsets_path": str(existing.get("offsets_path")),
            }
        logger.info(
            "Existing guideline store at %s is incomplete; rebuilding as FAISS.",
            store_path,
        )

    candidate_files = list(
        _iter_guideline_files(
            guidelines_dir=guidelines_dir,
            max_files=max_files,
        )
    )
    logger.info(
        "Guideline indexing start | model=%s contextualized=%s context_window=%s chunk_chars=%s chunk_overlap=%s batch_size=%s batch_pause_seconds=%s candidate_files=%s max_chunks=%s",
        PERPLEXITY_GUIDELINE_EMBEDDING_MODEL,
        True,
        GUIDELINE_CONTEXT_WINDOW_CHARS,
        chunk_chars,
        chunk_overlap,
        batch_size,
        batch_pause_seconds,
        len(candidate_files),
        max_chunks,
    )

    run_config = {
        "guidelines_dir": str(guidelines_dir),
        "store_path": str(store_path),
        "model": PERPLEXITY_GUIDELINE_EMBEDDING_MODEL,
        "max_files": max_files,
        "max_chunks": max_chunks,
        "chunk_chars": chunk_chars,
        "chunk_overlap": chunk_overlap,
        "use_contextualized_embeddings": True,
        "context_window_chars": GUIDELINE_CONTEXT_WINDOW_CHARS,
        "batch_size": batch_size,
        "batch_pause_seconds": batch_pause_seconds,
    }

    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    resume_index = 0
    resumed = False
    checkpoint_meta = _load_checkpoint_meta(checkpoint_meta_path)
    resume_cursor: dict[str, int | str] | None = None
    if not force_rebuild and checkpoint_meta is not None:
        if _checkpoint_run_config_key(checkpoint_meta.get("run_config")) == _checkpoint_run_config_key(
            run_config
        ):
            checkpoint_records = _count_jsonl_records(checkpoint_records_path)
            requested_index = int(checkpoint_meta.get("next_index", checkpoint_records))
            resume_index = min(max(requested_index, 0), checkpoint_records)
            if requested_index != checkpoint_records:
                logger.warning(
                    "Checkpoint index mismatch | meta_next=%s records=%s using=%s",
                    requested_index,
                    checkpoint_records,
                    resume_index,
                )
            if resume_index > 0:
                resumed = True
                resume_cursor = _derive_resume_cursor(
                    candidate_files=candidate_files,
                    guidelines_dir=guidelines_dir,
                    checkpoint_meta=checkpoint_meta,
                    checkpoint_records_path=checkpoint_records_path,
                    resume_index=resume_index,
                )
                logger.info(
                    "Resuming guideline indexing | start_chunk=%s store=%s cursor=%s",
                    resume_index,
                    store_path,
                    resume_cursor,
                )
        else:
            logger.info(
                "Checkpoint config changed for %s; restarting from scratch.",
                store_path,
            )
            shutil.rmtree(checkpoint_dir, ignore_errors=True)
            checkpoint_dir.mkdir(parents=True, exist_ok=True)

    if resume_index == 0:
        checkpoint_records_path.write_text("", encoding="utf-8")

    now_iso = datetime.now(timezone.utc).isoformat()
    checkpoint_meta_payload = {
        "schema_version": SCHEMA_VERSION,
        "created_at": checkpoint_meta.get("created_at", now_iso)
        if isinstance(checkpoint_meta, dict)
        else now_iso,
        "updated_at": now_iso,
        "status": "running",
        "next_index": resume_index,
        "total_chunks": None,
        "resume_cursor": resume_cursor,
        "run_config": run_config,
        "stats": {
            "files_indexed": int(
                (
                    checkpoint_meta.get("stats", {}).get("files_indexed", 0)
                    if isinstance(checkpoint_meta, dict)
                    else 0
                )
                if resumed
                else 0
            ),
            "files_skipped": int(
                (
                    checkpoint_meta.get("stats", {}).get("files_skipped", 0)
                    if isinstance(checkpoint_meta, dict)
                    else 0
                )
                if resumed
                else 0
            ),
            "chunks_discovered": resume_index,
            "chunks_embedded": resume_index,
            "candidate_files": len(candidate_files),
        },
    }
    _write_checkpoint_meta(checkpoint_meta_path, checkpoint_meta_payload)

    faiss, np = _faiss_imports()
    faiss_index: Any | None = None

    if resume_index > 0 and checkpoint_records_path.exists():
        logger.info(
            "Rehydrating FAISS index from checkpoint records | start_chunk=%s",
            resume_index,
        )
        rebuild_vectors: list[list[float]] = []
        for record_idx, record in enumerate(_iter_jsonl_records(checkpoint_records_path)):
            if record_idx >= resume_index:
                break
            vector_raw = record.get("vector")
            if not isinstance(vector_raw, list):
                continue
            rebuild_vectors.append([float(v) for v in vector_raw])
        if rebuild_vectors:
            matrix = _normalize_vectors(rebuild_vectors, np=np, faiss=faiss)
            faiss_index = faiss.IndexFlatIP(int(matrix.shape[1]))
            faiss_index.add(matrix)

    embedded_chunks = resume_index
    discovered_chunks = 0
    current_stats = dict(checkpoint_meta_payload["stats"])
    batch_number = resume_index // batch_size
    pending_batch: list[dict[str, Any]] = []
    pending_batch_source_path: str | None = None
    pending_batch_tokens = 0
    pending_fsync_batches = 0
    last_resume_meta_write = 0
    checkpoint_records_handle = checkpoint_records_path.open("a", encoding="utf-8")
    try:
        max_embed_workers = int(os.getenv("GUIDELINE_EMBED_MAX_WORKERS", "8"))
    except ValueError:
        max_embed_workers = 8
    max_embed_workers = max(1, max_embed_workers)
    logger.info("Embedding worker config | max_workers=%s", max_embed_workers)
    embed_executor = ThreadPoolExecutor(
        max_workers=max_embed_workers,
        thread_name_prefix="guideline-embed",
    )
    next_submit_seq = 0
    next_commit_seq = 0
    inflight_batches: dict[int, tuple[dict[str, Any], Future[list[tuple[dict[str, Any], list[float]]]]]] = {}

    def embed_records_resilient(batch_items: list[dict[str, Any]]) -> list[tuple[dict[str, Any], list[float]]]:
        batch_texts_local = [str(item["embedding_text"]) for item in batch_items]
        try:
            vectors_local = embed_texts(batch_texts_local)
        except httpx.HTTPStatusError as exc:
            status_code = exc.response.status_code if exc.response is not None else None
            response_body = (
                (exc.response.text[:600] if exc.response is not None else "")
                .replace("\n", " ")
                .strip()
            )
            if status_code == 400:
                if len(batch_items) == 1:
                    bad_item = batch_items[0]
                    logger.error(
                        "Skipping chunk after 400 from embeddings API | source=%s chunk_index=%s body=%s",
                        bad_item.get("source_path"),
                        bad_item.get("chunk_index"),
                        response_body,
                    )
                    return []
                split_idx = max(1, len(batch_items) // 2)
                logger.warning(
                    "Embedding API returned 400; splitting batch | source=%s size=%s split=%s body=%s",
                    batch_items[0].get("source_path"),
                    len(batch_items),
                    split_idx,
                    response_body,
                )
                left = embed_records_resilient(batch_items[:split_idx])
                right = embed_records_resilient(batch_items[split_idx:])
                return left + right
            raise

        if len(vectors_local) != len(batch_texts_local):
            raise ValueError(
                f"Embedding length mismatch: got {len(vectors_local)} vectors for {len(batch_texts_local)} texts"
            )
        return [
            (item, [float(v) for v in vector])
            for item, vector in zip(batch_items, vectors_local)
        ]

    def persist_checkpoint_meta() -> None:
        checkpoint_meta_payload["updated_at"] = datetime.now(timezone.utc).isoformat()
        checkpoint_meta_payload["next_index"] = embedded_chunks
        checkpoint_meta_payload["total_chunks"] = discovered_chunks
        checkpoint_meta_payload["resume_cursor"] = resume_cursor
        checkpoint_meta_payload["stats"] = {
            **current_stats,
            "chunks_discovered": discovered_chunks,
            "chunks_embedded": embedded_chunks,
        }
        _write_checkpoint_meta(checkpoint_meta_path, checkpoint_meta_payload)

    def flush_checkpoint_records(force_fsync: bool = False) -> None:
        nonlocal pending_fsync_batches
        checkpoint_records_handle.flush()
        if force_fsync or pending_fsync_batches >= CHECKPOINT_FSYNC_EVERY_BATCHES:
            os.fsync(checkpoint_records_handle.fileno())
            pending_fsync_batches = 0

    def commit_embedded_pairs(
        batch_payload: dict[str, Any],
        embedded_pairs: list[tuple[dict[str, Any], list[float]]],
        *,
        force_fsync: bool = False,
    ) -> None:
        nonlocal faiss_index
        nonlocal embedded_chunks
        nonlocal pending_fsync_batches
        nonlocal resume_cursor
        batch_items = list(batch_payload["items"])
        batch_source = str(batch_payload["source_path"])
        skipped_chunks = len(batch_items) - len(embedded_pairs)
        if skipped_chunks > 0:
            logger.warning(
                "Dropped %s chunk(s) from batch after repeated 400 responses | source=%s",
                skipped_chunks,
                batch_source,
            )
        if not embedded_pairs:
            last_item = batch_items[-1]
            resume_cursor = {
                "file_index": int(last_item["file_index"]),
                "source_path": str(last_item["source_path"]),
                "next_chunk_index": int(last_item["chunk_index"]) + 1,
            }
            persist_checkpoint_meta()
            return

        vectors = [vector for _, vector in embedded_pairs]
        matrix = _normalize_vectors(vectors, np=np, faiss=faiss)
        if faiss_index is None:
            faiss_index = faiss.IndexFlatIP(int(matrix.shape[1]))
        faiss_index.add(matrix)
        for item, vector_f in embedded_pairs:
            file_path = item["file_path"]
            chunk_index = int(item["chunk_index"])
            chunk_text = str(item["chunk_text"])
            source_path = str(item["source_path"])
            total_chunks_in_source = int(item["total_chunks"])
            chunk_id = f"{source_path}::chunk_{chunk_index:05d}"
            record_payload = asdict(
                GuidelineChunkRecord(
                    chunk_id=chunk_id,
                    source_path=source_path,
                    source_name=file_path.name,
                    chunk_index=chunk_index,
                    text=chunk_text,
                    vector=vector_f,
                    model=PERPLEXITY_GUIDELINE_EMBEDDING_MODEL,
                    metadata={
                        "source_bytes": file_path.stat().st_size,
                        "suffix": file_path.suffix.lower(),
                        "total_chunks_in_source": total_chunks_in_source,
                        "contextualized_embedding": True,
                        "context_window_chars": GUIDELINE_CONTEXT_WINDOW_CHARS,
                    },
                )
            )
            checkpoint_records_handle.write(json.dumps(record_payload, ensure_ascii=True))
            checkpoint_records_handle.write("\n")

        embedded_chunks += len(embedded_pairs)
        last_item = batch_items[-1]
        resume_cursor = {
            "file_index": int(last_item["file_index"]),
            "source_path": str(last_item["source_path"]),
            "next_chunk_index": int(last_item["chunk_index"]) + 1,
        }
        pending_fsync_batches += 1
        flush_checkpoint_records(force_fsync=force_fsync)
        persist_checkpoint_meta()

        if batch_pause_seconds > 0:
            import time

            time.sleep(batch_pause_seconds)

    def commit_next_batch(*, force_fsync: bool = False) -> None:
        nonlocal next_commit_seq
        batch_payload, batch_future = inflight_batches.pop(next_commit_seq)
        embedded_pairs = batch_future.result()
        commit_embedded_pairs(
            batch_payload,
            embedded_pairs,
            force_fsync=force_fsync or bool(batch_payload.get("force_fsync", False)),
        )
        next_commit_seq += 1

    def submit_pending_batch(force_fsync: bool = False) -> None:
        nonlocal batch_number
        nonlocal pending_batch_source_path
        nonlocal pending_batch_tokens
        nonlocal next_submit_seq
        if not pending_batch:
            return
        batch_number += 1
        logger.info(
            "Embedding batch %s | source=%s batch_size=%s estimated_tokens=%s embedded=%s discovered=%s",
            batch_number,
            pending_batch_source_path,
            len(pending_batch),
            pending_batch_tokens,
            embedded_chunks + len(pending_batch),
            discovered_chunks,
        )
        batch_payload = {
            "items": list(pending_batch),
            "source_path": pending_batch_source_path,
            "estimated_tokens": pending_batch_tokens,
            "force_fsync": force_fsync,
        }
        batch_future = embed_executor.submit(embed_records_resilient, batch_payload["items"])
        inflight_batches[next_submit_seq] = (batch_payload, batch_future)
        next_submit_seq += 1

        pending_batch.clear()
        pending_batch_source_path = None
        pending_batch_tokens = 0

        while len(inflight_batches) >= max_embed_workers:
            commit_next_batch()

    try:
        for item, stats in _iter_chunk_items(
            candidate_files=candidate_files,
            guidelines_dir=guidelines_dir,
            chunk_chars=chunk_chars,
            chunk_overlap=chunk_overlap,
            max_chunks=max_chunks,
            start_file_index=int(resume_cursor.get("file_index", 0)) if resume_cursor else 0,
            start_chunk_index=int(resume_cursor.get("next_chunk_index", 0)) if resume_cursor else 0,
            initial_files_indexed=int(current_stats.get("files_indexed", 0)),
            initial_files_skipped=int(current_stats.get("files_skipped", 0)),
            initial_emitted_chunks=resume_index,
        ):
            discovered_chunks = int(stats["chunks_discovered"])
            current_stats = stats
            if discovered_chunks <= resume_index:
                if (
                    discovered_chunks == resume_index
                    or discovered_chunks - last_resume_meta_write >= RESUME_META_WRITE_EVERY_CHUNKS
                ):
                    persist_checkpoint_meta()
                    last_resume_meta_write = discovered_chunks
                continue
            item_source_path = str(item["source_path"])
            item_tokens = _estimate_token_count(str(item["embedding_text"]))
            should_flush = False
            if pending_batch:
                if pending_batch_source_path != item_source_path:
                    should_flush = True
                elif len(pending_batch) >= batch_size:
                    should_flush = True
                elif pending_batch_tokens + item_tokens > CONTEXTUALIZED_EMBEDDINGS_DOC_TOKEN_BUDGET:
                    should_flush = True
            if should_flush or pending_batch_tokens + item_tokens > CONTEXTUALIZED_EMBEDDINGS_HARD_TOKEN_LIMIT:
                if pending_batch and item_tokens > CONTEXTUALIZED_EMBEDDINGS_HARD_TOKEN_LIMIT:
                    # Split oversized single chunk into smaller pieces so the
                    # contextualized embedding document never exceeds the API limit.
                    oversized_text = item["chunk_text"]
                    safe_chunk_chars = max(1, (CONTEXTUALIZED_EMBEDDINGS_HARD_TOKEN_LIMIT - 1000) * APPROX_CHARS_PER_TOKEN)
                    sub_chunks = _chunk_text(oversized_text, chunk_chars=safe_chunk_chars, chunk_overlap=chunk_overlap)
                    if not sub_chunks:
                        sub_chunks = [oversized_text]
                    # Rebuild item(s) with the first sub-chunk and queue extras.
                    item["chunk_text"] = sub_chunks[0]
                    item["embedding_text"] = _contextualize_chunk(
                        source_path=item["source_path"],
                        source_name=item["file_path"].name,
                        chunk_index=item["chunk_index"],
                        total_chunks=item["total_chunks"],
                        current_chunk=sub_chunks[0],
                        previous_chunk=item.get("previous_chunk"),
                        next_chunk=item.get("next_chunk"),
                        context_window_chars=GUIDELINE_CONTEXT_WINDOW_CHARS,
                    )
                    item_tokens = _estimate_token_count(item["embedding_text"])
                    for sub_idx, sub_chunk in enumerate(sub_chunks[1:], start=1):
                        extra_item = dict(item)
                        extra_item["chunk_index"] = f"{item['chunk_index']}.{sub_idx}"
                        extra_item["chunk_text"] = sub_chunk
                        extra_item["embedding_text"] = _contextualize_chunk(
                            source_path=item["source_path"],
                            source_name=item["file_path"].name,
                            chunk_index=extra_item["chunk_index"],
                            total_chunks=item["total_chunks"],
                            current_chunk=sub_chunk,
                            previous_chunk=sub_chunks[sub_idx - 1] if sub_idx > 1 else sub_chunks[0],
                            next_chunk=sub_chunks[sub_idx + 1] if sub_idx + 1 < len(sub_chunks) else None,
                            context_window_chars=GUIDELINE_CONTEXT_WINDOW_CHARS,
                        )
                        pending_batch.append(extra_item)
                        pending_batch_tokens += _estimate_token_count(extra_item["embedding_text"])
                submit_pending_batch()
            pending_batch.append(item)
            pending_batch_source_path = item_source_path
            pending_batch_tokens += item_tokens

        submit_pending_batch(force_fsync=True)
        while inflight_batches:
            commit_next_batch()
        flush_checkpoint_records(force_fsync=True)
    finally:
        embed_executor.shutdown(wait=False, cancel_futures=True)
        checkpoint_records_handle.close()

    if faiss_index is None:
        dim = 1
        faiss_index = faiss.IndexFlatIP(dim)

    records_count = _count_jsonl_records(checkpoint_records_path)
    if records_count != discovered_chunks:
        logger.warning(
            "Checkpoint record count mismatch at finalize | expected=%s actual=%s",
            discovered_chunks,
            records_count,
        )

    chunks_indexed = records_count
    store_path.parent.mkdir(parents=True, exist_ok=True)
    index_path = _faiss_index_path(store_path)
    records_path = _faiss_records_path(store_path)
    offsets_path = _faiss_offsets_path(store_path)
    index_tmp_path = index_path.with_name(f"{index_path.name}.tmp")
    records_tmp_path = records_path.with_name(f"{records_path.name}.tmp")
    offsets_tmp_path = offsets_path.with_name(f"{offsets_path.name}.tmp")
    store_tmp_path = store_path.with_name(f"{store_path.name}.tmp")
    offsets: list[int] = []
    with checkpoint_records_path.open("r", encoding="utf-8") as source_handle, records_tmp_path.open(
        "w", encoding="utf-8"
    ) as records_handle:
        while True:
            offset = records_handle.tell()
            line = source_handle.readline()
            if not line:
                break
            raw = json.loads(line)
            if isinstance(raw, dict):
                raw.pop("vector", None)
            offsets.append(offset)
            records_handle.write(json.dumps(raw, ensure_ascii=True))
            records_handle.write("\n")

    offsets_tmp_path.write_text(json.dumps(offsets, ensure_ascii=True), encoding="utf-8")
    faiss.write_index(faiss_index, str(index_tmp_path))

    payload = {
        "schema_version": SCHEMA_VERSION,
        "backend": FAISS_BACKEND,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "guidelines_dir": str(guidelines_dir),
        "model": PERPLEXITY_GUIDELINE_EMBEDDING_MODEL,
        "chunk_chars": chunk_chars,
        "chunk_overlap": chunk_overlap,
        "use_contextualized_embeddings": True,
        "context_window_chars": GUIDELINE_CONTEXT_WINDOW_CHARS,
        "batch_pause_seconds": batch_pause_seconds,
        "stats": {
            "files_indexed": int(current_stats.get("files_indexed", 0)),
            "chunks_indexed": chunks_indexed,
            "files_skipped": int(current_stats.get("files_skipped", 0)),
        },
        "record_count": chunks_indexed,
        "index_path": str(index_path),
        "records_path": str(records_path),
        "offsets_path": str(offsets_path),
        "faiss_metric": "inner_product_normalized",
    }
    store_tmp_path.write_text(
        json.dumps(payload, ensure_ascii=True, indent=2),
        encoding="utf-8",
    )
    records_tmp_path.replace(records_path)
    offsets_tmp_path.replace(offsets_path)
    index_tmp_path.replace(index_path)
    store_tmp_path.replace(store_path)

    checkpoint_meta_payload["updated_at"] = datetime.now(timezone.utc).isoformat()
    checkpoint_meta_payload["status"] = "completed"
    checkpoint_meta_payload["next_index"] = chunks_indexed
    checkpoint_meta_payload["total_chunks"] = discovered_chunks
    checkpoint_meta_payload["stats"] = {
        **current_stats,
        "chunks_discovered": discovered_chunks,
        "chunks_embedded": chunks_indexed,
    }
    _write_checkpoint_meta(checkpoint_meta_path, checkpoint_meta_payload)
    shutil.rmtree(checkpoint_dir, ignore_errors=True)

    logger.info(
        "Guideline indexing complete | store=%s files_indexed=%s chunks_indexed=%s files_skipped=%s",
        store_path,
        payload["stats"]["files_indexed"],
        payload["stats"]["chunks_indexed"],
        payload["stats"]["files_skipped"],
    )
    return {
        "ok": True,
        "reused": False,
        "store_path": str(store_path),
        "stats": payload["stats"],
        "contextualized": True,
        "record_count": chunks_indexed,
        "backend": FAISS_BACKEND,
        "index_path": str(index_path),
        "records_path": str(records_path),
        "offsets_path": str(offsets_path),
        "resumed": resumed,
        "resume_index": resume_index,
        "skipped_files": [],
    }


def query_guideline_vector_store(
    query: str,
    embed_text: Callable[[str], list[float]],
    *,
    store_path: Path = DEFAULT_VECTOR_STORE_PATH,
    top_k: int = 8,
    min_score: float | None = None,
) -> dict[str, Any]:
    """Run semantic lookup against local guideline vector store."""
    if top_k <= 0:
        raise ValueError("top_k must be > 0")

    payload = load_guideline_vector_store(store_path)
    backend = str(payload.get("backend", FAISS_BACKEND))
    index_path = Path(str(payload.get("index_path", _faiss_index_path(store_path))))
    records_path = Path(str(payload.get("records_path", _faiss_records_path(store_path))))
    offsets_path = Path(str(payload.get("offsets_path", _faiss_offsets_path(store_path))))
    if not index_path.exists() or not records_path.exists() or not offsets_path.exists():
        return {
            "ok": True,
            "count": 0,
            "results": [],
            "store_path": str(store_path),
            "backend": backend,
        }

    faiss, np = _faiss_imports()
    faiss_index = faiss.read_index(str(index_path))
    ntotal = int(getattr(faiss_index, "ntotal", 0))
    if ntotal <= 0:
        return {
            "ok": True,
            "count": 0,
            "results": [],
            "store_path": str(store_path),
            "backend": backend,
        }

    query_vector = [float(v) for v in embed_text(query)]
    query_matrix = _normalize_vectors([query_vector], np=np, faiss=faiss)
    search_k = min(top_k, ntotal)
    scores_matrix, indices_matrix = faiss_index.search(query_matrix, search_k)
    scores = scores_matrix[0].tolist() if len(scores_matrix) else []
    indices = indices_matrix[0].tolist() if len(indices_matrix) else []
    matched_records = _sample_records_by_offsets(records_path, offsets_path, indices)
    results: list[dict[str, Any]] = []
    for score, idx, record in zip(scores, indices, matched_records):
        if idx < 0 or not isinstance(record, dict):
            continue
        score_f = float(score)
        if min_score is not None and score_f < min_score:
            continue
        results.append(
            {
                "chunk_id": record.get("chunk_id"),
                "score": score_f,
                "source_path": record.get("source_path"),
                "source_name": record.get("source_name"),
                "chunk_index": record.get("chunk_index"),
                "snippet": str(record.get("text", ""))[:420],
                "metadata": record.get("metadata", {}),
            }
        )
    return {
        "ok": True,
        "count": len(results),
        "results": results,
        "store_path": str(store_path),
        "backend": backend,
        "index_path": str(index_path),
        "records_path": str(records_path),
        "offsets_path": str(offsets_path),
    }


def _coerce_numeric_vector(vector: Any) -> list[float]:
    if not isinstance(vector, list) or not vector:
        raise ValueError("Embedding vector must be a non-empty list")
    coerced: list[float] = []
    for value in vector:
        try:
            coerced.append(float(value))
        except (TypeError, ValueError) as exc:
            raise ValueError(f"Invalid embedding vector value: {value!r}") from exc
    return coerced


def _prepare_inline_guideline_chunks(
    *,
    source_path: str,
    source_name: str,
    document_text: str,
    chunk_chars: int,
    chunk_overlap: int,
) -> tuple[list[str], list[str]]:
    chunks = _chunk_text(document_text, chunk_chars=chunk_chars, chunk_overlap=chunk_overlap)
    if not chunks:
        raise ValueError("document_text did not produce any indexable chunks")

    embedding_texts: list[str] = []
    total_chunks = len(chunks)
    for idx, chunk in enumerate(chunks):
        embedding_texts.append(
            _contextualize_chunk(
                source_path=source_path,
                source_name=source_name,
                chunk_index=idx,
                total_chunks=total_chunks,
                current_chunk=chunk,
                previous_chunk=chunks[idx - 1] if idx > 0 else None,
                next_chunk=chunks[idx + 1] if idx + 1 < total_chunks else None,
                context_window_chars=GUIDELINE_CONTEXT_WINDOW_CHARS,
            )
        )
    return chunks, embedding_texts


def _scan_source_occurrences(records_path: Path, source_path: str) -> tuple[list[int], set[str], int]:
    positions: list[int] = []
    unique_sources: set[str] = set()
    kept_count = 0
    if not records_path.exists():
        return positions, unique_sources, kept_count

    for idx, record in enumerate(_iter_jsonl_records(records_path)):
        record_source = str(record.get("source_path", "")).strip()
        if record_source == source_path:
            positions.append(idx)
            continue
        kept_count += 1
        if record_source:
            unique_sources.add(record_source)
    return positions, unique_sources, kept_count


def upsert_guideline_source(
    embed_texts: Callable[[list[str]], list[list[float]]],
    *,
    source_path: str,
    document_text: str,
    store_path: Path = DEFAULT_VECTOR_STORE_PATH,
    source_name: str | None = None,
    source_bytes: int | None = None,
    metadata: dict[str, Any] | None = None,
    chunk_chars: int = 1200,
    chunk_overlap: int = 160,
    replace_existing: bool = False,
    require_existing: bool = False,
) -> dict[str, Any]:
    """Insert or replace one logical guideline source inside the FAISS store."""
    normalized_source_path = source_path.strip()
    if not normalized_source_path:
        raise ValueError("source_path is required")
    if not document_text.strip():
        raise ValueError("document_text is required")

    payload = load_guideline_vector_store(store_path)
    index_path = Path(str(payload.get("index_path", _faiss_index_path(store_path))))
    records_path = Path(str(payload.get("records_path", _faiss_records_path(store_path))))
    offsets_path = Path(str(payload.get("offsets_path", _faiss_offsets_path(store_path))))

    existing_positions, existing_source_paths, kept_record_count = _scan_source_occurrences(
        records_path,
        normalized_source_path,
    )
    existing_count = len(existing_positions)
    if require_existing and existing_count == 0:
        raise ValueError(f"source_path was not found in the vector store: {normalized_source_path}")
    if existing_count > 0 and not replace_existing:
        raise ValueError(
            f"source_path already exists in the vector store: {normalized_source_path}. "
            "Use replace to overwrite it."
        )

    normalized_source_name = (source_name or Path(normalized_source_path).name or normalized_source_path).strip()
    chunks, embedding_texts = _prepare_inline_guideline_chunks(
        source_path=normalized_source_path,
        source_name=normalized_source_name,
        document_text=document_text,
        chunk_chars=chunk_chars,
        chunk_overlap=chunk_overlap,
    )
    vectors_raw = embed_texts(embedding_texts)
    if len(vectors_raw) != len(chunks):
        raise RuntimeError(
            "Embedding provider returned an unexpected number of vectors: "
            f"expected {len(chunks)}, received {len(vectors_raw)}"
        )
    vectors = [_coerce_numeric_vector(vector) for vector in vectors_raw]

    faiss, np = _faiss_imports()
    if index_path.exists():
        faiss_index = faiss.read_index(str(index_path))
        if existing_positions:
            selector = faiss.IDSelectorBatch(np.asarray(existing_positions, dtype="int64"))
            faiss_index.remove_ids(selector)
    elif existing_count > 0 or kept_record_count > 0:
        raise RuntimeError(f"Vector index missing for populated store: {index_path}")
    else:
        faiss_index = None

    matrix = _normalize_vectors(vectors, np=np, faiss=faiss)
    if faiss_index is None:
        faiss_index = faiss.IndexFlatIP(int(matrix.shape[1]))
    else:
        expected_dim = int(getattr(faiss_index, "d", matrix.shape[1]))
        if expected_dim != int(matrix.shape[1]):
            raise ValueError(
                f"Embedding dimension mismatch: store expects {expected_dim}, received {int(matrix.shape[1])}"
            )
    faiss_index.add(matrix)

    store_path.parent.mkdir(parents=True, exist_ok=True)
    records_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.parent.mkdir(parents=True, exist_ok=True)
    offsets_path.parent.mkdir(parents=True, exist_ok=True)

    records_tmp_path = records_path.with_name(f"{records_path.name}.tmp")
    offsets_tmp_path = offsets_path.with_name(f"{offsets_path.name}.tmp")
    index_tmp_path = index_path.with_name(f"{index_path.name}.tmp")
    store_tmp_path = store_path.with_name(f"{store_path.name}.tmp")

    offsets: list[int] = []
    unique_sources = set(existing_source_paths)
    if normalized_source_path:
        unique_sources.add(normalized_source_path)
    source_bytes_value = source_bytes if source_bytes is not None else len(document_text.encode("utf-8"))
    suffix = Path(normalized_source_name).suffix.lower() or Path(normalized_source_path).suffix.lower()
    base_metadata = {
        "source_bytes": int(source_bytes_value),
        "suffix": suffix,
        "total_chunks_in_source": len(chunks),
        "contextualized_embedding": True,
        "context_window_chars": GUIDELINE_CONTEXT_WINDOW_CHARS,
        "ingested_via": "guidelines_vector_tools",
    }
    if metadata:
        base_metadata.update(metadata)

    with records_tmp_path.open("w", encoding="utf-8") as records_handle:
        if records_path.exists():
            for record in _iter_jsonl_records(records_path):
                record_source = str(record.get("source_path", "")).strip()
                if record_source == normalized_source_path:
                    continue
                offsets.append(records_handle.tell())
                records_handle.write(json.dumps(record, ensure_ascii=True))
                records_handle.write("\n")

        for chunk_index, chunk_text in enumerate(chunks):
            record_payload = {
                "chunk_id": f"{normalized_source_path}::chunk_{chunk_index:05d}",
                "source_path": normalized_source_path,
                "source_name": normalized_source_name,
                "chunk_index": chunk_index,
                "text": chunk_text,
                "model": str(payload.get("model") or PERPLEXITY_GUIDELINE_EMBEDDING_MODEL),
                "metadata": dict(base_metadata),
            }
            offsets.append(records_handle.tell())
            records_handle.write(json.dumps(record_payload, ensure_ascii=True))
            records_handle.write("\n")

    offsets_tmp_path.write_text(json.dumps(offsets, ensure_ascii=True), encoding="utf-8")
    faiss.write_index(faiss_index, str(index_tmp_path))

    now_iso = datetime.now(timezone.utc).isoformat()
    files_skipped = int(payload.get("stats", {}).get("files_skipped", 0))
    record_count = len(offsets)
    manifest_payload = {
        "schema_version": int(payload.get("schema_version", SCHEMA_VERSION)),
        "backend": FAISS_BACKEND,
        "created_at": payload.get("created_at") or now_iso,
        "updated_at": now_iso,
        "guidelines_dir": str(payload.get("guidelines_dir") or DEFAULT_GUIDELINES_DIR),
        "model": str(payload.get("model") or PERPLEXITY_GUIDELINE_EMBEDDING_MODEL),
        "chunk_chars": int(payload.get("chunk_chars", chunk_chars)),
        "chunk_overlap": int(payload.get("chunk_overlap", chunk_overlap)),
        "use_contextualized_embeddings": bool(payload.get("use_contextualized_embeddings", True)),
        "context_window_chars": int(payload.get("context_window_chars", GUIDELINE_CONTEXT_WINDOW_CHARS)),
        "batch_pause_seconds": float(payload.get("batch_pause_seconds", 0.0)),
        "stats": {
            "files_indexed": len(unique_sources),
            "chunks_indexed": record_count,
            "files_skipped": files_skipped,
        },
        "record_count": record_count,
        "index_path": str(index_path),
        "records_path": str(records_path),
        "offsets_path": str(offsets_path),
        "faiss_metric": str(payload.get("faiss_metric", "inner_product_normalized")),
    }
    store_tmp_path.write_text(
        json.dumps(manifest_payload, ensure_ascii=True, indent=2),
        encoding="utf-8",
    )

    records_tmp_path.replace(records_path)
    offsets_tmp_path.replace(offsets_path)
    index_tmp_path.replace(index_path)
    store_tmp_path.replace(store_path)

    action = "replaced" if existing_count > 0 else "inserted"
    return {
        "ok": True,
        "action": action,
        "store_path": str(store_path),
        "index_path": str(index_path),
        "records_path": str(records_path),
        "offsets_path": str(offsets_path),
        "source_path": normalized_source_path,
        "source_name": normalized_source_name,
        "chunks_added": len(chunks),
        "chunks_removed": existing_count,
        "record_count": record_count,
        "stats": manifest_payload["stats"],
        "model": manifest_payload["model"],
    }
