# Upstream Rerun wishlist

Friction we hit building this course on Rerun 0.34.1 that can only be fixed (or fixed
properly) in Rerun itself. Each item: what happens today, what we want, and where the
workaround lives in this repo.

## 1. Default sorting of a dataset's segment table

Today the viewer's dataset view lists segments in arbitrary order: the catalog server
iterates a plain `HashMap` (`re_server/src/store/dataset.rs::segment_table`), the
`ScanSegmentTable` response has no defined order, and the viewer applies no default sort
(`re_dataframe_ui::TableBlueprint.sort_by` defaults to `None`). Clicking a column header
sorts for the session only, and nothing external — JS API, deep link, blueprint — can set
a default.

Wanted: segments sorted by date/time added, newest first, by default (or at least a way
for the embedding page to set the sort).

## 2. Latest-wins for recording properties, per component

The catalog resolves conflicting `send_property` stamps per *chunk*: a later stamp with
FEWER columns loses to an earlier, wider one (verified on 0.33 — a tag-only stamp never
overrides a tag sent earlier together with task). Workaround: always re-send the full
property set so every chunk has the same shape (`takes.py::stamp_properties`).

Wanted: plain per-component latest-wins, regardless of what else was in the chunk.

## 3. Web-viewer JS API gaps (embedded viewers)

- No way to close/remove a loaded recording from memory. We spawn a throwaway gRPC proxy
  per arms session and reboot the viewer just to get a clean slate
  (`tools/apps/so100_server.py::Recorder.connect_arms`).
- `set_active_recording_id` fails until the recording has arrived, with no way to await
  it — so every switch is a 250 ms retry loop with a deadline (`viewerSlot.keepTrying`).
  A "switch when it arrives" API (or a promise) would remove all of that.

## 4. `rr.serve_grpc()` adds a ghost recording

The SDK's in-process proxy attaches an empty recording that shows up in every connecting
viewer. We shell out to the `rerun --serve-grpc` binary instead — with a wrapper process
to keep it from orphaning (`tools/apps/so100_server.py::spawn_proxy`).

Wanted: a pure in-process proxy server with no implicit recording.

## 5. Embedded canvas behavior

- The viewer autofocuses its `<canvas>`, and `focus()` scrolls it into view — yanking the
  host page on boot and when leaving fullscreen. We monkey-patch `canvas.focus` to pass
  `preventScroll` (`web/static/app.js::preventFocusScroll`).
- Exiting fullscreen wipes inline styles with `removeAttribute("style")`: passing
  `width`/`height` to `WebViewer.start` then leaves an unsized canvas and a WASM panic.
  We must pass `""` and size via CSS only.

## 6. Stop-to-registered latency. Thoughts?

Registering a freshly written `.rrd` at a usable size requires an offline
`rerun rrd optimize` pass first; together with registration this takes long enough that
our `/stop` needs a 120 s request timeout and a "Stopping…" spinner. Wanted: register
unoptimized files without the query-performance penalty, or compaction that happens
server-side / in the background after registration.
