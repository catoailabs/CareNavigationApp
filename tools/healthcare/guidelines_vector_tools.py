"""Discoverable tools for the local healthcare guideline vector store."""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import Any

import httpx
import numpy as np
from dotenv import load_dotenv
from strands import tool

from tools.guidelines.vector_store import (
    DEFAULT_VECTOR_STORE_PATH,
    PERPLEXITY_GUIDELINE_EMBEDDING_MODEL,
    _read_text_file,
    load_guideline_vector_store,
    query_guideline_vector_store,
    upsert_guideline_source,
)

ENV_PATH = Path(__file__).resolve().parents[2] / ".env"
load_dotenv(ENV_PATH)

PERPLEXITY_API_BASE_URL = os.getenv("PERPLEXITY_API_BASE_URL", "https://api.perplexity.ai").rstrip("/")
PERPLEXITY_EMBED_TIMEOUT_SECONDS = float(os.getenv("PERPLEXITY_EMBED_TIMEOUT_SECONDS", "60"))


def _read_env_value(key: str) -> str | None:
    for path in (ENV_PATH, Path.cwd() / ".env"):
        if not path.exists():
            continue
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                name, value = line.split("=", 1)
                if name.strip() == key:
                    return value.strip().strip('"').strip("'")
        except Exception:
            continue
    return None


def _resolve_store_path(store_path: str | None) -> Path:
    if store_path and store_path.strip():
        return Path(store_path).expanduser().resolve()
    return DEFAULT_VECTOR_STORE_PATH


def _perplexity_api_key() -> str:
    api_key = os.getenv("PERPLEXITY_API_KEY") or _read_env_value("PERPLEXITY_API_KEY")
    if not api_key:
        raise RuntimeError("PERPLEXITY_API_KEY is not configured")
    return api_key


def _store_model(store_path: Path) -> str:
    payload = load_guideline_vector_store(store_path)
    model = str(payload.get("model") or PERPLEXITY_GUIDELINE_EMBEDDING_MODEL).strip()
    if not model:
        return PERPLEXITY_GUIDELINE_EMBEDDING_MODEL
    return model


def _decode_embedding_value(value: Any) -> list[float]:
    if isinstance(value, list):
        return [float(item) for item in value]
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError("Perplexity embeddings response did not include an embedding payload")
    decoded = base64.b64decode(value)
    vector = np.frombuffer(decoded, dtype=np.int8).astype("float32")
    if vector.size == 0:
        raise RuntimeError("Decoded embedding vector is empty")
    return vector.tolist()


def _request_contextualized_embeddings(documents: list[list[str]], *, model: str) -> list[list[list[float]]]:
    response = httpx.post(
        f"{PERPLEXITY_API_BASE_URL}/v1/contextualizedembeddings",
        headers={
            "Authorization": f"Bearer {_perplexity_api_key()}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        json={
            "model": model,
            "input": documents,
        },
        timeout=PERPLEXITY_EMBED_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    payload = response.json()
    response_documents = payload.get("data")
    if not isinstance(response_documents, list) or not response_documents:
        raise RuntimeError("Perplexity embeddings response did not include any document data")

    extracted: list[list[list[float]]] = []
    for document in response_documents:
        if isinstance(document, dict) and isinstance(document.get("data"), list):
            chunk_vectors: list[list[float]] = []
            for item in document["data"]:
                if not isinstance(item, dict):
                    raise RuntimeError("Perplexity embeddings response contained an invalid chunk item")
                chunk_vectors.append(_decode_embedding_value(item.get("embedding")))
            extracted.append(chunk_vectors)
            continue
        if isinstance(document, dict) and "embedding" in document:
            extracted.append([_decode_embedding_value(document.get("embedding"))])
            continue
        raise RuntimeError("Perplexity embeddings response had an unexpected structure")
    return extracted


def _embed_document_chunks(chunks: list[str], *, store_path: Path) -> list[list[float]]:
    documents = _request_contextualized_embeddings([chunks], model=_store_model(store_path))
    if len(documents) != 1:
        raise RuntimeError(f"Expected one document embedding result, received {len(documents)}")
    vectors = documents[0]
    if len(vectors) != len(chunks):
        raise RuntimeError(
            f"Expected {len(chunks)} chunk embeddings for document, received {len(vectors)}"
        )
    return vectors


def _embed_query_text(query: str, *, store_path: Path) -> list[float]:
    documents = _request_contextualized_embeddings([[query]], model=_store_model(store_path))
    if len(documents) != 1 or len(documents[0]) != 1:
        raise RuntimeError("Expected one query embedding result")
    return documents[0][0]


def _parse_metadata_json(metadata_json: str | None) -> dict[str, Any] | None:
    if metadata_json is None or not metadata_json.strip():
        return None
    value = json.loads(metadata_json)
    if not isinstance(value, dict):
        raise ValueError("metadata_json must decode to a JSON object")
    return value


def _resolve_document_text(content: str | None, file_path: str | None) -> tuple[str, int, str | None]:
    has_content = bool(content and content.strip())
    has_file_path = bool(file_path and file_path.strip())
    if has_content == has_file_path:
        raise ValueError("Provide exactly one of content or file_path")
    if has_content:
        text = str(content)
        return text, len(text.encode("utf-8")), None

    path = Path(str(file_path)).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"Guideline source file not found: {path}")
    text = _read_text_file(path)
    if not text:
        raise ValueError(f"Unable to read indexable text from file: {path}")
    return text, int(path.stat().st_size), path.name


