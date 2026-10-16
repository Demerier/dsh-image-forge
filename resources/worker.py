"""dsh-image-forge local worker — Qwen-Image 2.1 (bnb-4bit, diffusers) over HTTP.

This file ships inside the plugin as a resource and is started by
``src/worker.ts``. It is never started by hand in normal use, which is why every
path (models dir, data dir, port) arrives on the command line.

Frozen HTTP contract (the plugin side, ``src/local.ts``, is the authority):
    GET  {endpoint}/health   -> any 2xx means the model is loaded and serving
    POST {endpoint}/generate -> { prompt, width, height, count, steps?, seed?, transparent?, images?, reference_budget? }
                             -> { "images": [ "<base64 png>", ... ] }
    ``images`` is optional: a list of at most 10 base64 (or ``data:`` URI) reference images, in
    prompt order (the prompt contract labels them ``<image1>``...``<imageN>``). Omitting it is exactly
    the text-to-image request this worker has always served, so the field is additive on both sides;
    the response shape does not change. The plugin resolves ``ratio_follow`` into width/height before
    the call (that is the existing division of labour: the worker never picks the canvas).
    ``reference_budget`` is optional too: an explicit conditioning budget in pixels per side, sent
    only when the plugin's ``localReferenceBudget`` config is set. Omitting it means "derive the
    budget from the canvas" -- the only behaviour that existed before this field -- and it never
    changes the output size, only the resolution the references are conditioned at.
Two endpoints are additive and are what the plugin's lifecycle manager uses:
    GET  {endpoint}/state    -> 200 whenever the process lives (even while loading)
    POST {endpoint}/unload   -> drop the model, free VRAM (idle reclaim)

Memory design (measured on the reference box: 8 GiB VRAM / 31 GiB RAM):
  * text encoder  stays on CPU (bnb-4bit, 5.8 GiB) -> never competes with the transformer for VRAM
  * transformer   is placed on cuda:0 by bitsandbytes (4.4 GiB)
  * VAE           is on cuda:0 with tiling ALWAYS ENABLED (without it, 2K peaks at
                  17041 MiB reserved and OOMs; there is deliberately no flag to turn it off)
  * prompt embeddings must be moved to the transformer's device by hand -- the diffusers
    QwenImage21Pipeline does not relocate caller-supplied embeds.
  * this holds for the edit path too, and there `encode_prompt` also has to be called by hand:
    ``pipe(prompt=..., image=...)`` encodes on the *execution* device (cuda:0) while the text
    encoder lives on the CPU, which raises "Expected all tensors to be on the same device".
    Measured on this box with two references at 512x288 / 4 steps: 6414 MiB peak reserved.

If the model cannot be loaded the traceback goes to stderr and the process exits
non-zero. The plugin reads that stderr back to the user, so silence is never an
option here.
"""
import argparse
import base64
import gc
import io
import json
import math
import os
import sys
import threading
import time
import traceback

# Offline by default: the weights are already on disk, and a hub lookup only
# stalls (huggingface.co times out on /api/; hf-mirror.com is the mirror that
# answers). Set before importing diffusers/transformers, which read them at import.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

try:  # a piped console on Windows defaults to cp936 and mangles the logs
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    sys.stderr.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
except Exception:  # pragma: no cover - only when stdout has no reconfigure
    pass

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402

SERVICE = "dsh-image-forge-worker"
VERSION = "0.2.0"

STATE = {
    "pipe": None,
    "ready": False,
    "loading": False,
    "load_error": None,
    "load_seconds": None,
    "generations": 0,
    "unloaded_at": None,
    "models_dir": None,
    "data_dir": None,
    "started_at": time.time(),
}

# Serialises load/unload. `/generate` also takes it through `ensure_loaded()`, so a
# request that arrives during a load waits for that load instead of starting a second.
_load_lock = threading.Lock()
# Serialises generation itself: one canvas at a time, VRAM is the scarce resource.
_gen_lock = threading.Lock()


