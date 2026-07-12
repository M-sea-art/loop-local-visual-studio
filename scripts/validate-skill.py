#!/usr/bin/env python3
"""Validate the LLVS skill and JSON contracts using the Python standard library."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def fail(message: str) -> None:
    raise SystemExit(f"validation failed: {message}")


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: validate-skill.py <skill-directory>")

    skill_dir = Path(sys.argv[1]).resolve()
    skill_file = skill_dir / "SKILL.md"
    agent_file = skill_dir / "agents" / "openai.yaml"
    if not skill_file.is_file():
        fail("SKILL.md is missing")
    if not agent_file.is_file():
        fail("agents/openai.yaml is missing")

    text = skill_file.read_text(encoding="utf-8")
    match = re.match(r"\A---\r?\n(.*?)\r?\n---\r?\n", text, re.DOTALL)
    if not match:
        fail("SKILL.md frontmatter is malformed")

    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" not in line:
            fail(f"invalid frontmatter line: {line!r}")
        key, value = line.split(":", 1)
        fields[key.strip()] = value.strip()

    if set(fields) != {"name", "description"}:
        fail("frontmatter must contain exactly name and description")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", fields["name"]):
        fail("skill name must use lowercase hyphen-case")
    if fields["name"] != skill_dir.name:
        fail("skill folder and frontmatter name differ")
    if not fields["description"]:
        fail("skill description is empty")

    agent_text = agent_file.read_text(encoding="utf-8")
    for required in ("display_name", "short_description", "default_prompt"):
        if not re.search(rf"^\s{{2}}{required}:\s*\S", agent_text, re.MULTILINE):
            fail(f"agents/openai.yaml is missing {required}")

    repo_root = skill_dir.parents[1]
    for json_path in sorted((repo_root / "visual").rglob("*.json")):
        with json_path.open(encoding="utf-8") as handle:
            document = json.load(handle)
        if json_path.name.endswith(".schema.json") and "$schema" not in document:
            fail(f"JSON schema is missing $schema: {json_path}")

    registry = json.loads((repo_root / "visual/products/registry.json").read_text(encoding="utf-8"))
    if registry.get("schemaVersion") != 1 or not isinstance(registry.get("products"), list):
        fail("product registry contract is invalid")
    for product in registry["products"]:
        for field in ("root", "visualSpec"):
            referenced_path = repo_root / product[field]
            if not referenced_path.exists():
                fail(f"registered product path is missing: {referenced_path}")
        visual_spec = json.loads((repo_root / product["visualSpec"]).read_text(encoding="utf-8"))
        entry_path = repo_root / product["root"] / visual_spec["entry"]
        if not entry_path.is_file():
            fail(f"visual fixture entry is missing: {entry_path}")
        viewport_names = [item["name"] for item in visual_spec.get("viewports", [])]
        if len(viewport_names) != 4 or len(set(viewport_names)) != 4:
            fail(f"public fixture must define four unique viewports: {product['id']}")

    print(f"validated skill {fields['name']} and public JSON contracts")


if __name__ == "__main__":
    main()
