"""Reference MolmoAct2 inference server for deploy_policy.py.

Runs on the GPU box (NOT in a pixi environment -- it needs torch + a CUDA card)::

    pip install torch transformers pillow numpy
    python policy_server_molmoact2.py --checkpoint <your-hf-user>/molmoact2_my_task --port 8080

Serves the tiny JSON contract deploy_policy.py speaks: POST /act with
``{"instruction", "state", "images": {name: <base64 jpeg>}}``, returns
``{"actions": [[...], ...]}`` -- one absolute-joint-pose chunk per request.

The model call is the Hugging Face ``predict_action`` API; if your checkpoint's model
card documents different arguments (e.g. a different ``norm_tag``), adjust here -- see
https://github.com/allenai/molmoact2/tree/main/examples for the upstream servers this
mirrors. For the public ``allenai/MolmoAct2-SO100_101`` checkpoint remember the joint
convention caveat in deploy_policy.py's docstring.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def load_model(checkpoint: str, device: str):
    import torch  # pyrefly: ignore[missing-import] - GPU box only, not a pixi env
    from transformers import AutoModelForImageTextToText, AutoProcessor  # pyrefly: ignore[missing-import] - GPU box only

    print(f"loading {checkpoint} on {device} (bf16) ...")
    processor = AutoProcessor.from_pretrained(checkpoint, trust_remote_code=True, torch_dtype=torch.bfloat16)
    model = AutoModelForImageTextToText.from_pretrained(checkpoint, trust_remote_code=True, torch_dtype=torch.bfloat16).to(device).eval()
    print("model ready")
    return processor, model


def make_handler(processor, model, norm_tag: str, num_steps: int):
    import numpy as np
    import torch  # pyrefly: ignore[missing-import] - GPU box only, not a pixi env
    from PIL import Image  # pyrefly: ignore[missing-import] - GPU box only

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - http.server API
            try:
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                images = [Image.open(io.BytesIO(base64.b64decode(data))).convert("RGB") for data in payload["images"].values()]
                state = np.asarray(payload["state"], dtype=np.float32)
                with torch.inference_mode():
                    actions = model.predict_action(
                        processor=processor,
                        images=images,
                        task=payload["instruction"],
                        state=state,
                        norm_tag=norm_tag,
                        inference_action_mode="continuous",
                        num_steps=num_steps,
                    )
                body = json.dumps({"actions": np.asarray(actions, dtype=np.float32).tolist()}).encode()
                self.send_response(200)
            except Exception as error:  # surface the failure to the client instead of a hung arm loop
                body = json.dumps({"error": f"{type(error).__name__}: {error}"}).encode()
                self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", default="allenai/MolmoAct2-SO100_101", help="HF repo id or local path of the fine-tuned checkpoint")
    parser.add_argument("--norm-tag", default="so100_so101_molmoact2", help="normalization tag the checkpoint was trained with")
    parser.add_argument("--num-steps", type=int, default=10, help="action-chunk horizon to predict")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()

    processor, model = load_model(args.checkpoint, args.device)
    server = ThreadingHTTPServer(("0.0.0.0", args.port), make_handler(processor, model, args.norm_tag, args.num_steps))
    print(f"serving /act on port {args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
