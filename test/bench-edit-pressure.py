"""Why the edit path is ~15x slower per denoise step than text-to-image.

Same canvas, same step count, four configurations, one model load. For each step
it records wall time plus the driver's own free-VRAM reading, which is what tells
"the transformer is doing more work" apart from "the card is full and the driver
is paging".

    <venv>/Scripts/python.exe test/bench-edit-pressure.py <models-dir> [width] [height] [steps]

Prints one JSON object per line. Dev-only; the plugin never imports this.
"""
import base64
import io
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "resources"))

import worker  # noqa: E402

ARGS = [item for item in sys.argv[1:] if not item.startswith("--")]
MODELS = os.path.abspath(ARGS[0])
WIDTH = int(ARGS[1]) if len(ARGS) > 1 else 1312
HEIGHT = int(ARGS[2]) if len(ARGS) > 2 else 736
STEPS = int(ARGS[3]) if len(ARGS) > 3 else 6
EDIT_PROMPT = "把<image1>里的人物换成短发，背景改成雪山，保持构图"


def emit(kind, payload):
    print(json.dumps({"kind": kind, **payload}, ensure_ascii=False), flush=True)


def build_reference():
    from PIL import Image

    image = Image.new("RGBA", (1024, 574))
    pixels = image.load()
    for y in range(574):
        for x in range(1024):
            pixels[x, y] = ((x * 7 + y * 13) % 251, (x * 3) % 253, (y * 5) % 247, 255)
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def run_edit(torch, pipe, label, reference_b64, budget=None, ratio=None, use_kv_cache=True):
    """One edit job. `budget` overrides the reference pixel budget the pipeline resizes to."""
    # The caching allocator keeps freed blocks reserved, so without this each run
    # inherits the previous run's high-water mark and is no longer a measurement of
    # its own configuration.
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    decoded = worker._decode_references([reference_b64])
    full_budget = worker._reference_budget(WIDTH, HEIGHT)
    effective_budget = full_budget if budget is None else budget
    if ratio is not None:
        effective_budget = int(round(full_budget * ratio / 100 / 32) * 32)

    prepared = worker._prepare_conditions(pipe, decoded, effective_budget)
    stage = time.time()
    prompt_embeds, prompt_embeds_mask, image_pad_mask = pipe.encode_prompt(
        prompt=EDIT_PROMPT, image=prepared, device=torch.device("cpu"), num_images_per_prompt=1
    )
    encode_s = time.time() - stage
    prompt_embeds = prompt_embeds.to("cuda")
    if prompt_embeds_mask is not None:
        prompt_embeds_mask = prompt_embeds_mask.to("cuda")

    steps = []
    marks = {}

    def on_step(_pipe, index, _timestep, callback_kwargs):
        now = time.time()
        marks.setdefault("last", now)
        free_bytes, total_bytes = torch.cuda.mem_get_info()
        steps.append({
            "step": index,
            "seconds": round(now - marks["last"], 2),
            "allocated_MiB": round(torch.cuda.memory_allocated() / 2**20, 1),
            "reserved_MiB": round(torch.cuda.memory_reserved() / 2**20, 1),
            "driver_free_MiB": round(free_bytes / 2**20, 1),
            "driver_total_MiB": round(total_bytes / 2**20, 1),
        })
        marks["last"] = now
        return callback_kwargs

    restore = worker._relay_image_pad_mask(pipe, image_pad_mask.to("cuda"))
    torch.cuda.reset_peak_memory_stats()
    started = time.time()
    try:
        result = pipe(
            prompt_embeds=prompt_embeds,
            prompt_embeds_mask=prompt_embeds_mask,
            width=WIDTH,
            height=HEIGHT,
            num_inference_steps=STEPS,
            generator=torch.Generator("cpu").manual_seed(0),
            output_type="pil",
            image=decoded,
            output_resolution=effective_budget,
            callback_on_step_end=on_step,
            use_kv_cache=use_kv_cache,
        )
    finally:
        pipe.encode_prompt = restore
    total_s = time.time() - started
    denoise_s = sum(step["seconds"] for step in steps)
    emit(label, {
        "reference_budget": effective_budget,
        "condition_size": list(prepared[0].size),
        "prompt_tokens": int(prompt_embeds.shape[1]),
        "image_pad_tokens": int(image_pad_mask.sum().item()),
        "encode_prompt_s": round(encode_s, 2),
        "pipe_call_s": round(total_s, 2),
        "denoise_s": round(denoise_s, 2),
        "per_step_s": round(denoise_s / max(1, STEPS), 2),
        "peak_allocated_MiB": round(torch.cuda.max_memory_allocated() / 2**20, 1),
        "peak_reserved_MiB": round(torch.cuda.max_memory_reserved() / 2**20, 1),
        "min_driver_free_MiB": min(step["driver_free_MiB"] for step in steps),
        "image_size": list(result.images[0].size),
        "steps": steps,
    })


def main():
    import torch

    emit("env", {"torch": torch.__version__, "threads": torch.get_num_threads(), "steps": STEPS, "canvas": [WIDTH, HEIGHT]})
    started = time.time()
    pipe = worker.load_pipeline(MODELS)
    emit("load", {"seconds": round(time.time() - started, 2)})
    reference_b64 = build_reference()

    # A and B alternate, each starting from an emptied allocator: if the order or a
    # stale reservation were what made A slow, A2 would come out fast.
    run_edit(torch, pipe, "A1_cache_on", reference_b64)
    run_edit(torch, pipe, "B1_cache_off", reference_b64, use_kv_cache=False)
    run_edit(torch, pipe, "A2_cache_on", reference_b64)
    run_edit(torch, pipe, "B2_cache_off", reference_b64, use_kv_cache=False)


if __name__ == "__main__":
    main()