def log(*parts):
    print(f"[{time.strftime('%H:%M:%S')}]", *parts, flush=True)


def _mem():
    """RSS and VRAM as MiB, or None where the reading is not available yet."""
    out = {"rss_MiB": None, "vram_allocated_MiB": None, "vram_reserved_MiB": None}
    try:
        import psutil

        out["rss_MiB"] = round(psutil.Process().memory_info().rss / 2**20, 1)
    except Exception:
        pass
    try:
        import torch

        if torch.cuda.is_available():
            out["vram_allocated_MiB"] = round(torch.cuda.memory_allocated() / 2**20, 1)
            out["vram_reserved_MiB"] = round(torch.cuda.memory_reserved() / 2**20, 1)
    except Exception:
        pass
    return out


def write_state_file():
    """Leave a breadcrumb so a *later* plugin session can find and reclaim this worker."""
    data_dir = STATE["data_dir"]
    if not data_dir:
        return
    try:
        os.makedirs(data_dir, exist_ok=True)
        payload = {
            "service": SERVICE,
            "version": VERSION,
            "pid": os.getpid(),
            "port": STATE.get("port"),
            "models_dir": STATE["models_dir"],
            "started_at": STATE["started_at"],
            "ready": STATE["ready"],
        }
        path = os.path.join(data_dir, "worker-state.json")
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        os.replace(tmp, path)
    except Exception as error:  # a breadcrumb must never take the worker down
        log("could not write worker-state.json:", error)


def load_pipeline(models_dir, vae_device="cuda"):
    """Load transformer + VAE (bnb-4bit) and attach a CPU-placed text encoder."""
    import torch
    from diffusers import QwenImage21Pipeline
    from transformers import Qwen3VLForConditionalGeneration

    started = time.time()
    # Loading the pipeline the default way puts the 5.8 GiB text encoder on the GPU
    # too (10895 MiB allocated on an 8 GiB card). Load without it, then attach one
    # pinned to CPU.
    pipe = QwenImage21Pipeline.from_pretrained(models_dir, text_encoder=None, torch_dtype=torch.bfloat16)
    pipe.text_encoder = Qwen3VLForConditionalGeneration.from_pretrained(
        os.path.join(models_dir, "text_encoder"), dtype=torch.bfloat16, device_map="cpu"
    )
    if vae_device == "cuda":
        pipe.vae.to("cuda")
    # Mandatory, not a knob: at 2K the untiled VAE peaks at 17041 MiB and OOMs an 8 GiB card.
    if not hasattr(pipe.vae, "enable_tiling"):
        raise RuntimeError("this diffusers build cannot tile the VAE; 2K generation would OOM")
    pipe.vae.enable_tiling()
    STATE["load_seconds"] = time.time() - started
    return pipe


def ensure_loaded():
    """Load the model if it is not in memory. Raises the original load error."""
    if STATE["ready"]:
        return
    with _load_lock:
        if STATE["ready"]:
            return
        if STATE["load_error"] is not None:
            raise RuntimeError(f"model failed to load earlier: {STATE['load_error']}")
        STATE["loading"] = True
        try:
            log(f"loading pipeline from {STATE['models_dir']}")
            STATE["pipe"] = load_pipeline(STATE["models_dir"])
            STATE["ready"] = True
            STATE["load_error"] = None
            memory = _mem()
            log(
                f"pipeline ready in {STATE['load_seconds']:.1f}s | "
                f"rss={memory['rss_MiB']} MiB | vram allocated={memory['vram_allocated_MiB']} MiB"
            )
            write_state_file()
        except Exception as error:
            STATE["load_error"] = f"{type(error).__name__}: {error}"
            raise
        finally:
            STATE["loading"] = False


def _shutdown():
    """Free the model, then leave — the plugin's `stop()` waits for this exit."""
    try:
        unload_model()
    except Exception:
        pass
    log("exiting on request")
    os._exit(0)


