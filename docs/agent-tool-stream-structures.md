# Agent tool-stream structures (captured from the REAL agent)

Source of truth: live run of `agent.build_agent(model=MODEL)` (grok-4.3, `use_encrypted_content=true`),
captured to `_agent_tool_events.jsonl` (328 events) and `_probe_events.jsonl` (386 events, redacted).
Prompt forced all three search tools in one turn (Mayo Clinic Rochester quality + reviews + images).

All three tool families were invoked in a **single parallel turn**.

---

## 1. Native Grok tools — `web_search` + `x_search` (server-side)

`x_search` surfaces internally as **`x_keyword_search`**.

Delivered on the **model metadata event** (streamed as an `event.metadata` object):

```jsonc
{ "event": { "metadata": {
  "usage":   { "inputTokens": 11614, "outputTokens": 3, "totalTokens": 12260, "reasoningTokens": 643 },
  "metrics": { "latencyMs": 0 },
  "citations": [ /* RepeatedScalarContainer — list of source/image URL strings */ ],
  "serverToolCalls": [
    { "id": "call-…-0", "name": "web_search",
      "arguments": "{\"query\":\"Mayo Clinic Rochester MN hospital quality rating US News Leapfrog 2026\",\"num_results\":\"10\"}" },
    { "id": "call-…-1", "name": "x_keyword_search",
      "arguments": "{\"query\":\"\\\"Mayo Clinic\\\" filter:images since:2025-01-01\",\"limit\":\"5\",\"mode\":\"Latest\"}" }
  ]
}}}
```

Also echoed inline in streamed text as `[xAI Tool: web_search({…})]` / `[xAI Tool: x_keyword_search({…})]`.

- **Search results / citations** → `event.metadata.citations` (a repeated list of URL strings) + inline `[[n]](url)` markers in the text deltas.
- **Images** → with `enable_image_understanding=True`, image URLs appear among `citations`; X image posts appear as `https://x.com/<handle>/status/<id>` URLs.
- **Tool call params** → `event.metadata.serverToolCalls[]` = `{ id, name, arguments(JSON string) }`.

### Native tool constructor signatures (xai_sdk.tools)
```py
web_search(excluded_domains=None, allowed_domains=None, *,
           enable_image_understanding=False,
           user_location_country=None, user_location_city=None,
           user_location_region=None, user_location_timezone=None) -> Tool
x_search(from_date=None, to_date=None, allowed_x_handles=None, excluded_x_handles=None, *,
         enable_image_understanding=False, enable_video_understanding=False) -> Tool
```

---

## 2. `perplexity_search_api` (Strands tool)

> **The raw Perplexity Search API (`POST https://api.perplexity.ai/search`) returns NO media.**
> Per its OpenAPI schema the response is only:
> ```jsonc
> { "results": [ { "title", "url", "snippet", "date"?, "last_updated"? } ], "id", "server_time"? }
> ```
> Request surface: `query` (string | string[]), `max_results` (1–20, default 10), `max_tokens`,
> `max_tokens_per_page`, `search_context_size` (low|medium|high), `country` (ISO-2),
> `search_language_filter[]`, `search_domain_filter[]` (≤20), and date filters
> (`search_after/before_date_filter`, `last_updated_after/before_filter` as MM/DD/YYYY,
> `search_recency_filter` = hour|day|week|month|year).
>
> Everything below beyond `title/url/snippet/date/last_updated` is **synthesized by our tool**
> (`perplexity_search_api.py`), not returned by Perplexity:
> - `domain` — added via `urlparse(url).netloc`.
> - `images[]` / `videos[]` = `{ url, source_url }` — best-effort scrape of each result page's
>   `og:image` / `twitter:image` / `og:video` / `<video src>` meta (cap **3/result**, 7 s timeout,
>   5 concurrent). **Empties out for bot-blocking / non-OG domains** (Yelp, Trustpilot, BBB) — which is
>   exactly why this run got 0. Use OG-friendly domains (news/blogs/product pages) to populate them.
> - `chain_of_thought[]`, `source_domains[]`, `result` (summary), `__ui_data__` — all tool-built.

