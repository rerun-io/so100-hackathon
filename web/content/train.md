---
title: "Train: prepare for training"
order: 4
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
| `observation.state` | the follower's joint positions (`.../position`), converted to LeRobot's normalized units (arm ±100 over the calibrated range, gripper 0–100 — the convention the SO-100/101 checkpoints train in; `--units degrees` to skip) |
| `action` | the goals the leader commanded (`.../goal`), same units |
| `task` | the task you typed when recording |
| `observation.images.top` / `.side` | one video stream per `camera/cam*`, renamed in cam-index order (`--camera-names` to override) |

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

## Fine-tune MolmoAct2

The hackathon's policy is [MolmoAct2](https://github.com/allenai/molmoact2), Ai2's open
vision-language-action model — and it consumes LeRobot v3 datasets natively, exactly what
you just exported. It is *language-conditioned*: the task string you typed while
recording becomes the command the policy responds to, and every team's dataset can be
pooled into one multi-task fine-tune. Use the branch with the policy integration
([allenai/lerobot `molmoact2-policy`](https://github.com/allenai/lerobot/tree/molmoact2-policy)),
and train on a GPU machine — the dataset is on the Hub, so it doesn't need your laptop.

First add the quantile normalization stats MolmoAct2 expects (once per dataset):

```bash
python src/lerobot/datasets/v30/augment_dataset_quantile_stats.py \
    --repo-id=<your-hf-user>/my_task
```

Then LoRA fine-tune, starting from the checkpoint already trained on pooled community
SO-100/SO-101 data (`allenai/MolmoAct2-SO100_101`) — don't start from the base model:

```bash
accelerate launch $(which lerobot_train) \
    --dataset.repo_id=<your-hf-user>/my_task \
    --policy.type=molmoact2 \
    --policy.checkpoint_path=allenai/MolmoAct2-SO100_101 \
    --policy.train_mode_vlm=lora \
    --policy.setup_type="single so100 robotic arm on a tabletop" \
    --policy.control_mode="absolute joint pose" \
    --batch_size=16 \
    --output_dir=outputs/molmoact2_my_task --job_name=molmoact2_my_task
```

Rough sizing: LoRA fits comfortably on one 40–80 GB GPU; with the VLM frozen
(`--policy.train_mode_vlm=freeze`, action expert still trains — that part matters most)
a single 24 GB card is enough. For a few hundred demos, batch 16–32 and ~10k steps is a
sensible starting point. To pool several teams' tasks, list multiple repo ids in the
dataset config — same robot, same `top`/`side` cameras, same control mode, distinct task
strings is all it takes.

Either way, while it cooks, head to Deploy to see how a trajectory gets back onto the robot.
