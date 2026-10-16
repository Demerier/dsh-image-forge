"""Does the allocator, not the algorithm, cause the edit path's over-commitment?

The clean A/B in `bench-edit-pressure.py` showed the edit path reserving 8666 MiB
on an 8188 MiB card at budget 992, against only 6411 MiB live — 2.2 GiB of that is
fragmentation. `expandable_segments` is an allocator setting that exists to remove
exactly that, and it changes nothing about what is computed.

Run the same job twice in one process, before and after the setting, each from an
emptied allocator, and compare `reserved` against the card.

    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
      <venv>/Scripts/python.exe test/bench-edit-allocator.py <models-dir> [w] [h] [steps]
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


def run_edit(torch, pipe, label, reference_b64, use_kv_cache=True):
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    decoded = worker._decode_references([reference_b64])
    prepared = worker._prepare_conditions(pipe, decoded, worker._reference_budget(WIDTH, HEIGHT))
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
            output_resolution=worker._reference_budget(WIDTH, HEIGHT),
            callback_on_step_end=on_step,
            use_kv_cache=use_kv_cache,
        )
    finally:
        pipe.encode_prompt = restore
    total_s = time.time() - started
    denoise_s = sum(step["seconds"] for step in steps)
    emit(label, {
        "allocator_conf": os.environ.get("PYTORCH_CUDA_ALLOC_CONF", ""),
        "use_kv_cache": use_kv_cache,
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

    free_bytes, total_bytes = torch.cuda.mem_get_info()
    emit("env", {
        "torch": torch.__version__,
        "allocator_conf": os.environ.get("PYTORCH_CUDA_ALLOC_CONF", ""),
        "card_total_MiB": round(total_bytes / 2**20, 1),
        "card_free_MiB": round(free_bytes / 2**20, 1),
    })
    started = time.time()
    pipe = worker.load_pipeline(MODELS)
    emit("load", {"seconds": round(time.time() - started, 2)})
    reference_b64 = build_reference()
    # The configuration the shipped worker uses today.
    run_edit(torch, pipe, "cache_on", reference_b64)
    # Same thing with caching off, as the control.
    run_edit(torch, pipe, "cache_off_control", reference_b64, use_kv_cache=False)


if __name__ == "__main__":
    main()
