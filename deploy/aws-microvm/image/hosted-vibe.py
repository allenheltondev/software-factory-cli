#!/usr/local/bin/python3
"""Run hosted Vibe with a fresh profile and a single fixed Mistral API provider."""

import os
from pathlib import Path
import re
import sys
import tempfile

VIBE = "/usr/local/lib/updraft-vibe/bin/vibe"
args = sys.argv[1:]
if args in (["--version"], ["--help"]):
    os.execv(VIBE, [VIBE, *args])

if not os.environ.get("MISTRAL_API_KEY"):
    sys.exit("MISTRAL_API_KEY is required for hosted Vibe")

model = "mistral-medium-latest"
if "--model" in args:
    index = args.index("--model")
    model = args[index + 1] if index + 1 < len(args) else ""
    del args[index:index + 2]
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", model):
    sys.exit("Hosted Vibe requires a Mistral API model ID")

home = Path(tempfile.mkdtemp(prefix="updraft-vibe-"))
os.environ["VIBE_HOME"] = str(home)
(home / "config.toml").write_text(
    f'''active_model = "updraft-mistral"
enable_telemetry = false
enable_update_checks = false
enable_mcp = false
enable_connectors = false
enable_subagents = false

[[providers]]
name = "updraft-mistral-api"
api_base = "https://api.mistral.ai/v1"
api_key_env_var = "MISTRAL_API_KEY"
api_style = "openai"
backend = "generic"

[[models]]
name = "{model}"
provider = "updraft-mistral-api"
alias = "updraft-mistral"
''',
    encoding="utf-8",
)
os.execv(VIBE, [VIBE, *args])
