---
title: "Set up: test and calibrate your robot"
section: The data collection loop
order: 2
minutes: 15
youllLearn:
  - Starting the long-lived local data server
  - Pinging your arms and watching live telemetry
  - Calibrating the leader and follower arms from the page
  - Verifying teleoperation before you record
---

Time to make sure the hardware actually works: ping, calibrate, teleoperate. Every step on
this page runs in the embedded Rerun viewers below — the buttons drive the exact same
tools you could run in a terminal, so a command is shown next to each button if you prefer
that.

## First: start the local data server

Everything below (and the rest of the course) talks to one long-lived local process. In a
terminal at the repo root:

```bash
pixi run so100-server
```

Leave it running for the rest of the day. It hosts a live stream this site's embedded
viewers connect to (port 9876), a catalog of all your recordings (port 51234), and a small
control API that powers the buttons on this page and the Collect page (port 8000). It does
**not** hold the arms — the serial ports stay free, so the setup tools below (and your own
terminal runs) can grab them anytime.

As soon as it's up, the overlays below light up.

## Smoke test

Plug in both arms, then hit the button. A live feed opens with an animated URDF per arm
plus joint telemetry — wiggle a joint by hand and watch it move. Stop the feed when
convinced.

<div data-setup="ping"></div>

Uncalibrated arms show up with a fallback calibration — poses will look wrong until the
next step. That's expected.

## Calibrate

Each arm is calibrated once. The viewer walks you through it: match the gray **target**
pose (this defines 0° for every joint), then sweep every joint through its full range of
motion — including fully opening/closing the gripper, or squeezing/releasing the leader's
trigger. The leader arm goes first; the follower starts automatically after it.

If both arms are plugged in, the first screen asks you to **wiggle** the arm you're about
to calibrate so the right port is picked.

<div data-setup="calibrate"></div>

Calibration is written to `calibrations/<usb_id>.json` and to the servos themselves, so it
survives replugging — the green badge above sticks around once both arms are done.

## Verify teleoperation

Torque turns on and the follower mirrors the leader (it glides to the leader's pose over
~1.5 s rather than jumping). Drive it around and check every joint tracks — this is
exactly the mode you'll record in. Stopping the feed releases the follower's torque.

<div data-setup="teleop"></div>

When mirroring feels right, move on to Collect.
