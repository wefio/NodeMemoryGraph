"""Measure current and static-first prompt-prefix token ceilings."""

from __future__ import annotations

import argparse
import json
import string
import sys
from pathlib import Path

import tiktoken


def prefix_stats(template: str, encoding) -> dict[str, int | float]:
    parts = list(string.Formatter().parse(template))
    current_prefix = parts[0][0] if parts else template
    static_text = "".join(literal for literal, _field, _spec, _conversion in parts)
    current = len(encoding.encode(current_prefix))
    static = len(encoding.encode(static_text))
    return {
        "currentPrefixTokens": current,
        "staticLiteralTokens": static,
        "additionalStaticTokens": static - current,
        "currentStaticCoverage": round(current / static, 4) if static else 1.0,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scripts-dir", type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(args.scripts_dir))
    from utils import prompts

    encoding = tiktoken.get_encoding("cl100k_base")
    names = [
        "LOCOMO_ANSWER_PROMPT",
        "LME_ANSWER_PROMPT",
        "BEAM_ANSWER_PROMPT",
        "HM_ANSWER_PROMPT",
        "HM_ANSWER_USER",
        "PM_ANSWER_PROMPT",
        "JUDGE_PROMPT",
        "HM_JUDGE_PROMPT",
        "BEAM_RUBRIC_ITEM_JUDGE_PROMPT",
        "BEAM_EVENT_ORDERING_JUDGE_PROMPT",
    ]
    print(
        json.dumps(
            {name: prefix_stats(getattr(prompts, name), encoding) for name in names},
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
