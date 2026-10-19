"""Execute the pinned Python profile skill selector; no network or providers."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
os.environ["OPENHANDS_SUPPRESS_BANNER"] = "1"

parser = argparse.ArgumentParser()
parser.add_argument("--upstream", type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
pin = json.loads((root / "transpile/upstream.json").read_text())["commit"]
if subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=args.upstream, text=True).strip() != pin:
    raise SystemExit("Python checkout must match canonical source pin")
if subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=args.upstream, text=True).strip():
    raise SystemExit("Python checkout must be clean")
sys.path.insert(0, str(args.upstream / "openhands-sdk"))
from openhands.sdk.profiles.resolver import _select_skills
from openhands.sdk.skills import Skill
import openhands.sdk.profiles.resolver as resolver
assert Path(resolver.__file__).resolve().is_relative_to(args.upstream.resolve())

catalog = [{"name": "selected", "content": "old"}, {"name": "other", "content": "other"}, {"name": "user", "content": "user"}, {"name": "blocked", "content": "blocked"}, {"name": "selected", "content": "new"}]
cases = []
for selected in [None, [], ["selected"], ["missing"]]:
    for tier in [None, ["selected", "other", "blocked"]]:
        result = _select_skills([Skill(**item) for item in catalog], ["blocked"], selected, None if tier is None else set(tier))
        cases.append({"catalog": catalog, "disabled": ["blocked"], "publicSkills": selected, "publicSkillNames": tier, "expected": [{"name": item.name, "content": item.content} for item in result]})
out = root / "src/launch/__tests__/fixtures/python-profile-skill-selection.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps({"upstreamCommit": pin, "source": "openhands-sdk/openhands/sdk/profiles/resolver.py::_select_skills", "cases": cases}, indent=2) + "\n")
print(f"Generated {len(cases)} actual pinned profile selection cases")
