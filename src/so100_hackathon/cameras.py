"""Webcam capture threads that stream H.264 video into Rerun.

Python equivalent of rerun-io/portugal ``src/camera.rs`` (one thread per
camera, wall-clock timestamps), using OpenCV instead of nokhwa. Frames are
encoded to an H.264 ``rr.VideoStream`` (far smaller than per-frame JPEG);
pass ``encoder=None`` for the old JPEG path.
"""

from __future__ import annotations

import threading
import time
from fractions import Fraction

import av
import cv2
import rerun as rr

# The Mac's internal webcam is never a recording camera on this rig. The device type is
# authoritative ("...BuiltIn..." on macOS); names are a fallback for older reporting.
BUILTIN_NAME_HINTS = ("facetime", "built-in", "macbook")

DEFAULT_VIDEO_ENCODER = "libx264"

# rr.VideoStream cannot decode B-frames (rerun#10090) -> every encoder must run with
# max_b_frames=0, and libx264 additionally needs zerolatency to emit 1 packet per frame
# immediately (these are the official rerun camera_video_stream example's settings).
# h264_videotoolbox (Apple hardware, near-zero CPU) honors max_b_frames but still
# pipelines ~4 frames of latency even with realtime mode.
_ENCODER_OPTIONS: dict[str, dict[str, str]] = {
    "libx264": {"tune": "zerolatency", "preset": "veryfast"},
    "h264_videotoolbox": {"realtime": "1", "prio_speed": "1"},
}


def _cameras_in_opencv_order() -> list[tuple[str, bool]] | None:
    """(name, is_builtin) per camera, in OpenCV's index order. None if unavailable.

    OpenCV's AVFoundation backend (cap_avfoundation_mac.mm, checked at the installed
    version) enumerates devicesWithMediaType Video + Muxed and then SORTS BY uniqueID —
    replicate exactly that. Naive orderings mis-map: system_profiler, the raw
    devicesWithMediaType list, and discovery sessions all put the built-in first on this
    rig, while the uniqueID sort puts it last (USB uniqueIDs are "0x..." hex strings,
    which sort before the built-in's UUID).
    """
    try:
        import AVFoundation as av
    except ImportError:
        return None
    # pyobjc loads ObjC names lazily; pyrefly can't see them.
    devices = list(av.AVCaptureDevice.devicesWithMediaType_(av.AVMediaTypeVideo))  # pyrefly: ignore[missing-attribute]
    devices += list(av.AVCaptureDevice.devicesWithMediaType_(av.AVMediaTypeMuxed))  # pyrefly: ignore[missing-attribute]
    devices.sort(key=lambda device: str(device.uniqueID()))
    cameras: list[tuple[str, bool]] = []
    for device in devices:
        name = str(device.localizedName())
        builtin = "BuiltIn" in str(device.deviceType()) or any(hint in name.lower() for hint in BUILTIN_NAME_HINTS)
        cameras.append((name, builtin))
    return cameras


def detect_camera_indices(max_index: int = 4, *, include_builtin: bool = False) -> tuple[int, ...]:
    """Probe AVFoundation indices and return the ones that deliver frames, skipping the
    Mac's built-in webcam. Pass ``include_builtin=True`` (or ``--cameras`` explicitly) to
    keep it."""
    found: list[int] = []
    for index in range(max_index + 1):
        cap = cv2.VideoCapture(index)
        ok = cap.isOpened() and cap.read()[0]
        cap.release()
        if ok:
            found.append(index)

    cameras = _cameras_in_opencv_order()
    if cameras is None or include_builtin:
        return tuple(found)
    kept: list[int] = []
    for index in found:
        name, builtin = cameras[index] if index < len(cameras) else ("?", False)
        if builtin:
            print(f"camera {index} ({name}): built-in, skipping — pass --cameras {index} to use it anyway", flush=True)
        else:
            kept.append(index)
    return tuple(kept)


