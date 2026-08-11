from __future__ import annotations

import json
from pathlib import Path

from skillopt.datasets.base import SplitDataLoader


class NmgPolicyDataLoader(SplitDataLoader):
    """Load NMG's already-split, de-identified policy observations."""

    def load_split_items(self, split_path: str) -> list[dict]:
        path = Path(split_path, "items.json")
        if not path.exists():
            return []
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, list):
            raise ValueError(f"Expected a JSON array in {path}")
        return [dict(item) for item in value]