def unload_model():
    """Drop the model and hand the VRAM back. The process stays up and can reload."""
    with _load_lock:
        before = _mem()
        pipe, STATE["pipe"] = STATE["pipe"], None
        STATE["ready"] = False
        STATE["unloaded_at"] = time.time()
        del pipe
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.synchronize()
        except Exception:
            pass
    after = _mem()
    log(f"unloaded: vram allocated {before['vram_allocated_MiB']} -> {after['vram_allocated_MiB']} MiB")
    write_state_file()
    return {"unloaded": True, "before": before, "after": after}


def generate(prompt, width, height, steps, seed, transparent, images=None, reference_budget=None):
    """One image. Caller holds `_gen_lock`. `images` is empty for text-to-image.

    `reference_budget` is the optional explicit conditioning budget (pixels per side)
    the plugin sends when the user configured `localReferenceBudget`; `None` means
    "derive it from the canvas with `_reference_budget`", which is the default path
    and the only one that existed before the field did. It changes the reference
    conditioning resolution only -- never the output size, which is `width`/`height`.

    Returns `(base64, elapsed, mode, size, stages)`. `stages` is where the wall
    clock actually went. It exists because `elapsed` alone hid the two costs that
    dominate an edit on this box: the text/vision encode runs on the **CPU** (the
    encoder cannot share the 8 GiB card with the transformer), and the denoise loop
    attends over the condition latents *and* the target latents, so it is several
    times a text-to-image step. Without the split, a 260 s edit looks like one
    unexplained number.
    """
    import torch

    pipe = STATE["pipe"]
    generator = torch.Generator("cpu").manual_seed(seed)
    stages = {}
    restore = None
    stages["decode_reference"] = 0.0
    # One resolution for the whole job: `_prepare_conditions` and `pipe(...)` both
    # consume it, and they disagreeing is exactly the bug this value prevents.
    budget = reference_budget if reference_budget is not None else _reference_budget(width, height)
    if images:
        # Encode on CPU exactly as the text-to-image path does, but with the condition
        # images: the text encoder has to see the same pixels the VAE will, so the
        # references are resized here with the pipeline's own rule.
        started = time.time()
        prepared = _prepare_conditions(pipe, images, budget)
        stages["prepare_conditions"] = round(time.time() - started, 2)
        stages["reference_budget"] = budget
        stages["reference_budget_source"] = "request" if reference_budget is not None else "canvas"
        stages["condition_pixels"] = [list(prepared[0].size)] if prepared else []
        started = time.time()
        prompt_embeds, prompt_embeds_mask, image_pad_mask = pipe.encode_prompt(
            prompt=prompt, image=prepared, device=torch.device("cpu"), num_images_per_prompt=1
        )
        # The CPU encoder forward is the whole cost here; the processor is noise.
        stages["encode_prompt_cpu"] = round(time.time() - started, 2)
        stages["prompt_tokens"] = int(prompt_embeds.shape[1])
        stages["image_tokens"] = int(image_pad_mask.sum().item())
        started = time.time()
        prompt_embeds = prompt_embeds.to("cuda")
        if prompt_embeds_mask is not None:
            prompt_embeds_mask = prompt_embeds_mask.to("cuda")
        stages["embeds_to_cuda"] = round(time.time() - started, 2)
        # `__call__` has no `image_pad_mask` parameter, but `encode_prompt` requires one
        # once embeddings and condition images are supplied together; relay it for this call.
        restore = _relay_image_pad_mask(pipe, image_pad_mask.to("cuda"))
    else:
        # Encode on CPU, then hand the embeddings to the transformer's device by hand:
        # QwenImage21Pipeline does not move caller-supplied embeds (it fails with
        # "Expected all tensors to be on the same device ... cuda:0 and cpu").
        started = time.time()
        prompt_embeds, prompt_embeds_mask, _ = pipe.encode_prompt(
            prompt=prompt, device=torch.device("cpu"), num_images_per_prompt=1
        )
        stages["encode_prompt_cpu"] = round(time.time() - started, 2)
        stages["prompt_tokens"] = int(prompt_embeds.shape[1])
        started = time.time()
        prompt_embeds = prompt_embeds.to("cuda")
        if prompt_embeds_mask is not None:
            prompt_embeds_mask = prompt_embeds_mask.to("cuda")
        stages["embeds_to_cuda"] = round(time.time() - started, 2)
    kwargs = {
        "prompt_embeds": prompt_embeds,
        "prompt_embeds_mask": prompt_embeds_mask,
        "width": width,
        "height": height,
        "num_inference_steps": steps,
        "generator": generator,
        "output_type": "pil",
    }
    if images:
        kwargs.update(image=images, output_resolution=budget)
    torch.cuda.reset_peak_memory_stats()
    stop_vae_timer = _time_vae(pipe)
    started = time.time()
    try:
        result = pipe(**kwargs)
    finally:
        vae_seconds = stop_vae_timer()
        stages["vae_encode_conditions"] = vae_seconds["encode"]
        stages["vae_decode"] = vae_seconds["decode"]
        if restore is not None:
            pipe.encode_prompt = restore
    stages["pipeline_call"] = round(time.time() - started, 2)
    stages["denoise"] = round(
        stages["pipeline_call"] - stages["vae_encode_conditions"] - stages["vae_decode"], 2
    )
    stages["peak_vram_allocated_MiB"] = round(torch.cuda.max_memory_allocated() / 2**20, 1)
    stages["peak_vram_reserved_MiB"] = round(torch.cuda.max_memory_reserved() / 2**20, 1)
    image = result.images[0]
    elapsed = time.time() - started
    if not transparent and image.mode != "RGB":
        image = image.convert("RGB")
    started = time.time()
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    stages["png_and_base64"] = round(time.time() - started, 2)
    stages["png_bytes"] = len(buffer.getvalue())
    return base64.b64encode(buffer.getvalue()).decode("ascii"), elapsed, image.mode, image.size, stages


