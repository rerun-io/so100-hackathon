"""LeRobot-side half of the export (see export_lerobot.py, which spawns this).

Runs inside the isolated ``export`` pixi environment -- the only place ``lerobot`` is
installed (its rerun-sdk pin conflicts with the repo's). Reads the staged episodes
(action/state .npy + camera JPEGs + manifest.json) and writes a LeRobot v3 dataset;
``--push`` uploads it to the Hugging Face Hub as a private repo.

Not meant to be run by hand.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def build(stage: Path, root: Path) -> tuple[str, Path]:
    from lerobot.datasets.lerobot_dataset import LeRobotDataset  # pyrefly: ignore[missing-import] - export env only

    manifest = json.loads((stage / "manifest.json").read_text())
    repo_id: str = manifest["repo_id"]
    motor_names: list[str] = manifest["motor_names"]
    cameras: list[str] = manifest["cameras"]

    def load_jpeg(path: Path) -> np.ndarray:
        import cv2

        image = cv2.imread(str(path))
        if image is None:
            raise RuntimeError(f"failed to decode staged frame {path}")
        return cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

    features: dict = {
        "action": {"dtype": "float32", "shape": (len(motor_names),), "names": motor_names},
        "observation.state": {"dtype": "float32", "shape": (len(motor_names),), "names": motor_names},
    }
    for camera in cameras:
        first = next((stage / manifest["episodes"][0]["dir"] / camera).glob("*.jpg"))
        height, width, channels = load_jpeg(first).shape
        features[f"observation.images.{camera}"] = {
            "dtype": "video",
            "shape": (height, width, channels),
            "names": ["height", "width", "channels"],
        }

    dataset = LeRobotDataset.create(
        repo_id=repo_id,
        fps=manifest["fps"],
        features=features,
        root=root / repo_id,
        robot_type="so100_follower",
        use_videos=True,
    )

    for episode in manifest["episodes"]:
        episode_dir = stage / episode["dir"]
        action = np.load(episode_dir / "action.npy")
        state = np.load(episode_dir / "state.npy")
        for index in range(len(action)):
            frame = {
                "action": action[index],
                "observation.state": state[index],
                "task": episode["task"],
            }
            for camera in cameras:
                frame[f"observation.images.{camera}"] = load_jpeg(episode_dir / camera / f"{index:06d}.jpg")
            dataset.add_frame(frame)
        dataset.save_episode()
        print(f"  wrote episode '{episode['name']}' ({len(action)} frames)")

    dataset.finalize()
    return repo_id, root / repo_id


def push(repo_id: str, root: Path) -> None:
    from lerobot.datasets.lerobot_dataset import LeRobotDataset  # pyrefly: ignore[missing-import] - export env only

    dataset = LeRobotDataset(repo_id, root=root / repo_id)
    print(f"pushing to https://huggingface.co/datasets/{repo_id} (private) ...")
    dataset.push_to_hub(private=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--stage", type=Path, default=None)
    parser.add_argument("--repo-id", default=None)
    parser.add_argument("--push", action="store_true")
    args = parser.parse_args()

    if args.stage is not None:
        repo_id, _ = build(args.stage, args.root)
    else:
        repo_id = args.repo_id
        if repo_id is None:
            raise SystemExit("--repo-id is required without --stage")
    if args.push:
        push(repo_id, args.root)


if __name__ == "__main__":
    main()
