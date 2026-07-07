---
title: Welcome to Hackathon
order: 1
---

<aside class="highlight">
<h2>Today's goal</h2>
<p>Close a full robot-learning loop — set up, collect, refine, train, deploy — entirely on
your own laptop, and leave with a curated dataset you recorded yourself.</p>
</aside>

Today you'll close a full robot-learning loop on your own laptop:

1. **Set up** — calibrate a leader/follower pair of SO-100 arms and verify teleoperation.
2. **Collect** — teleoperate the follower and record episodes into a local [Rerun](https://rerun.io/) dataset.
3. **Refine** — query what you recorded, inspect it, and curate good episodes.
4. **Train** — export the dataset to LeRobot v3 (and optionally push it to the Hugging Face Hub).
5. **Deploy** — replay a trajectory back on the robot and close the loop.

All data stays on your machine, in the repo, as `recordings/<dataset>/<episode>.rrd` files.
One long-lived local process — `pixi run so100-server` — keeps a live view and a queryable
catalog of everything you record. You can stop it any time (lunch, overnight); restarting
it re-registers every recording found on disk.

## Hardware checklist

- Two SO-100 arms: a **leader** (handle + trigger) and a **follower** (gripper), each on USB.
  They enumerate as `/dev/cu.usbmodem<USB_ID>`.
- One or more USB webcams pointed at the workspace (the Mac's built-in webcam is skipped
  automatically).
- A powered USB hub helps if your laptop is short on ports.

No arms yet? Every step below also works in `--fake` camera-only mode, so you can rehearse
the whole loop.

## Install

Everything runs through [Pixi](https://pixi.sh) — install it first if you don't have it:

```bash
curl -fsSL https://pixi.sh/install.sh | sh
```

Then clone the repo and install the environment:

```bash
git clone https://github.com/rerun-io/so100-hackathon.git
cd so100-hackathon
pixi install
```

That's it — every command in this course is a `pixi run ...` task from the repo root.
Prefer doing everything from the terminal without this site? The repo's `README.md` is a
compressed, CLI-only version of exactly this course.