def _time_vae(pipe):
    """Time the VAE encode/decode calls `__call__` makes, without changing them.

    They run inside `pipe(...)`, so wrapping them is the only way to tell the
    condition encode and the final decode apart from the denoise loop around them.

    @returns a `stop()` that restores both methods and returns the seconds spent.
    """
    seconds = {"encode": 0.0, "decode": 0.0}
    originals = {}
    for name in ("encode", "decode"):
        originals[name] = getattr(pipe.vae, name)
        setattr(pipe.vae, name, _timed_call(originals[name], seconds, name))

    def stop():
        for name, original in originals.items():
            setattr(pipe.vae, name, original)
        return {key: round(value, 2) for key, value in seconds.items()}

    return stop


def _timed_call(original, seconds, name):
    """Wrap a bound method so each call adds its duration to `seconds[name]`."""

    def timed(*args, **kwargs):
        started = time.time()
        try:
            return original(*args, **kwargs)
        finally:
            seconds[name] += time.time() - started

    return timed


def _reference_budget(width, height):
    """The `output_resolution` budget the pipeline resizes references to.

    It is a side length whose square is the reference's pixel budget, so mirroring the
    canvas' own area keeps the condition latents and the canvas at one scale.
    """
    return min(4096, max(32, int(round(math.sqrt(width * height) / 32) * 32)))


def _condition_size(target_area, ratio):
    """Resize rule shared by ComfyUI's edit node and this pipeline: 32-aligned sides."""
    width = round(math.sqrt(target_area * ratio) / 32) * 32
    height = round(math.sqrt(target_area / ratio) / 32) * 32
    return max(32, width), max(32, height)


def _prepare_conditions(pipe, images, output_resolution):
    """Resize each reference the way the pipeline will, for the CPU-side text encode.

    `QwenImage21Pipeline.__call__` resizes every condition to
    `calculate_dimensions(output_resolution ** 2, aspect)` before handing it to both the
    text encoder and the VAE ("one resize feeds both"), so the manual encode below must
    use that same size -- otherwise the vision tokens and the VAE latents disagree.
    """
    prepared = []
    for image in images:
        if image.mode != "RGBA":
            image = image.convert("RGBA")
        width, height = image.size
        input_width, input_height = _condition_size(output_resolution * output_resolution, width / height)
        prepared.append(pipe.image_processor.resize(image, width=input_width, height=input_height))
    return prepared


