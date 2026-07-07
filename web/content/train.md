---
title: "Train: prepare for training"
order: 5
---

Training stacks (LeRobot, and most policies built on it) consume the **LeRobot dataset
format**. The export tool reads your episodes from the local catalog and writes a LeRobot
v3 dataset — by default only the episodes tagged *Good episode*, so the curation you did on
the Refine page carries straight through.

## Export locally

With `pixi run so100-server` still running:

```bash
pixi run export-lerobot -- --dataset my_task --repo-id <your-hf-user>/my_task
```

This writes a complete LeRobot v3 dataset to `datasets/<your-hf-user>/my_task/` (parquet
episodes + MP4-encoded camera videos + metadata). Include everything regardless of tag with
`--tag ""`.

The mapping out of your recordings:

| LeRobot | from the recording |
| --- | --- |
| `observation.state` | the follower's calibrated joint positions (`.../position`) |
| `action` | the goals the leader commanded (`.../goal`) |
| `task` | the task you typed when recording |
| `observation.images.*` | one video stream per `camera/cam*` |

## Push to the Hugging Face Hub

Log in once (creates a token at huggingface.co/settings/tokens if you don't have one):

```bash
pixi run -e export hf auth login
```

then export with `--push`:

```bash
pixi run export-lerobot -- --dataset my_task --repo-id <your-hf-user>/my_task --push
```

Your dataset is now public infrastructure: loadable by anyone (including a training job on
a GPU box) with `LeRobotDataset("<your-hf-user>/my_task")`.

## Train a policy

Training itself is standard [LeRobot](https://github.com/huggingface/lerobot) — for example
an ACT policy on your dataset:

```bash
lerobot-train --dataset.repo_id=<your-hf-user>/my_task --policy.type=act \
    --output_dir=outputs/act_my_task --job_name=act_my_task
```

Train on a GPU machine if you can (the dataset is on the Hub, so it doesn't need your
laptop). While it cooks, head to Deploy to see how a trajectory gets back onto the robot.
