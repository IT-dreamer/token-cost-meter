#!/usr/bin/env python3
"""Regenerate the FALLBACK_RATES table inlined in desktop/plugin.js.

Source: ~/.hermes/models_dev_cache.json (the models.dev catalog Hermes already
keeps on disk). Run after switching to a provider whose model is missing:

    python3 scripts/gen-rates.py

The desktop plugin loader rejects relative imports, so the table cannot live in
its own module — this script rewrites the `const FALLBACK_RATES = ...` literal
in place.
"""
import json
import os
import re
import sys

PLUGIN = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "desktop", "plugin.js")
CACHE = os.path.expanduser("~/.hermes/models_dev_cache.json")

# Providers worth shipping. models.dev has 200+; most are resellers whose rows
# would triple the file for models nobody here routes to.
KEEP = [
    "github-copilot", "anthropic", "openai", "google", "google-vertex", "xai",
    "deepseek", "moonshotai", "z-ai", "mistral", "groq", "togetherai",
    "openrouter", "amazon-bedrock", "azure", "cerebras", "fireworks-ai",
    "deepinfra", "perplexity", "alibaba", "minimax", "meta",
]


def build(catalog):
    out = {}
    for provider in KEEP:
        entry = catalog.get(provider)
        if not entry:
            continue
        models = {}
        for model_id, model in (entry.get("models") or {}).items():
            cost = model.get("cost") or {}
            inp, outp = cost.get("input"), cost.get("output")
            if inp is None and outp is None:
                continue
            inp = float(inp or 0)
            outp = float(outp or 0)
            cache = cost.get("cache_read")
            row = [inp, outp, float(cache) if cache is not None else inp]
            while len(row) > 2 and row[-1] == 0:
                row.pop()
            models[str(model_id).lower()] = row
        if models:
            out[provider] = models
    return out


def main():
    if not os.path.exists(CACHE):
        sys.exit(f"missing {CACHE} — run Hermes once so it fetches models.dev")
    catalog = json.load(open(CACHE))
    catalog = catalog.get("data", catalog)
    table = build(catalog)
    literal = json.dumps(table, sort_keys=True, separators=(",", ":"))

    source = open(PLUGIN).read()
    pattern = re.compile(r"(const FALLBACK_RATES = /\* @generated \*/ )(\{.*?\})\n", re.S)
    if not pattern.search(source):
        sys.exit("could not find the FALLBACK_RATES literal in plugin.js")
    source = pattern.sub(lambda m: m.group(1) + literal + "\n", source, count=1)
    open(PLUGIN, "w").write(source)

    print(f"wrote {sum(len(v) for v in table.values())} models "
          f"across {len(table)} providers ({len(literal)} bytes)")


if __name__ == "__main__":
    main()
