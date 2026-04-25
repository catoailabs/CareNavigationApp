def extract_prompt(last_message):
    parts = last_message.get("parts") or last_message.get("content") or ""
    if isinstance(parts, list):
        text_parts = [p.get("text", "") for p in parts if isinstance(p, dict) and "text" in p]
        if text_parts:
            return "\n\n".join(text_parts)
    return parts

print(repr(extract_prompt({"parts": [{"type": "text", "text": "Hello"}, {"type": "file", "url": "..."}]})))
