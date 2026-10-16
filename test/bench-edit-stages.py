"""Stage-level timing for the local worker's edit path vs text-to-image.

Dev-only instrument: it loads the same pipeline the shipped worker loads, then
runs one text-to-image job and one edit job at the *same* canvas and step count,
timing every stage that the shipped `/generate` collapses into a single number.

    <venv>/Scripts/python.exe test/bench-edit-stages.py <models-dir> [width] [height] [steps] [--cpu-encode]

Prints one JSON object per line so the numbers can be pasted into a report.
Nothing here is imported by the plugin.

`--cpu-encode` forces the text encoder back to the CPU before each encode, which
is how the shipped worker behaves; default is to leave whatever device the loader
chose (used to compare a GPU-side encode against it).
"""
import base64
import io
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "resources"))

import worker  # noqa: E402  (applies the offline env vars before diffusers loads)

ARGS = [item for item in sys.argv[1:] if not item.startswith("--")]
FLAGS = {item for item in sys.argv[1:] if item.startswith("--")}
CPU_ENCODE = "--cpu-encode" in FLAGS

MODELS = os.path.abspath(ARGS[0])
WIDTH = int(ARGS[1]) if len(ARGS) > 1 else 1312
HEIGHT = int(ARGS[2]) if len(ARGS) > 2 else 736
STEPS = int(ARGS[3]) if len(ARGS) > 3 else 6
EDIT_PROMPT = "把<image1>里的人物换成短发，背景改成雪山，保持构图"
T2I_PROMPT = "一座雪山下的木屋，黄昏，写实摄影"

stats = {}


def add(key, seconds):
    stats[key] = stats.get(key, 0.0) + seconds


def timed(owner, name, key):
    """Replace `owner.name` with a timing wrapper, returning the original."""
    original = getattr(owner, name)

    def wrapper(*args, **kwargs):
        started = time.time()
        try:
            return original(*args, **kwargs)
        finally:
            add(key, time.time() - started)

    setattr(owner, name, wrapper)
    return original


def emit(kind, payload):
    print(json.dumps({"kind": kind, **payload}, ensure_ascii=False), flush=True)


def build_reference():
    """A 1024x574 RGBA reference, built procedurally so no fixture bytes are needed."""
    from PIL import Image

    image = Image.new("RGBA", (1024, 574))
    pixels = image.load()
    for y in range(574):
        for x in range(1024):
            pixels[x, y] = ((x * 7 + y * 13) % 251, (x * 3) % 253, (y * 5) % 247, 255)
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="PNG")
    return image.size, base64.b64encode(buffer.getvalue()).decode("ascii"), len(buffer.getvalue())


