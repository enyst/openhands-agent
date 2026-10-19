"""Regenerate the TS catalog from the canonical pinned checkout: script /path/to/python-sdk."""
import ast
import hashlib
import importlib.metadata
import importlib.util
import tomllib
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parents[2]
pin = json.loads((root / "transpile/upstream.json").read_text())["commit"]
source = subprocess.check_output(["git", "-C", sys.argv[1], "show", f"{pin}:openhands-sdk/openhands/sdk/llm/utils/verified_models.py"], text=True)
values = {}
for statement in ast.parse(source).body:
    if isinstance(statement, ast.Assign):
        node = statement.value
        values[statement.targets[0].id] = (
            {ast.literal_eval(key): values[value.id] for key, value in zip(node.keys, node.values)}
            if isinstance(node, ast.Dict) else ast.literal_eval(node)
        )
# Catalog validation is offline and reads the actual locked dependency registry.
lock = tomllib.loads(subprocess.check_output(["git", "-C", sys.argv[1], "show", f"{pin}:uv.lock"], text=True))
locked = next(package for package in lock["package"] if package["name"] == "litellm")
if importlib.metadata.version("litellm") != locked["version"]:
    raise ValueError("Run with the pinned checkout's locked Python environment")
package = pathlib.Path(importlib.util.find_spec("litellm").origin).parent
registry_bytes = (package / "model_prices_and_context_window_backup.json").read_bytes()
registry = json.loads(registry_bytes)
routes = values.get("VERIFIED_OPENROUTER_MODELS", [])
if any(model.startswith("openrouter/") for model in routes):
    raise ValueError("Verified OpenRouter entries must omit the transport prefix")
# The source's curated list can be newer than the locked package's bundled map.
# Record that gap instead of inventing local context limits or fetching a moving map.
missing_routes = [model for model in routes if "openrouter/" + model not in registry]
output = "// Generated from pinned Python llm/utils/verified_models.py; run scripts/parity/generate-verified-models.py.\n"
output += "export const VERIFIED_MODELS_PROVENANCE = " + json.dumps({"upstream_commit": pin, "source_sha256": hashlib.sha256(source.encode()).hexdigest(), "litellm_version": locked["version"], "model_map_sha256": hashlib.sha256(registry_bytes).hexdigest(), "openrouter_routes_missing_from_locked_map": missing_routes}, indent=2) + " as const;\n\n"
for name, value in values.items():
    output += f"export const {name} = {json.dumps(value, indent=2)} as const;\n\n"
(root / "src/llm/verified-models.ts").write_text(output)
