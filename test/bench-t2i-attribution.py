"""Step-scan attribution for the local (diffusers + bnb-nf4) backend's text-to-image path.

Dev-only instrument. It loads the pipeline exactly the way the shipped worker does
(`worker.load_pipeline`: bnb-nf4 transformer on cuda, text encoder pinned to CPU,
VAE tiled), then runs a labelled matrix of jobs so that the per-step cost can be
told apart from the per-request fixed cost.

Why a step scan: the earlier "local is ~8x slower per step" figure came from
`(wall - load) / steps`, which charges the CPU text encode and the VAE decode to
every step. With steps in {1,2,4,8} both costs fall out as the intercept of the fit
and only the slope is compared against ComfyUI (see `bench-t2i-comfyui.mjs`, which
does the same scan through the HTTP API).

    <venv>/Scripts/python.exe test/bench-t2i-attribution.py <models-dir> [--flags]

Flags (each one is a single variable, never combined with another):
    --steps 1,2,4,8      step counts to scan (default 1,2,4,8)
    --width N --height N canvas (default 992x992)
    --no-kv-cache        pass use_kv_cache=False       (hypothesis: prefix KV cache)
    --compute-dtype fp16 override bnb compute dtype    (hypothesis: nf4 dequant cost)
    --sdpa flash|math|mem_efficient|default
                         pin the SDPA kernel             (hypothesis: attention backend)
    --ab                 run the toggled config A/B/A/B instead of once (H2 in the report)
    --attribution        profile one denoise step and report the top CUDA kernels
    --tag NAME           label printed on every JSON line (default "base")

Every run is preceded by `empty_cache()` and `reset_peak_memory_stats()`, and every
line carries driver free VRAM, so a run that silently went into WDDM paging is
visible instead of being read as "the backend is slow".

Prints one JSON object per line. Nothing here is imported by the plugin.
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "resources"))

import worker  # noqa: E402  (sets the offline env vars before diffusers is imported)

PROMPT = "A wide realistic photograph of a harbour at dawn, moored wooden boats along a stone quay, low warm sunlight raking across wet planks, soft mist over the water."


def emit(kind, payload):
    print(json.dumps({"kind": kind, **payload}, ensure_ascii=False), flush=True)


def vram():
    """Allocated / reserved / driver-free, all in MiB."""
    import torch

    free, total = torch.cuda.mem_get_info()
    return {
        "allocated_MiB": round(torch.cuda.memory_allocated() / 2**20, 1),
        "reserved_MiB": round(torch.cuda.memory_reserved() / 2**20, 1),
        "driver_free_MiB": round(free / 2**20, 1),
        "driver_total_MiB": round(total / 2**20, 1),
    }


def apply_compute_dtype(pipe, name):
    """Point every bnb Linear4bit at a different compute dtype.

    bitsandbytes reads `self.compute_dtype` on the forward path, so this is a
    runtime knob and needs no reload of the 10.6 GiB checkpoint.
    """
    import bitsandbytes as bnb
    import torch

    dtype = {"bf16": torch.bfloat16, "fp16": torch.float16, "fp32": torch.float32}[name]
    changed = 0
    for module in pipe.transformer.modules():
        if isinstance(module, bnb.nn.Linear4bit):
            module.compute_dtype = dtype
            changed += 1
    return changed


def count_modules(pipe):
    """Structural census: quantized linears, plain linears, and the GEMMs per block."""
    import bitsandbytes as bnb
    import torch

    census = {"linear4bit": 0, "linear_bf16": 0, "blocks": 0, "params_M": 0.0}
    for module in pipe.transformer.modules():
        if isinstance(module, bnb.nn.Linear4bit):
            census["linear4bit"] += 1
        elif isinstance(module, torch.nn.Linear):
            census["linear_bf16"] += 1
    census["blocks"] = len(getattr(pipe.transformer, "transformer_blocks", []))
    census["params_M"] = round(sum(p.numel() for p in pipe.transformer.parameters()) / 1e6, 1)
    return census


def _sdpa_context(name):
    """Pin the SDPA kernel, or yield nothing for the library default."""
    import contextlib

    if name == "default":
        return contextlib.nullcontext()
    import torch
    from torch.nn.attention import SDPBackend, sdpa_kernel

    backends = {
        "flash": [SDPBackend.FLASH_ATTENTION],
        "math": [SDPBackend.MATH],
        "mem_efficient": [SDPBackend.EFFICIENT_ATTENTION],
        "cudnn": [SDPBackend.CUDNN_ATTENTION],
    }[name]
    return sdpa_kernel(backends)


def run_once(pipe, torch, width, height, steps, args, label):
    """One text-to-image job with the stage split and a per-step transformer timer."""
    import contextlib

    torch.cuda.empty_cache()
    torch.cuda.synchronize()
    torch.cuda.reset_peak_memory_stats()
    before = vram()

    stages = {}
    started = time.time()
    prompt_embeds, prompt_embeds_mask, _ = pipe.encode_prompt(
        prompt=PROMPT, device=torch.device("cpu"), num_images_per_prompt=1
    )
    stages["encode_prompt_cpu"] = round(time.time() - started, 2)
    stages["prompt_tokens"] = int(prompt_embeds.shape[1])
    encode_done = vram()

    started = time.time()
    prompt_embeds = prompt_embeds.to("cuda")
    if prompt_embeds_mask is not None:
        prompt_embeds_mask = prompt_embeds_mask.to("cuda")
    stages["embeds_to_cuda"] = round(time.time() - started, 2)

    # Time the VAE encode/decode that `__call__` runs, without changing them.
    vae_seconds = {"encode": 0.0, "decode": 0.0}
    originals = {}
    for name in ("encode", "decode"):
        originals[name] = getattr(pipe.vae, name)

        def make(original, key):
            def timed(*a, **kw):
                t0 = time.time()
                try:
                    return original(*a, **kw)
                finally:
                    vae_seconds[key] += time.time() - t0

            return timed

        setattr(pipe.vae, name, make(originals[name], name))

    # Per-step cost straight off the transformer, so the scheduler is excluded.
    # The sequence length is read off the actual call rather than derived from the
    # packing rule: per-step cost only compares across canvases once it is normalised
    # by this, and getting the packing maths wrong would silently mislabel the report.
    step_times = []
    step_seq = []
    original_forward = pipe.transformer.forward

    def timed_forward(*a, **kw):
        hidden = kw.get("hidden_states", a[0] if a else None)
        if hidden is not None and hasattr(hidden, "shape"):
            step_seq.append(int(hidden.shape[1]))
        torch.cuda.synchronize()
        t0 = time.time()
        try:
            return original_forward(*a, **kw)
        finally:
            torch.cuda.synchronize()
            step_times.append(round(time.time() - t0, 3))

    pipe.transformer.forward = timed_forward
    kwargs = {
        "prompt_embeds": prompt_embeds,
        "prompt_embeds_mask": prompt_embeds_mask,
        "width": width,
        "height": height,
        "num_inference_steps": steps,
        "generator": torch.Generator("cpu").manual_seed(0),
        # "pil", not "latent": the VAE decode is a *fixed* cost, so it has to actually
        # run and be timed -- the step scan puts it in the intercept either way.
        "output_type": "pil",
        "use_kv_cache": not args.no_kv_cache,
    }
    started = time.time()
    try:
        with _sdpa_context(args.sdpa):
            result = pipe(**kwargs)
    finally:
        pipe.transformer.forward = original_forward
        for name, original in originals.items():
            setattr(pipe.vae, name, original)
    stages["pipe_call_total"] = round(time.time() - started, 2)
    stages["vae_encode_conditions"] = round(vae_seconds["encode"], 2)
    stages["vae_decode"] = round(vae_seconds["decode"], 2)
    stages["denoise"] = round(stages["pipe_call_total"] - vae_seconds["encode"] - vae_seconds["decode"], 2)

    after = vram()
    # Denoise seconds are the transformer forwards; per-step is 0 when the pipeline
    # stopped before the last step (an interrupt), which the report has to see.
    denoise_steps = len(step_times) or 1
    emit("run", {
        "label": label,
        "tag": args.tag,
        "width": width,
        "height": height,
        "steps": steps,
        # Measured, not derived: the first forward carries the joint sequence (text
        # prefix + image), later ones carry the image only when the KV cache is on.
        "seq_len_per_forward": step_seq,
        "prefill_seq_len": step_seq[0] if step_seq else None,
        "decode_seq_len": max(step_seq) if step_seq else None,
        "use_kv_cache": not args.no_kv_cache,
        "compute_dtype": args.compute_dtype or "bf16 (checkpoint default)",
        "sdpa": args.sdpa,
        "stages_s": stages,
        "transformer_forwards": len(step_times),
        "per_step_s": step_times,
        "per_step_median_s": sorted(step_times)[len(step_times) // 2] if step_times else None,
        "per_step_mean_s": round(sum(step_times) / denoise_steps, 3),
        "model_only_total_s": round(sum(step_times), 3),
        "vram_before": before,
        "vram_after_encode": encode_done,
        "vram_after": after,
        "peak_reserved_MiB": round(torch.cuda.max_memory_reserved() / 2**20, 1),
        "peak_allocated_MiB": round(torch.cuda.max_memory_allocated() / 2**20, 1),
        "image_size": list(result.images[0].size) if hasattr(result.images[0], "size") else None,
    })
    return step_times


def attribute_one_step(pipe, torch, width, height, args):
    """Profile the real pipeline and rank the CUDA kernels of one denoise step.

    This is what separates "the nf4 weights are dequantized every step" from "the
    attention kernel is the wrong one" from "elementwise kernels dominate": the
    kernel names in the table say which. The profiler schedule captures exactly one
    transformer forward (wait 0 / warmup 1 / active 1), driven by calling `step()`
    at the end of each forward, so the VAE decode and the first-call shapes stay out.

    It profiles the pipeline rather than a hand-built transformer call because the
    transformer wants the *packed* latent plus `img_shapes`/`img_mask`, and
    reconstructing those by hand is exactly the kind of second implementation that
    silently measures something else.
    """
    from torch.profiler import ProfilerActivity, profile, schedule

    prompt_embeds, prompt_embeds_mask, _ = pipe.encode_prompt(
        prompt=PROMPT, device=torch.device("cpu"), num_images_per_prompt=1
    )
    prompt_embeds = prompt_embeds.to("cuda")
    if prompt_embeds_mask is not None:
        prompt_embeds_mask = prompt_embeds_mask.to("cuda")

    original_forward = pipe.transformer.forward
    with profile(
        activities=[ProfilerActivity.CUDA],
        schedule=schedule(wait=0, warmup=1, active=1, repeat=1),
    ) as prof:

        def stepping_forward(*a, **kw):
            result = original_forward(*a, **kw)
            prof.step()
            return result

        pipe.transformer.forward = stepping_forward
        try:
            with torch.no_grad():
                pipe(
                    prompt_embeds=prompt_embeds,
                    prompt_embeds_mask=prompt_embeds_mask,
                    width=width,
                    height=height,
                    num_inference_steps=3,
                    generator=torch.Generator("cpu").manual_seed(0),
                    output_type="latent",
                    use_kv_cache=not args.no_kv_cache,
                )
        finally:
            pipe.transformer.forward = original_forward

    rows = []
    for entry in prof.key_averages():
        if entry.device_time_total <= 0:
            continue
        rows.append({
            "name": entry.key[:90],
            "cuda_ms_total": round(entry.device_time_total / 1000, 2),
            "calls": entry.count,
        })
    rows.sort(key=lambda row: row["cuda_ms_total"], reverse=True)
    emit("kernel_profile", {
        "tag": args.tag,
        "width": width,
        "height": height,
        "use_kv_cache": not args.no_kv_cache,
        "kernels_total_ms": round(sum(row["cuda_ms_total"] for row in rows), 2),
        "top": rows[:25],
    })


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("models")
    parser.add_argument("--steps", default="1,2,4,8")
    parser.add_argument("--width", type=int, default=992)
    parser.add_argument("--height", type=int, default=992)
    parser.add_argument("--no-kv-cache", action="store_true")
    parser.add_argument("--compute-dtype")
    parser.add_argument("--sdpa", default="default")
    parser.add_argument("--ab", action="store_true")
    parser.add_argument("--no-warmup", action="store_true")
    parser.add_argument("--attribution", action="store_true")
    parser.add_argument("--tag", default="base")
    args = parser.parse_args()

    import torch

    torch.cuda.empty_cache()
    started = time.time()
    pipe = worker.load_pipeline(os.path.abspath(args.models))
    load_seconds = round(time.time() - started, 2)

    emit("env", {
        "tag": args.tag,
        "torch": torch.__version__,
        "cuda": torch.cuda.get_device_name(0),
        "card_total_MiB": round(torch.cuda.get_device_properties(0).total_memory / 2**20, 1),
        "load_seconds": load_seconds,
        "canvas": [args.width, args.height],
        "steps": [int(s) for s in args.steps.split(",")],
        "vram_after_load": vram(),
        "census": count_modules(pipe),
        "scheduler": type(pipe.scheduler).__name__,
        "attention_backend": str(getattr(pipe.transformer, "_attention_backend", None)),
        "causal_condition": bool(pipe.transformer.config.causal_condition),
    })

    if args.compute_dtype:
        emit("compute_dtype_override", {"modules": apply_compute_dtype(pipe, args.compute_dtype)})

    step_counts = [int(s) for s in args.steps.split(",")]

    # Discarded warm-up at the target canvas. The first job in a fresh process pays
    # cuDNN kernel selection and allocator growth, and with steps=1 first in the scan
    # that lands directly on the intercept of the fit.
    if not args.no_warmup:
        run_once(pipe, torch, args.width, args.height, 1, args, "warmup_discarded")

    if args.ab:
        # A/B/A/B: the same toggle alternating, so allocator residue and thermal
        # drift cannot be mistaken for the variable's effect.
        for index, enabled in enumerate([True, False, True, False]):
            args.no_kv_cache = not enabled
            for steps in step_counts:
                run_once(pipe, torch, args.width, args.height, steps, args,
                         f"{'A' if enabled else 'B'}{index // 2 + 1}_kv_cache_{'on' if enabled else 'off'}_steps{steps}")
    else:
        for steps in step_counts:
            run_once(pipe, torch, args.width, args.height, steps, args, f"{args.tag}_steps{steps}")

    if args.attribution:
        attribute_one_step(pipe, torch, args.width, args.height, args)


if __name__ == "__main__":
    main()
