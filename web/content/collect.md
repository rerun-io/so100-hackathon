---
title: "Collect"
order: 3
---

Make sure `pixi run so100-server` is still running, then work straight from this page.

- **Livestream** — operate the robot in real time. It is one continuous stream for the whole session, kept only in memory and flushed oldest-first when memory runs low. Nothing is stored and nothing piles up. 
- **Recording** — once you're ready to collect hit that record button. It will be stored in the local server from where you could query it later when curating dataset for training.

<div data-collect></div>

## The episode panel

- **Dataset** — a named collection of episodes; on disk it's the folder
  `recordings/<dataset>/`, in the catalog it's a dataset of the same name. Pick an
  existing one or create a new one per task.
- **Episode id** — assigned by the server, never editable: `episode_01`, `episode_02`, …
  always the highest existing number plus one, so an id refers to one take forever. The
  mark next to the id shows its state: nothing (not recorded yet), a red dot (recording
  right now), a green check (saved to the catalog).
- **Task** — the natural-language task description, e.g. *"Pick up the ball and place it
  in the box"*. It becomes the LeRobot **task** string when you later export.
- **Tag** — a curation label: *Good episode*, *Bad episode*, or *Needs review*. You'll
  filter by it on the Refine page.

You can fill in the task before you ever hit record — the draft rides along with
**Start recording**. From then on, edits are saved only when you press
**Save properties**: while the take is still recording they are stamped into the live
recording, and for finished episodes they are re-registered as an `edits` catalog layer —
the same `property:...` columns, rewritten without touching the data. Every property
lives **inside the catalog**, no sidecar files.

**Start recording** writes the take straight to disk while the viewer keeps showing the
livestream — you watch the robot, not a file. On **Stop current recording** the file is
compacted, registered into the local catalog, and the viewer opens the fresh episode
**straight from the catalog** for review; you'll see the green check and a confirmation
the moment it lands. **Start new recording** slides the panel to the next episode id,
returns the viewer to the livestream, and goes again.

The ‹ › arrows browse every recorded episode — the viewer follows along, and if you
switch recordings inside the viewer instead, the panel follows you. Record a handful of
takes of the same task; honestly tag the bad ones instead of deleting them.

## Recording etiquette (for good training data)

- Keep the camera view fixed between episodes of a dataset.
- Vary the initial scene a little (object position) between takes.
- Prefer many short, clean episodes over few long ones.
- One consistent task per dataset; the task should describe *what*, not *how*.

## Prefer the terminal?

The standalone CLI records + registers without touching this page (it opens the arms
itself, so if you started the livestream above, press **Stop the feed** first — serial
ports are exclusive):

```bash
pixi run record-episode -- --dataset my_task --task "Pick up the ball" --tag "Good episode"
```

Enter stops the take (or pass `--seconds 15`). The episode id defaults to the next free
`episode_NN`, exactly like the panel. And the control API this page uses is plain JSON
over HTTP, so `curl` works too:

```bash
curl -X POST localhost:8000/arms/connect
curl -X POST localhost:8000/live/pause      # and /live/resume: same stream, gap in between
curl -X POST localhost:8000/start -d '{"dataset": "my_task", "task": "Pick up the ball"}'
curl -X POST localhost:8000/stop  -d '{"tag": "Good episode"}'
curl localhost:8000/episodes?dataset=my_task
curl -X POST localhost:8000/episode/update \
  -d '{"dataset": "my_task", "episode": "episode_01", "task": "Pick up the ball", "tag": "Bad episode"}'
```

Either way the result is the same file in `recordings/<dataset>/`, registered to the same
catalog — which is what we'll query next.
