"""Saved canvas positions of devices, kept in a JSON file."""

import json
from pathlib import Path

from app.models import NodePosition


def load_positions(path: Path) -> dict[str, NodePosition]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return {node_id: NodePosition(**pos) for node_id, pos in data.items()}


def prune_positions(path: Path, on_canvas: set[str], renames: dict[str, str]) -> None:
    """Keep only devices on the canvas. A renamed device keeps its position under the new id."""
    saved = load_positions(path)
    if not saved:
        return
    for old, new in renames.items():
        if old in saved and new not in saved:
            saved[new] = saved[old]
    kept = {node_id: pos for node_id, pos in saved.items() if node_id in on_canvas}
    if kept.keys() == saved.keys():
        return
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({k: v.model_dump() for k, v in sorted(kept.items())}, indent=2), encoding="utf-8")
    tmp.replace(path)


def save_positions(path: Path, positions: dict[str, NodePosition]) -> dict[str, NodePosition]:
    """Merge with the saved positions, so devices not on the canvas now keep theirs."""
    merged = load_positions(path) | positions
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    data = {node_id: pos.model_dump() for node_id, pos in sorted(merged.items())}
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(path)
    return merged