def _relay_image_pad_mask(pipe, mask):
    """Add the one argument `QwenImage21Pipeline.__call__` cannot pass itself.

    `encode_prompt` returns the mask marking which positions hold image tokens, and it
    refuses caller-supplied `prompt_embeds` together with `image` unless that mask comes
    back in -- but `__call__` never forwards one. This installs a per-instance wrapper
    that supplies it and delegates everything else unchanged; the caller restores the
    original method as soon as the sampling call returns. Returns the original so the
    caller can do exactly that.

    Route A (`pipe(prompt=..., image=...)`, letting the pipeline encode) was measured and
    does not work here: the pipeline encodes on `self._execution_device` (cuda:0) while the
    text encoder is deliberately on the CPU, and accelerate's hook does not relocate the
    inputs -> "Expected all tensors to be on the same device, but got index is on cuda:0,
    different from other tensors on cpu".
    """
    original = pipe.encode_prompt

    def relay(
        prompt,
        image=None,
        device=None,
        num_images_per_prompt=1,
        prompt_embeds=None,
        prompt_embeds_mask=None,
        image_pad_mask=None,
    ):
        if prompt_embeds is not None and image is not None and image_pad_mask is None:
            image_pad_mask = mask
        return original(
            prompt,
            image=image,
            device=device,
            num_images_per_prompt=num_images_per_prompt,
            prompt_embeds=prompt_embeds,
            prompt_embeds_mask=prompt_embeds_mask,
            image_pad_mask=image_pad_mask,
        )

    pipe.encode_prompt = relay
    return original


def _decode_references(images):
    """Decode the optional `images` field into RGBA PIL images.

    Accepts plain base64 and `data:image/...;base64,...` entries. Anything that cannot be
    decoded is an error naming its position: a dropped reference would shift every
    `<imageN>` label the prompt was written against.
    """
    from PIL import Image

    if not isinstance(images, list):
        raise ValueError("images must be an array of base64 or data: URI strings")
    if len(images) > 10:
        raise ValueError(f"images carries {len(images)} reference images, but at most 10 are supported")
    decoded = []
    for position, entry in enumerate(images):
        if not isinstance(entry, str) or not entry.strip():
            raise ValueError(f"images[{position}] must be a non-empty base64 or data: URI string")
        payload = entry.strip()
        if payload.startswith("data:"):
            comma = payload.find(",")
            if comma == -1 or ";base64" not in payload[:comma]:
                raise ValueError(f"images[{position}] is a data URI without a base64 payload")
            payload = payload[comma + 1 :]
        try:
            raw = base64.b64decode(payload, validate=False)
        except Exception as error:
            raise ValueError(f"images[{position}] is not valid base64: {error}")
        if not raw:
            raise ValueError(f"images[{position}] decoded to 0 bytes")
        try:
            with Image.open(io.BytesIO(raw)) as parsed:
                parsed.load()
                decoded.append(parsed.convert("RGBA"))
        except Exception as error:
            raise ValueError(f"images[{position}] is not a readable image: {type(error).__name__}: {error}")
    return decoded


