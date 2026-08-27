---
title: "Deploy: close the loop"
order: 5
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
follower.

For your MolmoAct2 fine-tune (the Train page), the repo ships that loop. Start the
inference server on the GPU box that trained the checkpoint:

```bash
python tools/apps/policy_server_molmoact2.py --checkpoint <your-hf-user>/molmoact2_my_task --port 8080
```

then run the policy on the arm — **dry-run first, every time you change checkpoints**:

```bash
pixi run deploy-policy -- --task "pick up the ball" --server http://<gpu-box>:8080/act --dry-run
pixi run deploy-policy -- --task "pick up the ball" --server http://<gpu-box>:8080/act
```

Dry-run streams the model's predictions to the viewer above without moving the arm, so
you see what it *would* do. Live, every command is clamped to the calibrated joint range
and to `--max-step-deg` per tick — a bad prediction jitters instead of slamming. The
`--task` sentence is the command the policy follows; try the exact strings you recorded
with first, then paraphrases. One warning: the public `allenai/MolmoAct2-SO100_101`
checkpoint uses the older LeRobot v2.1 joint convention and will command wild poses on an
arm calibrated with this repo — deploy checkpoints fine-tuned on your own export.

## Every rollout is an episode

Live runs *record while deploying*: each rollout is written to
`recordings/molmoact2_eval/episode_NN.rrd` (rename with `--dataset`) with your `--task`
sentence as its task and the tag *Needs review*, and registered to the catalog — the
same take machinery as the Collect page. So the policy's autonomous runs land right next
to your teleop data: open them from the viewer, query them on Refine
(`pixi run query-dataset -- --dataset molmoact2_eval`), compare what the model did
against what you demonstrated — and if a rollout is actually good, tag it *Good episode*
and it can be exported and trained on like any other take. Pass `--dataset ""` to skip
recording; dry runs are never recorded.

## Close the loop

That's the whole cycle you now own end to end:

**collect** → **refine** → **train** → **deploy** → watch where the policy struggles →
**collect** exactly those cases into a new dataset → repeat.

The server keeps running through all of it; every dataset you add is just another folder
under `recordings/` and another name in the catalog. Go collect the data your robot is
missing.