class H264Encoder:
    """PyAV H.264 encoder producing what ``rr.VideoStream`` requires: Annex B packets,
    in-band SPS on keyframes (both verified for the encoders above), no B-frames."""

    def __init__(self, name: str, width: int, height: int, fps: float) -> None:
        rate = max(1, round(fps))
        ctx = av.CodecContext.create(name, "w")
        assert isinstance(ctx, av.VideoCodecContext), f"{name!r} is not a video encoder"
        ctx.width = width - width % 2  # 4:2:0 subsampling needs even dimensions
        ctx.height = height - height % 2
        ctx.pix_fmt = "yuv420p"
        ctx.time_base = Fraction(1, rate)
        ctx.framerate = Fraction(rate, 1)
        ctx.max_b_frames = 0
        ctx.gop_size = 2 * rate  # a keyframe every ~2s keeps viewer seeks cheap
        ctx.options = _ENCODER_OPTIONS.get(name, {})
        self._ctx = ctx
        self._pts = 0
        # The encoder may hold frames in flight (videotoolbox pipelines ~4); remember each
        # frame's wall-clock capture time by PTS so packets are logged at the right time.
        self._capture_times: dict[int, float] = {}

    def encode(self, frame_bgr, capture_time: float) -> list[tuple[float, bytes, bool]]:
        """Encode one BGR frame -> [(capture_time, annex_b_bytes, is_keyframe)] packets ready to emit."""
        frame = av.VideoFrame.from_ndarray(frame_bgr[: self._ctx.height, : self._ctx.width], format="bgr24")
        frame = frame.reformat(format="yuv420p")
        frame.pts = self._pts
        frame.time_base = self._ctx.time_base
        self._capture_times[self._pts] = capture_time
        self._pts += 1
        return self._collect(self._ctx.encode(frame))

    def flush(self) -> list[tuple[float, bytes, bool]]:
        """Drain in-flight packets. The encoder is spent afterwards — make a new one."""
        try:
            return self._collect(self._ctx.encode(None))
        except av.FFmpegError:  # e.g. flushing an encoder that never saw a frame
            return []

    def _collect(self, packets: list[av.Packet]) -> list[tuple[float, bytes, bool]]:
        out = []
        for packet in packets:
            capture_time = None if packet.pts is None else self._capture_times.pop(packet.pts, None)
            if capture_time is not None:
                out.append((capture_time, bytes(packet), bool(packet.is_keyframe)))
        return out


class CameraStreamer:
    """Capture one camera on a daemon thread and log frames under ``camera/cam<index>``."""

    def __init__(
        self,
        index: int,
        *,
        rec: rr.RecordingStream,
        timeline: str = "time",
        encoder: str | None = DEFAULT_VIDEO_ENCODER,
        jpeg_quality: int = 75,
    ) -> None:
        self.index = index
        self.rec = rec
        """Recording to log into; reassign to redirect this thread's frames (the collector swaps takes)."""
        self.timeline = timeline
        self.encoder = encoder
        """H.264 encoder name for rr.VideoStream frames; None logs per-frame JPEG instead."""
        self.jpeg_quality = jpeg_quality
        self.entity_path = f"camera/cam{index}"
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f"camera-{index}", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _open_encoder(self, width: int, height: int, fps: float) -> H264Encoder | None:
        if self.encoder is None:
            return None
        try:
            return H264Encoder(self.encoder, width, height, fps)
        except Exception as error:
            print(f"camera {self.index}: H.264 encoder {self.encoder!r} unavailable ({error}); logging JPEG instead", flush=True)
            self.encoder = None
            return None

    def _log_packets(self, rec: rr.RecordingStream, packets: list[tuple[float, bytes, bool]]) -> None:
        for capture_time, sample, is_keyframe in packets:
            # set_time is thread-local, so this timeline value only affects this thread's logs.
            rec.set_time(self.timeline, timestamp=capture_time)
            rec.log(self.entity_path, rr.VideoStream.from_fields(sample=sample, is_keyframe=is_keyframe))

    def _run(self) -> None:
        cap = cv2.VideoCapture(self.index)
        if not cap.isOpened():
            print(f"camera {self.index}: failed to open, skipping", flush=True)
            return
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        encoder = self._open_encoder(width, height, fps)
        mode = f"H.264 ({self.encoder})" if encoder is not None else "JPEG"
        print(f"camera {self.index}: streaming {width}x{height} {mode} -> {self.entity_path}", flush=True)
        last_rec: rr.RecordingStream | None = None
        try:
            while not self._stop.is_set():
                ok, frame_bgr = cap.read()
                if not ok:
                    time.sleep(0.1)
                    continue
                capture_time = time.time()
                rec = self.rec  # snapshot: the collector may swap it between frames
                if rec is not last_rec:
                    if last_rec is not None and encoder is not None:
                        # Take swap: drain in-flight frames into the old recording, then start a
                        # fresh encoder so the new recording begins with SPS + a keyframe.
                        self._log_packets(last_rec, encoder.flush())
                        encoder = self._open_encoder(width, height, fps)
                    if encoder is not None:
                        # A video stream's codec must be declared in every recording it lands in.
                        rec.log(self.entity_path, rr.VideoStream(codec=rr.VideoCodec.H264), static=True)
                    last_rec = rec
                if encoder is not None:
                    self._log_packets(rec, encoder.encode(frame_bgr, capture_time))
                else:
                    rec.set_time(self.timeline, timestamp=capture_time)
                    frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
                    rec.log(self.entity_path, rr.Image(frame_rgb).compress(jpeg_quality=self.jpeg_quality))
        except Exception as error:  # a crashed feed must be visible, not a silent thread death
            print(f"camera {self.index}: streaming stopped: {error}", flush=True)
        finally:
            if encoder is not None and last_rec is not None:
                self._log_packets(last_rec, encoder.flush())
            cap.release()
