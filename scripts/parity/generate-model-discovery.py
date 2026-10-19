#!/usr/bin/env python3
"""Snapshot the locked dependency catalog for offline native model discovery."""
import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import tarfile
import tempfile
import tomllib


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--litellm-archive", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    pin = json.loads((root / "transpile/upstream.json").read_text())["commit"]
    source_head = subprocess.check_output(["git", "-C", args.upstream, "rev-parse", "HEAD"], text=True).strip()
    if source_head != pin:
        raise ValueError("Python checkout must match the canonical full pin")
    lock_bytes = subprocess.check_output(["git", "-C", args.upstream, "show", f"{pin}:uv.lock"])
    locked = next(item for item in tomllib.loads(lock_bytes.decode())["package"] if item["name"] == "litellm")
    if importlib.metadata.version("litellm") != locked["version"]:
        raise ValueError("Use the pinned checkout's locked Python environment")
    archive_hash = digest(args.litellm_archive.read_bytes())
    if "sha256:" + archive_hash != locked["sdist"]["hash"]:
        raise ValueError("LiteLLM archive differs from the pinned lock")
    package = Path(importlib.util.find_spec("litellm").origin).parent
    sources = {}
    with tarfile.open(args.litellm_archive) as archive:
        for relative in ["__init__.py", "model_prices_and_context_window_backup.json"]:
            member = next(item for item in archive.getmembers() if item.name.endswith("/litellm/" + relative))
            contents = archive.extractfile(member).read()
            if (package / relative).read_bytes() != contents:
                raise ValueError(f"Installed LiteLLM differs from locked source: {relative}")
            sources[relative] = digest(contents)
    import litellm
    # LiteLLM builds model_list from sets, so fix presentation order, not membership.
    model_ids = sorted(litellm.model_list)
    cost_ids = sorted(litellm.model_cost)
    if not all(isinstance(model, str) for model in model_ids + cost_ids):
        raise ValueError("Unexpected dependency catalog shape")
    provenance = {"upstream_commit": pin, "uv_lock_sha256": digest(lock_bytes),
                  "litellm_version": locked["version"], "litellm_sdist_sha256": archive_hash,
                  "source_sha256": sources, "model_ids_sha256": digest(json.dumps(model_ids).encode()),
                  "model_cost_ids_sha256": digest(json.dumps(cost_ids).encode())}
    output = "// Generated offline by scripts/parity/generate-model-discovery.py.\n"
    output += "export const MODEL_DISCOVERY_PROVENANCE = " + json.dumps(provenance, indent=2) + " as const;\n\n"
    output += "export const LOCKED_MODEL_IDS: readonly string[] = " + json.dumps(model_ids, indent=2) + ";\n\n"
    output += "export const LOCKED_MODEL_COST_IDS: readonly string[] = " + json.dumps(cost_ids, indent=2) + ";\n"
    (root / "src/llm/model-discovery-catalog.ts").write_text(output)
    print(f"Generated {len(model_ids)} model IDs and {len(cost_ids)} metadata IDs at {pin}")


if __name__ == "__main__":
    def deny_network(*_args, **_kwargs):
        raise RuntimeError("Network access is disabled for catalog generation")
    socket.socket.connect = deny_network
    socket.socket.connect_ex = deny_network
    socket.getaddrinfo = deny_network
    os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
    with tempfile.TemporaryDirectory(prefix="model-discovery-oracle-") as temporary:
        os.environ["CHATGPT_TOKEN_DIR"] = str(Path(temporary) / "chatgpt")
        os.environ["GITHUB_COPILOT_TOKEN_DIR"] = str(Path(temporary) / "copilot")
        main()