def main():
    import torch
    from PIL import Image  # noqa: F401  (kept for symmetry with build_reference)

    emit("env", {
        "models_dir": MODELS,
        "width": WIDTH,
        "height": HEIGHT,
        "steps": STEPS,
        "cpu_encode_flag": CPU_ENCODE,
        "torch": torch.__version__,
        "threads": torch.get_num_threads(),
        "cuda": torch.cuda.get_device_name(0),
    })

    started = time.time()
    pipe = worker.load_pipeline(MODELS)
    worker.STATE["pipe"] = pipe
    worker.STATE["ready"] = True
    emit("load", {
        "seconds": round(time.time() - started, 2),
        "vram_allocated_MiB": round(torch.cuda.memory_allocated() / 2**20, 1),
        "text_encoder_device": str(next(pipe.text_encoder.parameters()).device),
    })

    timed(type(pipe.vae), "encode", "vae_encode")
    timed(type(pipe.vae), "decode", "vae_decode")
    timed(type(pipe.processor), "__call__", "processor")

    encoder = {"span": 0.0}
    mark = {"at": 0.0, "device": None}

    def te_pre(module, _args):
        mark["at"] = time.time()
        mark["device"] = str(next(module.parameters()).device)

    def te_post(_module, _args, _output):
        encoder["span"] += time.time() - mark["at"]

    pipe.text_encoder.register_forward_pre_hook(te_pre)
    pipe.text_encoder.register_forward_hook(te_post)

    def run(kind, prompt, reference_b64=None):
        stats.clear()
        encoder["span"] = 0.0
        torch.cuda.reset_peak_memory_stats()
        stages = {}

        decoded = prepared = None
        if reference_b64 is not None:
            stage = time.time()
            decoded = worker._decode_references([reference_b64])
            stages["decode_reference"] = round(time.time() - stage, 2)
            budget = worker._reference_budget(WIDTH, HEIGHT)
            stage = time.time()
            prepared = worker._prepare_conditions(pipe, decoded, budget)
            stages["prepare_conditions"] = round(time.time() - stage, 2)
            stages["reference_budget"] = budget
            stages["prepared_size"] = list(prepared[0].size)

        if CPU_ENCODE:
            pipe.text_encoder.to("cpu")

        stage = time.time()
        if prepared is not None:
            prompt_embeds, prompt_embeds_mask, image_pad_mask = pipe.encode_prompt(
                prompt=prompt, image=prepared, device=torch.device("cpu"), num_images_per_prompt=1
            )
        else:
            prompt_embeds, prompt_embeds_mask, _ = pipe.encode_prompt(
                prompt=prompt, device=torch.device("cpu"), num_images_per_prompt=1
            )
        stages["encode_prompt_total"] = round(time.time() - stage, 2)
        stages["processor"] = round(stats.get("processor", 0.0), 2)
        stages["text_encoder_forward"] = round(encoder["span"], 2)
        stages["encode_residual"] = round(
            stages["encode_prompt_total"] - stages["processor"] - stages["text_encoder_forward"], 2
        )
        stages["encoder_device"] = mark["device"]
        stages["prompt_tokens"] = int(prompt_embeds.shape[1])
        if prepared is not None:
            stages["image_pad_tokens"] = int(image_pad_mask.sum().item())

        stage = time.time()
        prompt_embeds = prompt_embeds.to("cuda")
        if prompt_embeds_mask is not None:
            prompt_embeds_mask = prompt_embeds_mask.to("cuda")
        stages["embeds_to_cuda"] = round(time.time() - stage, 2)

        restore = None
        if prepared is not None:
            restore = worker._relay_image_pad_mask(pipe, image_pad_mask.to("cuda"))
        kwargs = {
            "prompt_embeds": prompt_embeds,
            "prompt_embeds_mask": prompt_embeds_mask,
            "width": WIDTH,
            "height": HEIGHT,
            "num_inference_steps": STEPS,
            "generator": torch.Generator("cpu").manual_seed(0),
            "output_type": "pil",
        }
        if prepared is not None:
            kwargs.update(image=decoded, output_resolution=worker._reference_budget(WIDTH, HEIGHT))

        stage = time.time()
        try:
            result = pipe(**kwargs)
        finally:
            if restore is not None:
                pipe.encode_prompt = restore
        stages["pipe_call_total"] = round(time.time() - stage, 2)
        stages["vae_encode_conditions"] = round(stats.get("vae_encode", 0.0), 2)
        stages["vae_decode"] = round(stats.get("vae_decode", 0.0), 2)
        stages["denoise"] = round(
            stages["pipe_call_total"] - stages["vae_encode_conditions"] - stages["vae_decode"], 2
        )

        image = result.images[0]
        stage = time.time()
        buffer = io.BytesIO()
        image.convert("RGB").save(buffer, format="PNG")
        stages["png_and_base64"] = round(time.time() - stage, 2)
        stages["png_bytes"] = len(buffer.getvalue())

        keys = ("decode_reference", "prepare_conditions", "encode_prompt_total",
                "embeds_to_cuda", "pipe_call_total", "png_and_base64")
        stages["wall_total"] = round(sum(stages[k] for k in keys if k in stages), 2)
        emit(kind, {
            "stages": stages,
            "peak_vram_MiB": round(torch.cuda.max_memory_allocated() / 2**20, 1),
            "image_size": list(image.size),
        })

    size, reference_b64, reference_bytes = build_reference()
    emit("reference", {"bytes": reference_bytes, "size": list(size)})

    run("t2i", T2I_PROMPT)
    run("edit", EDIT_PROMPT, reference_b64)
    run("edit_warm", EDIT_PROMPT, reference_b64)


if __name__ == "__main__":
    main()
