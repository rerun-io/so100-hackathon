// SO-100 course-site widgets.
//
// Three markers in the markdown are expanded here:
//   <div data-viewer></div>   -> an embedded Rerun web viewer connected to the local
//                                so100-server's gRPC proxy (rerun+http://localhost:9876/proxy)
//   <div data-collect></div>  -> the collect card: Recording / Livestream tabs, an episode
//                                side panel, and the viewer, driving the server's control
//                                API (http://localhost:8000)
//   <div data-setup="ping|calibrate|teleop"></div>
//                             -> one Set-up step: header with action buttons + a viewer
//                                showing the tool's live feed (the server runs the same
//                                CLI tool as a subprocess via POST /setup/*)
//
// The site itself is static: everything below talks to the *local* long-lived server
// (`pixi run so100-server`). When it's down, widgets show a hint and keep retrying.

const CONTROL_URL = "http://localhost:8000";
const PROXY_URL = "rerun+http://localhost:9876/proxy";
const TAGS = ["Good episode", "Bad episode", "Needs review"];
const NEW_DATASET = "__new__";

// ---- control API -----------------------------------------------------------------

async function api(path, body = undefined) {
  const response = await fetch(CONTROL_URL + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000), // /stop optimizes + registers, which takes a while
  });
  return await response.json();
}