class Server(ThreadingHTTPServer):
    """Threaded server that survives clients hanging up and can rebind its port."""

    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        error = sys.exc_info()[1]
        if isinstance(error, (BrokenPipeError, ConnectionAbortedError, ConnectionResetError)):
            log(f"client went away ({type(error).__name__})")
            return
        super().handle_error(request, client_address)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError) as error:
            # The plugin polls /state while the model loads and may time out its
            # own request. A client that left is not a worker error, and a
            # traceback banner here would bury the line that actually matters.
            log(f"client went away before the response was written ({type(error).__name__})")

    def log_message(self, fmt, *args):
        pass

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        path = self.path.split("?")[0].rstrip("/") or "/"
        if path == "/health":
            # Frozen contract: 2xx == ready. Loading and "unloaded" both answer 503.
            if STATE["ready"]:
                self._send(
                    200,
                    {
                        "status": "ok",
                        "service": SERVICE,
                        "version": VERSION,
                        "model_loaded": True,
                        "load_seconds": round(STATE["load_seconds"] or 0, 1),
                        "generations": STATE["generations"],
                        **_mem(),
                    },
                )
            else:
                self._send(503, {"status": "loading" if STATE["loading"] else "unloaded", "service": SERVICE})
        elif path == "/state":
            # Always 200 while the process lives: this is what tells the plugin
            # "loading" apart from "died" (a dead worker refuses the connection).
            self._send(
                200,
                {
                    "status": "ok",
                    "service": SERVICE,
                    "version": VERSION,
                    "pid": os.getpid(),
                    "port": STATE.get("port"),
                    "ready": STATE["ready"],
                    "loading": STATE["loading"],
                    "load_error": STATE["load_error"],
                    "load_seconds": round(STATE["load_seconds"], 1) if STATE["load_seconds"] else None,
                    "generations": STATE["generations"],
                    "models_dir": STATE["models_dir"],
                    "uptime_s": round(time.time() - STATE["started_at"], 1),
                    "unloaded_at": STATE["unloaded_at"],
                    **_mem(),
                },
            )
        elif path in ("/stats", "/"):
            self._send(
                200,
                {
                    "service": SERVICE,
                    "generations": STATE["generations"],
                    "peak_vram_reserved_MiB": round(STATE.get("peak_reserved", 0.0), 1),
                    **_mem(),
                },
            )
        else:
            self._send(404, {"error": "not found", "paths": ["/health", "/state", "/stats", "/generate", "/unload"]})

    def do_POST(self):
        path = self.path.split("?")[0].rstrip("/") or "/"
        if path == "/shutdown":
            # The plugin's own way to stop *this* process. It exists because a venv's
            # python.exe on Windows is a redirector: killing the process the plugin
            # spawned leaves the real interpreter — and its VRAM — behind.
            try:
                self._send(200, {"status": "ok", "shutting_down": True, "pid": os.getpid()})
            except Exception:
                pass
            log("shutdown requested by the plugin")
            threading.Thread(target=_shutdown, daemon=True).start()
            return
        if path == "/unload":
            try:
                self._send(200, {"status": "ok", **unload_model()})
            except Exception as error:
                log("UNLOAD FAILED:", type(error).__name__, error)
                self._send(500, {"error": f"{type(error).__name__}: {error}"})
            return
        if path != "/generate":
            self._send(404, {"error": "not found"})
            return
        try:
            request = self._read_json()
        except Exception as error:
            self._send(400, {"error": f"bad request: {error}"})
            return
        # Validate the references before the model is loaded, so a bad request cannot
        # cost a cold start.
        try:
            references = _decode_references(request.get("images")) if request.get("images") else []
        except Exception as error:
            log("BAD REQUEST (images):", type(error).__name__, error)
            self._send(400, {"error": f"bad request: {error}"})
            return
        try:
            # Blocks while a cold start or a post-unload reload finishes, so the
            # plugin never has to poll for readiness before calling /generate.
            ensure_loaded()
        except Exception as error:
            log("LOAD FAILED:", type(error).__name__, error)
            traceback.print_exc()
            self._send(503, {"error": f"model failed to load: {type(error).__name__}: {error}"})
            return
        prompt = request.get("prompt") or ""
        width = int(request.get("width") or 1024)
        height = int(request.get("height") or 1024)
        count = max(1, min(int(request.get("count") or 1), 8))
        # Fallback only for a caller that talks to the worker DIRECTLY, bypassing
        # the plugin: 25 is the official Qwen-Image 2.1 template count (the
        # diffusers pipeline's default is 40). This used to be 8, which silently
        # produced a different look from the ComfyUI backend. The plugin always
        # resolves the count itself (explicit > per-backend > defaultSteps) and
        # sends it explicitly, so this line is not on its path.
        steps = int(request.get("steps") or 25)
        seed_value = request.get("seed")
        seed = int(seed_value) if seed_value is not None else 0
        transparent = request.get("transparent", True)
        # Optional explicit conditioning budget for the edit path; absent means the
        # canvas decides (`_reference_budget`), which is this worker's own default.
        budget_value = request.get("reference_budget")
        reference_budget = None
        if budget_value is not None:
            try:
                reference_budget = int(budget_value)
            except (TypeError, ValueError):
                log("BAD REQUEST (reference_budget):", repr(budget_value))
                self._send(400, {"error": f"bad request: reference_budget must be an integer, got {budget_value!r}"})
                return
        images, timings, stages = [], [], []
        with _gen_lock:
            for index in range(count):
                try:
                    b64, elapsed, mode, size, detail = generate(
                        prompt, width, height, steps, seed + index, transparent,
                        images=references, reference_budget=reference_budget,
                    )
                    images.append(b64)
                    timings.append(round(elapsed, 2))
                    stages.append(detail)
                    STATE["generations"] += 1
                    log(
                        f"generated {index + 1}/{count} {width}x{height} steps={steps} mode={mode} "
                        f"refs={len(references)} in {elapsed:.1f}s"
                    )
                    # One line per job naming every stage, so the answer to "why was
                    # that slow" is in the log even when nobody reads the JSON.
                    log("  stages: " + " | ".join(f"{key}={value}" for key, value in detail.items()))
                except Exception as error:
                    log("GENERATE FAILED:", type(error).__name__, error)
                    traceback.print_exc()
                    self._send(
                        500,
                        {"error": f"{type(error).__name__}: {error}", "images": images, "traceback": traceback.format_exc()[-2000:]},
                    )
                    return
        try:
            import torch

            peak = round(torch.cuda.max_memory_reserved() / 2**20, 1)
            STATE["peak_reserved"] = max(STATE.get("peak_reserved", 0.0), peak)
        except Exception:
            peak = None
        self._send(
            200,
            {
                "images": images,
                "timings_s": timings,
                "stages_s": stages,
                "peak_vram_reserved_MiB": peak,
                **_mem(),
            },
        )


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="dsh-image-forge local Qwen-Image worker")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8399)
    parser.add_argument("--models-dir", default=os.environ.get("FORGE_MODELS_DIR", ""))
    parser.add_argument("--data-dir", default="")
    args = parser.parse_args(argv)
    if not args.models_dir:
        parser.error("--models-dir is required (or set FORGE_MODELS_DIR)")
    return args


