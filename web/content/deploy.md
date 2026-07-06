---
title: "Deploy: close the loop"
section: The data collection loop
order: 6
minutes: 10
youllLearn:
  - Replaying a recorded episode back on the follower arm
  - How a trained policy runs on the same plumbing
  - What "closing the loop" means for your next dataset
---

The last step is getting motion *back onto* the robot. The simplest deployment is replay:
drive the follower through the action trajectory of an episode you recorded — no policy
needed, and it proves the whole chain (dataset → actions → servos) works.

<div data-viewer></div>

## Replay an episode

With `pixi run so100-server` running and the follower plugged in (leader not needed —
but **disconnect the arms** on the Collect page first if you connected them there, the
serial port is exclusive):

```bash
pixi run replay-episode -- --dataset my_task --episode episode_1
```

The tool queries the episode's action series from the catalog, ramps the follower gently to
the starting pose, then plays the trajectory at recorded speed (`--speed 0.5` for half).
The replayed joints stream to the viewer above, so you can compare against the recording.
Torque is released when it finishes. Keep a hand near the arm on first replay.

## From replay to policy

A trained policy is the same loop with the trajectory computed live instead of read from
the catalog: observe (joint state + camera frames) → infer an action chunk → drive the
follower. LeRobot ships this loop ready-made for SO-100-class arms:

```bash
lerobot-record --robot.type=so100_follower \
    --policy.path=outputs/act_my_task/checkpoints/last/pretrained_model \
    --dataset.repo_id=<your-hf-user>/eval_my_task
```

Note it *records while deploying* — evaluation runs are themselves episodes.

## Close the loop

That's the whole cycle you now own end to end:

**collect** → **refine** → **train** → **deploy** → watch where the policy struggles →
**collect** exactly those cases into a new dataset → repeat.

The server keeps running through all of it; every dataset you add is just another folder
under `recordings/` and another name in the catalog. Go collect the data your robot is
missing.
