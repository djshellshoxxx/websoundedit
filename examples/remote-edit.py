#!/usr/bin/env python3
"""Edit audio through the running local API. Uses only Python's standard library.

1. In another terminal: npm run api
2. Set WEBSOUNDEDIT_TOKEN to the printed token.
3. python examples/remote-edit.py input.wav output.flac --recipe examples/cleanup.json
"""
import argparse
import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser(description="Script WebSoundEdit's audio engine over HTTP")
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--url", default="http://127.0.0.1:8787")
    parser.add_argument("--recipe", type=Path)
    parser.add_argument("--project", type=Path, help="Also save a portable JSON project")
    parser.add_argument("--format", help="Output codec; defaults to output suffix")
    args = parser.parse_args()
    token = os.environ.get("WEBSOUNDEDIT_TOKEN")
    if not token:
        parser.error("Set WEBSOUNDEDIT_TOKEN to the Bearer token printed by npm run api")

    def api(path, payload=None, binary=False, content_type="application/json"):
        data = payload if binary else json.dumps(payload).encode() if payload is not None else None
        request = Request(args.url.rstrip("/") + path, data=data,
                          headers={"Authorization": "Bearer " + token, "Content-Type": content_type})
        try:
            with urlopen(request, timeout=180) as response:
                result = response.read()
                return json.loads(result) if response.headers.get_content_type() == "application/json" else result
        except HTTPError as error:
            raise SystemExit(f"API {error.code}: {error.read().decode(errors='replace')}") from error

    api("/v1/execute", {"method": "project.new", "params": {"name": args.input.stem}})
    api("/v1/import?" + urlencode({"name": args.input.name}), args.input.read_bytes(), binary=True,
        content_type="application/octet-stream")
    if args.recipe:
        recipe = json.loads(args.recipe.read_text())
        commands = recipe if isinstance(recipe, list) else recipe.get("commands", recipe.get("steps"))
        api("/v1/execute", {"method": "recipe.run", "params": {"commands": commands}})
    else:
        api("/v1/execute", {"method": "effect.normalize", "params": {"targetDb": -1}})
    output = api("/v1/export", {"format": args.format or args.output.suffix.lstrip(".").lower() or "wav",
                                "bitDepth": 24, "render": {"scope": "mix"}})
    args.output.write_bytes(output)
    if args.project:
        args.project.write_text(json.dumps(api("/v1/project")), encoding="utf-8")
    print(f"Saved {args.output} ({len(output):,} bytes)")


if __name__ == "__main__":
    main()