**Tool-use stream** (`current_tool_use` event):
```jsonc
{ "current_tool_use": {
  "toolUseId": "call-32e3dd49-…-2",
  "name": "perplexity_search_api",
  "input": "{\"query\":\"Mayo Clinic Rochester patient reviews 2025\",\"max_results\":5,\"return_images\":true}"
}}
```

**Result** arrives as a `role:"user"` message with a `toolResult` block whose single `content[0].text`
is a **JSON string** of the full payload:

```jsonc
{
  "success": true,
  "query": "Mayo Clinic Rochester patient reviews 2025",
  "multi_query": false,
  "filters_applied": {},
  "results": [ { "query": "…", "results": [
      { "title": "…", "url": "…", "snippet": "…", "date": "2024-03-21", "last_updated": "2025-03-04", "domain": "www.yelp.com" }
  ] } ],
  "images":  [ /* { "url": "…", "source_url": "…" } — TOOL-SYNTHESIZED via og:image scrape; 0 this run (Yelp/BBB block/omit OG) */ ],
  "videos":  [ /* { "url": "…", "source_url": "…" } — TOOL-SYNTHESIZED via og:video / <video src> */ ],
  "chain_of_thought": [
    { "label": "Analyze user request",       "description": "Processed query input (single query).",        "status": "complete" },
    { "label": "Apply filters",              "description": "No additional filters applied.",               "status": "complete" },
    { "label": "Retrieve ranked sources",    "description": "Received 5 results spanning 5 domains.",       "status": "complete",
      "sources": ["ie.trustpilot.com","newsnetwork.mayoclinic.org","uk.trustpilot.com","www.bbb.org","www.yelp.com"] },
    { "label": "Enrich with media metadata", "description": "Discovered 0 images.",                        "status": "pending" }
  ],
  "response_id": "…",
  "server_time": "…",
  "source_domains": ["ie.trustpilot.com","newsnetwork.mayoclinic.org","uk.trustpilot.com","www.bbb.org","www.yelp.com"],
  "result": "…summary…",
  "__ui_data__": {
    "type": "sources",
    "data": {
      "provider": "perplexity",
      "query": "Mayo Clinic Rochester patient reviews 2025",
      "results": [
        { "id": "perplexity-0-80319", "title": "Mayo Clinic - Rochester, MN",
          "url": "https://www.yelp.com/biz/mayo-clinic-rochester-12", "snippet": "…",
          "date": "2024-03-21", "source": "www.yelp.com" }
      ]
    }
  }
}
```

> `__ui_data__` is a **prebuilt sources block** (`type:"sources"`, `data.results[{id,title,url,snippet,date,source}]`)
> that maps 1:1 to AI Elements `Sources`/`ChainOfThoughtSearchResults` → each result = one `ChainOfThoughtSearchResult`.

---

## 3. Message / block anatomy (assistant turn)

- Assistant tool turn blocks: `['reasoningContent','text','reasoningContent','toolUse','reasoningContent']`
- Tool result turn: `role:"user"` → `['toolResult']`
- Final assistant message blocks:
  - `reasoningContent.reasoningText.text` — visible reasoning
  - `text` — the synthesis answer
  - `reasoningContent.redactedContent` — encrypted reasoning bytes (from `use_encrypted_content=true`)

---

## AI Elements mapping (for the reimplementation)

| Source event | AI Elements target |
|---|---|
| Grok native `citations` (web/x) | `Citations` / `Sources` component |
| `serverToolCalls[]` (web_search, x_keyword_search) | `ChainOfThoughtSearchResults` (one group per tool) |
| perplexity `__ui_data__.data.results[]` / `results[].results[]` | `ChainOfThoughtSearchResult` (one per item) |
| perplexity `images[]` + native image URLs | `ChainOfThoughtImage` |
| perplexity `chain_of_thought[]` | `ChainOfThoughtStep` (label/description/status) |
| `reasoningContent.reasoningText` | `ChainOfThoughtContent` reasoning text |