def main(argv=None):
    args = parse_args(argv)
    STATE["models_dir"] = os.path.abspath(args.models_dir)
    STATE["data_dir"] = os.path.abspath(args.data_dir) if args.data_dir else None
    STATE["port"] = args.port

    if not os.path.isdir(STATE["models_dir"]):
        log(f"FATAL: models directory does not exist: {STATE['models_dir']}")
        log("run the plugin's `qwen_image_env fetch-weights` action first")
        return 2
    if not os.path.exists(os.path.join(STATE["models_dir"], "model_index.json")):
        log(f"FATAL: {STATE['models_dir']} is not a diffusers pipeline (no model_index.json)")
        return 2

    # Bind before loading so `/state` can report progress while the model is coming up.
    try:
        server = Server((args.host, args.port), Handler)
    except OSError as error:
        log(f"FATAL: cannot bind {args.host}:{args.port}: {error}")
        return 2
    log(f"{SERVICE} {VERSION} pid={os.getpid()} listening on http://{args.host}:{args.port}")
    threading.Thread(target=server.serve_forever, daemon=True).start()
    write_state_file()

    # Load eagerly: the plugin's readiness wait and the first /generate then agree on
    # one cold start instead of racing each other.
    try:
        ensure_loaded()
    except Exception:
        log("PIPELINE LOAD FAILED")
        traceback.print_exc()
        return 1
    log("ready: GET /health, GET /state, POST /generate, POST /unload")
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
