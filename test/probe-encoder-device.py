"""Does the text encode get meaningfully cheaper if the encoder is staged onto the GPU?

Dev-only, standalone, and it changes nothing the shipped worker does. It exists to
price one concrete idea ("stage the nf4 text encoder onto the GPU for the encode,
then get it out of the way so the transformer can have the card"), so the answer is
a number rather than an opinion.

The pipeline's own `encode_prompt` is used in both arms -- no second implementation
of the encode exists here, because a hand-rolled one would measure something else.

    <venv>/Scripts/python.exe test/probe-encoder-device.py <models-dir> [--encode-only]

Emits one JSON object per line.
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
    import torch

    free, total = torch.cuda.mem_get_info()
    return {
        "allocated_MiB": round(torch.cuda.memory_allocated() / 2**20, 1),
        "reserved_MiB": round(torch.cuda.memory_reserved() / 2**20, 1),
        "driver_free_MiB": round(free / 2**20, 1),
        "driver_total_MiB": round(total / 2**20, 1),
    }


def timed_encode(pipe, torch, device, repeats):
    """`encode_prompt` on `device`, repeated; returns every run's seconds."""
    seconds = []
    for _ in range(repeats):
        torch.cuda.synchronize() if device.type == "cuda" else None
        started = time.time()
        prompt_embeds, prompt_embeds_mask, _ = pipe.encode_prompt(
            prompt=PROMPT, device=device, num_images_per_prompt=1
        )
        if device.type == "cuda":
            torch.cuda.synchronize()
        seconds.append(round(time.time() - started, 2))
        tokens = int(prompt_embeds.shape[1])
    return seconds, tokens


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("models")
    parser.add_argument("--repeats", type=int, default=2)
    parser.add_argument("--encode-only", action="store_true")
    args = parser.parse_args()

    import torch

    torch.cuda.empty_cache()
    started = time.time()
    pipe = worker.load_pipeline(os.path.abspath(args.models))
    emit("load", {"seconds": round(time.time() - started, 2), "vram": vram()})

    # Arm 1 -- the shipped arrangement: encoder on CPU, transformer + VAE resident.
    cpu_seconds, tokens = timed_encode(pipe, torch, torch.device("cpu"), args.repeats)
    emit("encode_cpu", {
        "seconds": cpu_seconds,
        "prompt_tokens": tokens,
        "model_resident": "transformer+VAE on cuda",
        "vram": vram(),
    })

    # Arm 2 -- evict everything else, put the encoder on the card, encode.
    started = time.time()
    pipe.transformer.to("cpu")
    pipe.vae.to("cpu")
    torch.cuda.empty_cache()
    torch.cuda.synchronize()
    evict_seconds = round(time.time() - started, 2)
    emit("evict_transformer_and_vae", {"seconds": evict_seconds, "vram": vram()})

    torch.cuda.reset_peak_memory_stats()
    started = time.time()
    pipe.text_encoder.to("cuda")
    torch.cuda.synchronize()
    stage_in_seconds = round(time.time() - started, 2)
    emit("encoder_to_cuda", {"seconds": stage_in_seconds, "vram": vram()})

    gpu_seconds, tokens = timed_encode(pipe, torch, torch.device("cuda"), args.repeats)
    emit("encode_gpu", {
        "seconds": gpu_seconds,
        "prompt_tokens": tokens,
        "encoder_resident": "nf4 on cuda, transformer+VAE on cpu",
        "peak_reserved_MiB": round(torch.cuda.max_memory_reserved() / 2**20, 1),
        "peak_allocated_MiB": round(torch.cuda.max_memory_allocated() / 2**20, 1),
        "vram": vram(),
    })

    if not args.encode_only:
        # Price the way back, because the staged design has to pay it every request.
        started = time.time()
        pipe.text_encoder.to("cpu")
        torch.cuda.empty_cache()
        torch.cuda.synchronize()
        emit("encoder_back_to_cpu", {"seconds": round(time.time() - started, 2), "vram": vram()})

        started = time.time()
        pipe.transformer.to("cuda")
        pipe.vae.to("cuda")
        torch.cuda.synchronize()
        emit("transformer_back_to_cuda", {"seconds": round(time.time() - started, 2), "vram": vram()})


if __name__ == "__main__":
    main()