async function serverUp() {
  try {
    const response = await fetch(CONTROL_URL + "/status", { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One shared /status poll for every widget on the page (they all re-render from it).
// A widget can also push the response of its own POST so the others update instantly.
const statusSubscribers = new Set();
let statusTimer = null;

function publishStatus(status) {
  for (const subscriber of statusSubscribers) subscriber(status);
}

function subscribeStatus(subscriber) {
  statusSubscribers.add(subscriber);
  if (statusTimer === null) {
    const poll = async () => {
      let status = null;
      try {
        status = await api("/status");
      } catch {
        /* server down; widgets render their offline state */
      }
      publishStatus(status);
    };
    poll();
    statusTimer = setInterval(poll, 2000);
  }
}

function wireCopy(button, text) {
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied!";
    } catch {
      button.textContent = "Copy failed";
    }
    setTimeout(() => (button.textContent = "Copy"), 1500);
  });
}

// ---- embedded viewer ---------------------------------------------------------------

// The viewer autofocuses its <canvas>, and a plain focus() scrolls the canvas into
// view -- yanking the page (on boot AND when leaving fullscreen). Override focus() the
// moment the canvas is inserted so focusing never scrolls; keyboard input still works.
function preventFocusScroll(parent) {
  const observer = new MutationObserver(() => {
    const canvas = parent.querySelector("canvas");
    if (!canvas) return;
    const original = HTMLElement.prototype.focus;
    canvas.focus = function (opts) {
      original.call(this, { ...opts, preventScroll: true });
    };
    observer.disconnect();
  });
  observer.observe(parent, { childList: true, subtree: true });
}

// NOTE: width/height must stay "" -- the canvas is sized by CSS (.viewer-box canvas).
// Passing "100%" would set inline styles, which the viewer's fullscreen toggle wipes
// with removeAttribute("style") on exit, leaving an unsized canvas (and a WASM panic).
const VIEWER_OPTIONS = {
  width: "",
  height: "",
  hide_welcome_screen: true,
  allow_fullscreen: true,
};

// A show/hide-able viewer inside a .viewer-box (used by the Set up and Collect widgets):
// boots against a per-run/per-session proxy url, keeps a cover over the canvas until the
// wanted recording is active, and switches recordings when the server-side id changes --
// only on change, so it never fights the user's own clicks in the recording panel.
function viewerSlot(box) {
  const overlay = box.querySelector(".viewer-overlay");
  const loadingCover = box.querySelector(".viewer-loading");
  let viewer = null;
  let wanted = null; // recording id the server wants shown
  let synced = null; // last id we successfully switched to
  let followWanted = false; // after switching, jump to the end and press play (live takes)
  let revealTimer = null;
  let retryTimer = null;
  let bootGen = 0; // bumped by hide()/show(): cancels any in-flight show()
  let queuedFocus = null; // focus() requested while the viewer was still booting
  const openedUrls = new Set(); // catalog deep links already added as receivers

  function trySync() {
    if (!viewer || !wanted) return false;
    if (synced !== wanted) {
      try {
        if (viewer.get_active_recording_id() !== wanted) viewer.set_active_recording_id(wanted);
        if (viewer.get_active_recording_id() === wanted) synced = wanted;
      } catch {
        /* viewer still booting or recording not arrived yet; retried by the timer */
      }
    }
    if (synced === wanted && followWanted) {
      // "Following mode": the user was reviewing an old take when a new one started.
      // Jump the cursor to the head of the live take and play, so it keeps following.
      try {
        const timeline = viewer.get_active_timeline(wanted);
        const range = timeline ? viewer.get_time_range(wanted, timeline) : null;
        if (range) {
          viewer.set_current_time(wanted, timeline, range.max);
          viewer.set_playing(wanted, true);
          followWanted = false;
        }
      } catch {
        /* timeline not ready yet; retried by the timer */
      }
    }
    return synced === wanted && !followWanted;
  }

  // Retry until the wanted recording is active (it may still be downloading/streaming),
  // then STOP -- so the user can freely switch recordings in the viewer afterwards.
  function keepTrying() {
    if (trySync() || retryTimer !== null) return;
    const deadline = Date.now() + 15_000;
    retryTimer = setInterval(() => {
      if (trySync() || Date.now() >= deadline) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
    }, 250);
  }

  async function show(proxyUrl) {
    if (viewer) return;
    const gen = ++bootGen;
    overlay.hidden = true;
    // Cover the canvas until this run's recording is actually active (fallback
    // deadline, so a missing id can't hide the viewer forever).
    loadingCover.hidden = false;
    const deadline = Date.now() + 8000;
    clearInterval(revealTimer);
    revealTimer = setInterval(() => {
      if (trySync() || Date.now() >= deadline) {
        loadingCover.hidden = true;
        clearInterval(revealTimer);
        revealTimer = null;
      }
    }, 250);
    const { WebViewer } = await import("/viewer/index.js");
    if (gen !== bootGen) return; // hidden (or re-shown) while the module loaded
    viewer = new WebViewer();
    preventFocusScroll(box);
    await viewer.start(proxyUrl, box, VIEWER_OPTIONS);
    if (gen !== bootGen) return;
    if (queuedFocus) {
      const { segmentId, url } = queuedFocus;
      queuedFocus = null;
      focus(segmentId, url);
    }
  }

  // soft: keep the overlay hidden -- used when the viewer is immediately re-shown
  // against a fresh proxy (a new arms session on a new port).
  function hide({ soft = false } = {}) {
    bootGen++;
    clearInterval(revealTimer);
    revealTimer = null;
    clearInterval(retryTimer);
    retryTimer = null;
    loadingCover.hidden = true;
    viewer?.stop();
    viewer = null;
    wanted = null;
    synced = null;
    followWanted = false;
    queuedFocus = null;
    openedUrls.clear();
    overlay.hidden = soft;
  }

  function want(recordingId, { follow = false } = {}) {
    if (!recordingId) return;
    if (wanted !== recordingId) {
      wanted = recordingId;
      synced = null;
      // follow applies on CHANGE only, so callers can pass it on every poll without
      // re-jumping a stream the user deliberately scrubbed back in.
      if (follow) followWanted = true;
    }
    keepTrying();
  }

  // Force following mode on the wanted recording (jump to the head + play), even if the
  // viewer is already on it -- for explicit "take me to the stream" moments.
  function refollow() {
    if (!wanted) return;
    followWanted = true;
    keepTrying();
  }

  // Focus a catalog episode: download it once (open is a no-op-cache after that, so
  // browsing back to an episode is instant), then switch to it as soon as it's loaded.
  function focus(segmentId, url) {
    if (!viewer) {
      queuedFocus = { segmentId, url }; // delivered by show() once the viewer is up
      return;
    }
    if (url && !openedUrls.has(url)) {
      try {
        viewer.open(url);
        openedUrls.add(url);
      } catch (error) {
        console.warn("viewer.open failed:", error);
      }
    }
    want(segmentId);
  }

  // The recording the *user* is looking at right now (for panel <- viewer sync).
  function active() {
    try {
      return viewer?.get_active_recording_id() ?? null;
    } catch {
      return null;
    }
  }

  return { show, hide, want, refollow, focus, active };
}

// One always-on viewer for plain <div data-viewer> embeds (Deploy page), connected to
// the server's main proxy at :9876.
let viewerPromise = null;

function viewerBox() {
  const box = document.createElement("div");
  box.className = "viewer-box";
  box.innerHTML = `<div class="viewer-overlay"><div class="spinner"></div>
    <div>Waiting for the local data server&hellip;</div>
    <div class="overlay-cmd"><code>pixi run so100-server</code>
      <button type="button" class="copy-btn" title="Copy command">Copy</button></div>
    <div>Run it in the repo &mdash; this page connects automatically.</div></div>`;
  wireCopy(box.querySelector(".copy-btn"), "pixi run so100-server");
  return box;
}

function bootViewer(box) {
  viewerPromise ??= (async () => {
    while (!(await serverUp())) await sleep(2000);
    const { WebViewer } = await import("/viewer/index.js");
    const viewer = new WebViewer();
    box.querySelector(".viewer-overlay")?.remove();
    preventFocusScroll(box);
    await viewer.start(PROXY_URL, box, VIEWER_OPTIONS);
    return viewer;
  })();
  return viewerPromise;
}

function initViewer(root) {
  const box = viewerBox();
  root.replaceWith(box);
  bootViewer(box);
}

// ---- setup step widgets -------------------------------------------------------------

const SETUP_STEPS = {
  ping: {
    num: 1,
    title: "Test if your arms are connected",
    sub: "Plug in both arms. Ping, wiggle a joint by hand and watch it move.",
    action: "PING!",
    cmd: "pixi run log-so100",
    stopLabel: "STOP THE FEED",
  },
  calibrate: {
    num: 2,
    title: "Calibrate your arms",
    sub: "Each arm is calibrated separately in 2 steps. Start with the leader arm.",
    action: "START CALIBRATING LEADER ARM",
    cmd: "pixi run calibrate-so100 leader",
    stopLabel: "STOP CALIBRATING",
  },
  teleop: {
    num: 3,
    title: "Verify teleop",
    sub: "Drive it around, check every joint tracks. This is the mode you'll record in.",
    action: "START LIVE TELEOPERATING",
    cmd: "pixi run teleop-so100",
    stopLabel: "STOP THE FEED",
  },
};

// Which "press Enter" button to show, per calibrate (arm, phase). The wiggle phase
// auto-advances (the tool detects which arm moved), so it gets no button.
function calibrateNextLabel(setup) {
  if (setup.phase === "middle") return "NEXT STEP";
  if (setup.phase === "sweep") return setup.arm === "leader" ? "NEXT ARM" : "FINISH";
  return null;
}

function initSetup(root) {
  const tool = root.dataset.setup;
  const step = SETUP_STEPS[tool];
  if (!step) return;

  const wrap = document.createElement("div");
  wrap.className = "setup";
  wrap.innerHTML = `
    <div class="setup-head">
      <div>
        <div class="setup-title">${step.num}. ${step.title}</div>
        <div class="setup-sub">${step.sub}</div>
      </div>
      <div class="setup-actions">
        <span class="setup-badge" hidden>&#10003; Calibrated</span>
        <button type="button" class="setup-next" hidden></button>
        <button type="button" class="setup-stop" hidden>${step.stopLabel}</button>
      </div>
    </div>
    <div class="setup-error" hidden></div>
    <div class="viewer-box">
      <div class="viewer-overlay">
        <button type="button" class="setup-action" disabled>${step.action}</button>
        <div class="overlay-cmd">or copy the command in your terminal&nbsp;<code>${step.cmd}</code>
          <button type="button" class="copy-btn" title="Copy command">Copy</button></div>
        <div class="setup-offline"><span class="spinner"></span> waiting for the local data server&hellip;
          <code>pixi run so100-server</code></div>
        <div class="setup-busy" hidden>the arms are connected on the Collect page &mdash; disconnect them there first</div>
      </div>
      <div class="viewer-loading" hidden><span class="spinner"></span> starting the feed&hellip;</div>
    </div>`;
  root.replaceWith(wrap);

  const el = (selector) => wrap.querySelector(selector);
  const actionBtn = el(".setup-action");
  const nextBtn = el(".setup-next");
  const stopBtn = el(".setup-stop");
  const badge = el(".setup-badge");
  const errorLine = el(".setup-error");
  const offlineLine = el(".setup-offline");
  const busyLine = el(".setup-busy");
  wireCopy(el(".copy-btn"), step.cmd);

  // This widget owns its viewer: booted (against the run's throwaway proxy) when its
  // tool starts, stopped when the tool ends. Only one setup tool runs at a time.
  const slot = viewerSlot(el(".viewer-box"));
  let wasRunning = false;
  let localError = ""; // from this widget's own requests (subprocess failures come via setup.error)

  function render(status) {
    const online = status !== null;
    const setup = (online && status.setup) || {};
    const mine = setup.tool === tool;
    const running = Boolean(setup.running && mine);
    const armsBusy = online && status.arms !== "disconnected";

    actionBtn.disabled = !online || Boolean(setup.running) || armsBusy;
    offlineLine.hidden = online;
    busyLine.hidden = !armsBusy;

    const nextLabel = running && tool === "calibrate" ? calibrateNextLabel(setup) : null;
    nextBtn.hidden = nextLabel === null;
    if (nextLabel !== null) nextBtn.textContent = nextLabel;
    stopBtn.hidden = !running;
    badge.hidden = !(tool === "calibrate" && !running && setup.calibrated?.leader && setup.calibrated?.follower);

    if (running) localError = "";
    const error = (mine && !running && setup.error) || localError;
    errorLine.textContent = error;
    errorLine.hidden = !error;

    if (running && !wasRunning && setup.proxy_port) {
      slot.show(`rerun+http://localhost:${setup.proxy_port}/proxy`);
    }
    if (!running && wasRunning) slot.hide();
    // Calibrate spawns a NEW recording for the follower stage (and every re-run is a
    // new recording) -- the viewer keeps showing the old one unless told.
    if (running) slot.want(setup.recording_id);
    wasRunning = running;
  }

  async function post(path, body) {
    try {
      const next = await api(path, body);
      if (next.error) localError = next.error;
      publishStatus(next);
    } catch (error) {
      localError = `request failed: ${error}`;
      publishStatus(null);
    }
  }

  actionBtn.addEventListener("click", () => {
    actionBtn.disabled = true;
    localError = "";
    post("/setup/start", { tool });
  });
  nextBtn.addEventListener("click", () => {
    nextBtn.hidden = true; // hide until the tool reports the next phase
    post("/setup/next", {});
  });
  stopBtn.addEventListener("click", () => post("/setup/stop", {}));

  subscribeStatus(render);
}

// ---- collect widget ---------------------------------------------------------------

// Two tabs, two modes:
//   Livestream -> just operate the robot live and watch what it sees. ONE continuous
//                 stream that stays on for the whole arms session (the proxy's memory
//                 limit flushes its oldest data, so nothing piles up). Recording never
//                 interrupts it: takes are written to disk invisibly and the viewer
//                 keeps showing this stream. Connecting/disconnecting the arms lives HERE.
//   Recording  -> operate the dataset recorder. A side panel shows ONE episode at a time:
//                 a fixed, server-assigned id (episode_01 .. episode_NN, never editable,
//                 never reused) plus its properties (task, tag). The ‹ › arrows browse
//                 the recorded episodes AND focus them in the viewer; switching
//                 recordings inside the viewer moves the panel too.
//
// Episode states, mirrored by the glyph next to the id:
//   (none)  -> the upcoming episode; properties are only a front-end draft until /start
//   red dot -> recording right now; "Save properties" stamps edits into the live take
//   green ✓ -> saved to the catalog; edits go through the "edits" layer on Save
function initCollect(root) {
  const wrap = document.createElement("div");
  wrap.className = "collect";
  wrap.innerHTML = `
    <div class="collect-tabs">
      <button type="button" class="collect-tab active" data-tab="live">Livestream</button>
      <button type="button" class="collect-tab" data-tab="record">Recording</button>
    </div>
    <div class="collect-body">
      <div class="collect-panel">
        <div class="panel-record">
          <label class="panel-field">Dataset
            <select name="dataset"></select></label>
          <label class="panel-field new-dataset" hidden>New dataset name
            <input type="text" name="new_dataset" placeholder="my_task"></label>
          <div class="episode-card">
            <div class="episode-nav">
              <button type="button" name="prev" aria-label="Previous episode" disabled>&lsaquo;</button>
              <span class="episode-id"><span class="episode-name">episode_01</span><span class="episode-glyph"></span></span>
              <button type="button" name="fwd" aria-label="Next episode" disabled>&rsaquo;</button>
            </div>
            <label class="panel-field">Task
              <textarea name="task" rows="3" placeholder="Pick up the ball and place it in the box"></textarea></label>
            <label class="panel-field">Tag
              <select name="tag">${TAGS.map((tag) => `<option>${tag}</option>`).join("")}</select></label>
            <button type="button" class="save-btn" name="save" hidden>Save properties</button>
            <div class="episode-note" hidden></div>
          </div>
          <div class="panel-buttons">
            <button type="button" class="collect-btn primary record-btn" name="record" disabled>
              <span class="rec-dot"></span><span class="btn-label">Start recording</span></button>
            <button type="button" class="collect-btn outline stop-btn" name="stoprec" disabled>
              <span class="stop-square"></span><span class="btn-label">Stop current recording</span></button>
          </div>
        </div>
        <div class="panel-live" hidden>
          <p class="live-sub">Operate the robot and watch what it sees in real time, without recording:
            the feed lives only in the viewer's memory (the <b>local</b> source) and nothing is stored.
            Pausing keeps the stream (and teleop) alive &mdash; resuming continues the same feed.</p>
          <button type="button" class="collect-btn outline" name="pausefeed" disabled>Pause the stream</button>
          <button type="button" class="collect-btn outline stop-btn" name="stopfeed" disabled>
            <span class="stop-square"></span>Stop the feed</button>
        </div>
        <div class="status-error" hidden></div>
      </div>
      <div class="viewer-box">
        <div class="viewer-overlay">
          <button type="button" class="setup-action" name="livestream" disabled hidden>START LIVESTREAM</button>
          <label class="fake-check" hidden><input type="checkbox" name="fake"> no arms plugged in (cameras only)</label>
          <div class="record-hint" hidden>no live feed &mdash;
            <button type="button" class="collect-link" name="golive">start it on the Livestream tab</button></div>
          <div class="setup-offline"><span class="spinner"></span> waiting for the local data server&hellip;
            <code>pixi run so100-server</code></div>
        </div>
        <div class="viewer-loading" hidden><span class="spinner"></span> starting the live view&hellip;</div>
      </div>
    </div>`;
  root.replaceWith(wrap);

  const el = (name) => wrap.querySelector(`[name="${name}"]`);
  const q = (selector) => wrap.querySelector(selector);
  const errorLine = q(".status-error");
  const note = q(".episode-note");
  const card = q(".episode-card");
  const epName = q(".episode-name");
  const glyph = q(".episode-glyph");
  const offlineLine = q(".setup-offline");

  // The viewer only exists while arms are connected: each session gets its own
  // throwaway proxy (state.proxy_port), so nothing from earlier sessions or other
  // pages is buffered -- no old episodes start playing on connect.
  const slot = viewerSlot(q(".viewer-box"));
  let shownPort = null; // proxy port the viewer is currently connected to

  let tab = "live";
  let online = false;
  let state = { arms: "disconnected", running: false, last: {} };
  let busy = false;

  let episodes = []; // saved episodes from GET /episodes, oldest -> newest
  let nextId = "episode_01"; // the id the NEXT recording will get (server-assigned)
  let selected = null; // stem of the episode the panel shows; null -> the active slot
  const drafts = new Map(); // stem -> {task, tag} unsaved edits (front-end only)
  let recordingBaseline = null; // last values saved for the in-progress take
  let savedFlash = null; // stem whose Save button shows the "saved" checkmark
  let noteText = null; // {stem, text} green confirmation inside the card
  let lastViewerId = null; // last viewer-side active recording (panel <- viewer sync)

  // The browsable list: every saved episode, then ONE active slot -- the take being
  // recorded right now, or the upcoming (not yet recorded) episode.
  function items() {
    const list = episodes.map((entry) => ({ ...entry, kind: "saved" }));
    if (state.running && state.last?.episode) {
      const stem = String(state.last.stem ?? state.last.episode);
      list.push({ stem, episode: String(state.last.episode), kind: "recording" });
    } else {
      list.push({ stem: nextId, episode: nextId, kind: "next" });
    }
    return list;
  }

  function current() {
    const list = items();
    return list.find((entry) => entry.stem === selected) ?? list[list.length - 1];
  }

  // The upcoming episode's draft is keyed by a STABLE key, not its (server-assigned,
  // still-changing) id -- so text typed before /episodes even resolves is never lost.
  const NEXT_KEY = "__next__";
  const draftKey = (item) => (item.kind === "next" ? NEXT_KEY : item.stem);

  // What the fields should show: unsaved draft > stored values > defaults (the upcoming
  // episode inherits the previous take's task -- same dataset, same task, usually).
  function draftFor(item) {
    const key = draftKey(item);
    if (drafts.has(key)) return drafts.get(key);
    if (item.kind === "saved") return { task: item.task ?? "", tag: item.tag || TAGS[0] };
    if (item.kind === "recording") return recordingBaseline ?? { task: "", tag: TAGS[0] };
    return { task: episodes.at(-1)?.task ?? "", tag: TAGS[0] };
  }

  function baselineFor(item) {
    if (item.kind === "saved") return { task: item.task ?? "", tag: item.tag || TAGS[0] };
    if (item.kind === "recording") return recordingBaseline;
    return null; // the upcoming episode has nothing to save yet
  }

  function currentDataset() {
    return el("dataset").value === NEW_DATASET ? el("new_dataset").value.trim() || "my_task" : el("dataset").value;
  }

  function showError(message) {
    errorLine.textContent = message ?? "";
    errorLine.hidden = !message;
  }

  // Never overwrite the field the user is typing in (unless the episode switched).
  function syncFields(force) {
    const draft = draftFor(current());
    const task = el("task");
    const tag = el("tag");
    if (force || document.activeElement !== task) task.value = draft.task;
    if (force || document.activeElement !== tag) {
      if (![...tag.options].some((option) => option.value === draft.tag)) tag.append(new Option(draft.tag));
      tag.value = draft.tag;
    }
  }

  function select(stem, { openViewer = true } = {}) {
    if (stem !== current().stem) {
      // A fresh episode card starts clean: no leftover "saved" flash or note.
      savedFlash = null;
      if (noteText?.stem !== stem) noteText = null;
    }
    selected = stem;
    card.classList.remove("slide-in");
    void card.offsetWidth; // restart the animation
    card.classList.add("slide-in");
    const item = current();
    if (openViewer && item.kind === "saved" && item.segment_id) {
      slot.focus(item.segment_id, item.viewer_url); // focus this episode in the viewer too
    }
    render();
    syncFields(true);
  }

  // If the user switches recordings inside the viewer: switching to the live stream
  // always resumes following mode; switching to an episode moves the panel onto it.
  function syncFromViewer() {
    const active = slot.active();
    if (!active || active === lastViewerId) return;
    lastViewerId = active;
    if (active === state.recording_id) {
      slot.want(state.recording_id); // re-point the slot in case it still wanted an episode
      slot.refollow();
      return;
    }
    if (tab !== "record" || state.running) return;
    const match = episodes.find((entry) => active === entry.segment_id || active.endsWith(`-${entry.stem}`));
    if (match && match.stem !== current().stem) select(match.stem, { openViewer: false });
  }

  function render() {
    const connected = online && state.arms !== "disconnected";
    const running = connected && Boolean(state.running);
    const item = current();
    const list = items();
    const index = list.findIndex((entry) => entry.stem === item.stem);

    // Tabs.
    for (const button of wrap.querySelectorAll(".collect-tab")) button.classList.toggle("active", button.dataset.tab === tab);
    q(".panel-record").hidden = tab !== "record";
    q(".panel-live").hidden = tab !== "live";

    // Viewer overlay (visible while no live session): per-tab content.
    el("livestream").hidden = tab !== "live";
    el("livestream").disabled = busy || !online;
    q(".fake-check").hidden = tab !== "live";
    q(".record-hint").hidden = tab !== "record" || !online;
    offlineLine.hidden = online;

    // Livestream tab. Pause drops frames server-side but keeps the same recording id,
    // so Resume continues the SAME stream; both are locked while a take is recording.
    el("pausefeed").disabled = busy || !connected || running;
    el("pausefeed").textContent = state.live_paused ? "Resume the stream" : "Pause the stream";
    el("stopfeed").disabled = busy || !connected || running;

    // Episode navigator.
    el("prev").disabled = index <= 0;
    el("fwd").disabled = index >= list.length - 1;
    epName.textContent = item.episode;
    glyph.className = `episode-glyph${item.kind === "saved" ? " saved" : ""}${item.kind === "recording" ? " rec" : ""}`;
    glyph.textContent = item.kind === "saved" ? "\u2713" : "";

    // Properties + explicit save (dirty-tracked against what the server has).
    const baseline = baselineFor(item);
    const draft = draftFor(item);
    const dirty = baseline !== null && (draft.task.trim() !== baseline.task.trim() || draft.tag !== baseline.tag);
    const save = el("save");
    const justSaved = !dirty && savedFlash === item.stem;
    // Only appears when there is something to save (or right after saving). The upcoming
    // episode never shows it: its draft rides along with /start.
    save.hidden = item.kind === "next" || (!dirty && !justSaved);
    save.disabled = busy || !online || !dirty;
    save.classList.toggle("saved", justSaved);
    save.textContent = justSaved ? "\u2713 Properties saved" : "Save properties";

    note.textContent = noteText?.stem === item.stem ? `\u2713 ${noteText.text}` : "";
    note.hidden = noteText?.stem !== item.stem;

    // The take's identity is fixed while recording.
    el("dataset").disabled = busy || running;
    el("new_dataset").disabled = busy || running;

    // Record / stop.
    const record = el("record");
    record.classList.toggle("recording", running);
    record.querySelector(".btn-label").textContent = running ? "Recording..." : episodes.length > 0 ? "Start new recording" : "Start recording";
    record.disabled = busy || !connected || running;
    el("stoprec").disabled = busy || !running;

    // The proxy lives as long as the arms session: the port only changes on
    // connect/disconnect, and the viewer reconnects from a clean slate when it does.
    const livePort = connected && state.proxy_port ? state.proxy_port : null;
    if (livePort !== shownPort) {
      if (shownPort !== null) slot.hide({ soft: livePort !== null });
      if (livePort !== null) slot.show(`rerun+http://localhost:${livePort}/proxy`);
      shownPort = livePort;
    }
    // The live tab and the active (recording/upcoming) slot follow the session's stream;
    // any switch TO the stream lands in following mode (head + play). Saved episodes
    // are opened via their catalog deep link in select() instead.
    if (livePort !== null && (tab === "live" || item.kind !== "saved")) slot.want(state.recording_id, { follow: true });
  }

  async function refreshDatasets() {
    let names = [];
    try {
      names = (await api("/datasets")).datasets ?? [];
    } catch {
      /* server briefly down; the poll will retry */
    }
    const select = el("dataset");
    const previous = select.value;
    select.innerHTML = "";
    for (const name of names) select.append(new Option(name));
    select.append(new Option("New dataset\u2026", NEW_DATASET));
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
    if (names.length === 0) select.value = NEW_DATASET;
    q(".new-dataset").hidden = select.value !== NEW_DATASET;
  }

  async function refreshEpisodes() {
    try {
      const data = await api(`/episodes?dataset=${encodeURIComponent(currentDataset())}`);
      if (Array.isArray(data.episodes)) {
        episodes = data.episodes;
        nextId = data.next || nextId;
      }
    } catch {
      /* server briefly down; the poll will retry */
    }
    render();
    syncFields(false);
  }

  async function call(path, body) {
    busy = true;
    render();
    showError();
    try {
      const next = await api(path, body);
      if (next.error) showError(next.error);
      if (next.arms !== undefined) state = next;
      return next;
    } catch (error) {
      showError(`request failed: ${error}`);
      return null;
    } finally {
      busy = false;
      render();
    }
  }

  // --- events ---------------------------------------------------------------

  for (const button of wrap.querySelectorAll(".collect-tab")) {
    button.addEventListener("click", () => {
      tab = button.dataset.tab;
      // Going to the stream always (re-)enters following mode, even if the viewer was
      // already on it (the user may have scrubbed back in time).
      if (tab === "live" && state.recording_id) {
        slot.want(state.recording_id);
        slot.refollow();
      }
      // Entering the Recording tab: adopt whatever the viewer is showing -- if it's a
      // catalog episode, the panel lands on it; only a not-yet-recorded live stream
      // keeps the panel on the upcoming slot.
      if (tab === "record" && !state.running) {
        const active = slot.active();
        const match = active && episodes.find((entry) => active === entry.segment_id || active.endsWith(`-${entry.stem}`));
        lastViewerId = active;
        if (match) {
          select(match.stem, { openViewer: false });
          return; // select() already rendered
        }
        selected = null;
      }
      render();
      syncFields(true);
    });
  }
  el("golive").addEventListener("click", () => {
    tab = "live";
    if (state.recording_id) {
      slot.want(state.recording_id);
      slot.refollow();
    }
    render();
  });

  el("dataset").addEventListener("change", () => {
    q(".new-dataset").hidden = el("dataset").value !== NEW_DATASET;
    drafts.clear();
    selected = null;
    savedFlash = null;
    noteText = null;
    refreshEpisodes();
  });
  el("new_dataset").addEventListener("change", refreshEpisodes);

  function onEdit() {
    const item = current();
    drafts.set(draftKey(item), { task: el("task").value, tag: el("tag").value });
    if (savedFlash === item.stem) savedFlash = null;
    if (noteText?.stem === item.stem) noteText = null;
    render();
  }
  el("task").addEventListener("input", onEdit);
  el("tag").addEventListener("change", onEdit);

  el("prev").addEventListener("click", () => {
    const list = items();
    const index = list.findIndex((entry) => entry.stem === current().stem);
    if (index > 0) select(list[index - 1].stem);
  });
  el("fwd").addEventListener("click", () => {
    const list = items();
    const index = list.findIndex((entry) => entry.stem === current().stem);
    if (index < list.length - 1) select(list[index + 1].stem);
  });

  el("save").addEventListener("click", async () => {
    const item = current();
    if (item.kind === "next") return;
    const draft = draftFor(item);
    const payload = { dataset: currentDataset(), episode: item.stem, task: draft.task.trim(), tag: draft.tag };
    const next = await call("/episode/update", payload);
    if (!next || next.error) return;
    if (item.kind === "recording") {
      recordingBaseline = { task: payload.task, tag: payload.tag };
    } else {
      const entry = episodes.find((episode) => episode.stem === item.stem);
      if (entry) Object.assign(entry, { task: payload.task, tag: payload.tag });
    }
    drafts.delete(draftKey(item));
    savedFlash = item.stem; // the button itself becomes the confirmation
    render();
    syncFields(true);
  });

  el("record").addEventListener("click", async () => {
    // Always records the UPCOMING episode (its id comes back from the server). The
    // properties drafted before recording become the take's: task via /start, tag via
    // the baseline (stamped on /stop).
    const upcoming = items().at(-1);
    const draft = draftFor(upcoming);
    const next = await call("/start", { dataset: currentDataset(), task: draft.task.trim() });
    if (!next || next.error || !next.running) return;
    const stem = String(next.last?.stem ?? next.last?.episode ?? upcoming.stem);
    recordingBaseline = { task: draft.task.trim(), tag: draft.tag };
    drafts.delete(NEXT_KEY);
    savedFlash = null;
    noteText = null;
    await refreshDatasets(); // a brand-new dataset name becomes selectable
    select(stem); // slide the card to the fresh take (red dot)
    // Back to the stream, in following mode -- even if the viewer was already on it
    // (a fresh take should always be seen from its head).
    if (next.recording_id) {
      slot.want(next.recording_id);
      slot.refollow();
    }
  });

  el("stoprec").addEventListener("click", async () => {
    const take = items().at(-1);
    const draft = draftFor(take);
    el("stoprec").querySelector(".btn-label").textContent = "Stopping\u2026";
    const next = await call("/stop", { tag: draft.tag });
    el("stoprec").querySelector(".btn-label").textContent = "Stop current recording";
    if (!next || next.error) return;
    if (next.last?.status === "register_failed") showError(String(next.last.error ?? "registration failed"));
    const stem = String(next.last?.stem ?? take.stem);
    recordingBaseline = null;
    await refreshEpisodes(); // the fresh take shows up as a saved episode
    noteText = { stem, text: "recording has been saved to the catalog" };
    savedFlash = null;
    // The take was written to disk invisibly (the viewer stayed on the live stream),
    // so review the registered episode straight from the catalog.
    select(stem);
  });

  el("livestream").addEventListener("click", () => call("/arms/connect", { fake: el("fake").checked }));
  el("pausefeed").addEventListener("click", async () => {
    const paused = Boolean(state.live_paused);
    const next = await call(paused ? "/live/resume" : "/live/pause", {});
    // Resuming continues the same recording after a gap -- jump to the new head.
    if (paused && next && !next.error && next.recording_id) {
      slot.want(next.recording_id);
      slot.refollow();
    }
  });
  el("stopfeed").addEventListener("click", () => call("/arms/disconnect", {}));

  async function onStatus(status) {
    const wasOnline = online;
    online = status !== null;
    if (status !== null) state = status;
    if (online && !wasOnline) {
      await refreshDatasets();
      await refreshEpisodes();
    }
    syncFromViewer();
    render();
    syncFields(false);
  }

  subscribeStatus(onStatus);
}

// ---- boot --------------------------------------------------------------------------

document.querySelectorAll("[data-viewer]").forEach(initViewer);
document.querySelectorAll("[data-collect]").forEach(initCollect);
document.querySelectorAll("[data-setup]").forEach(initSetup);