@tool
def guidelines_vector_health(store_path: str | None = None) -> dict[str, Any]:
    """Inspect the local guideline vector store runtime and embedding prerequisites."""
    resolved_store_path = _resolve_store_path(store_path)
    payload = load_guideline_vector_store(resolved_store_path)
    index_path = Path(str(payload.get("index_path", resolved_store_path.with_suffix(".faiss"))))
    records_path = Path(str(payload.get("records_path", resolved_store_path.with_suffix(".records.jsonl"))))
    offsets_path = Path(str(payload.get("offsets_path", resolved_store_path.with_suffix(".offsets.json"))))
    try:
        import faiss  # type: ignore  # noqa: F401

        faiss_available = True
    except Exception:
        faiss_available = False
    return {
        "ok": True,
        "store_path": str(resolved_store_path),
        "store_exists": resolved_store_path.exists(),
        "index_path": str(index_path),
        "index_exists": index_path.exists(),
        "records_path": str(records_path),
        "records_exists": records_path.exists(),
        "offsets_path": str(offsets_path),
        "offsets_exists": offsets_path.exists(),
        "stats": payload.get("stats", {}),
        "record_count": payload.get("record_count", payload.get("stats", {}).get("chunks_indexed", 0)),
        "model": _store_model(resolved_store_path),
        "faiss_available": faiss_available,
        "api_key_configured": bool(os.getenv("PERPLEXITY_API_KEY") or _read_env_value("PERPLEXITY_API_KEY")),
        "guidelines_dir": payload.get("guidelines_dir"),
    }


@tool
def guidelines_vector_query(
    query: str,
    top_k: int = 8,
    min_score: float | None = None,
    store_path: str | None = None,
) -> dict[str, Any]:
    """Run semantic retrieval against the healthcare guideline vector store."""
    resolved_store_path = _resolve_store_path(store_path)
    return query_guideline_vector_store(
        query=query,
        embed_text=lambda text: _embed_query_text(text, store_path=resolved_store_path),
        store_path=resolved_store_path,
        top_k=top_k,
        min_score=min_score,
    )


@tool
def guidelines_vector_upsert(
    source_path: str,
    content: str | None = None,
    file_path: str | None = None,
    source_name: str | None = None,
    metadata_json: str | None = None,
    chunk_chars: int = 1200,
    chunk_overlap: int = 160,
    store_path: str | None = None,
) -> dict[str, Any]:
    """Add one new guideline source to the vector store using contextualized Perplexity embeddings."""
    resolved_store_path = _resolve_store_path(store_path)
    document_text, source_bytes, inferred_source_name = _resolve_document_text(content, file_path)
    return upsert_guideline_source(
        lambda texts: _embed_document_chunks(texts, store_path=resolved_store_path),
        source_path=source_path,
        document_text=document_text,
        store_path=resolved_store_path,
        source_name=source_name or inferred_source_name,
        source_bytes=source_bytes,
        metadata=_parse_metadata_json(metadata_json),
        chunk_chars=chunk_chars,
        chunk_overlap=chunk_overlap,
        replace_existing=False,
    )


@tool
def guidelines_vector_replace(
    source_path: str,
    content: str | None = None,
    file_path: str | None = None,
    source_name: str | None = None,
    metadata_json: str | None = None,
    chunk_chars: int = 1200,
    chunk_overlap: int = 160,
    store_path: str | None = None,
) -> dict[str, Any]:
    """Replace one existing guideline source in the vector store with current content."""
    resolved_store_path = _resolve_store_path(store_path)
    document_text, source_bytes, inferred_source_name = _resolve_document_text(content, file_path)
    return upsert_guideline_source(
        lambda texts: _embed_document_chunks(texts, store_path=resolved_store_path),
        source_path=source_path,
        document_text=document_text,
        store_path=resolved_store_path,
        source_name=source_name or inferred_source_name,
        source_bytes=source_bytes,
        metadata=_parse_metadata_json(metadata_json),
        chunk_chars=chunk_chars,
        chunk_overlap=chunk_overlap,
        replace_existing=True,
        require_existing=True,
    )
