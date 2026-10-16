"""Read only the JSON header of a .safetensors file.

Dev-only. The header carries `__metadata__` (where ComfyUI stores a checkpoint's
quantization description) plus every tensor's name/dtype/shape -- enough to answer
"how big would this model be in bf16/fp16" without loading it and without a GPU,
which is the question the staged text-encoder idea turns on.

    python test/probe-safetensors-header.py <file.safetensors> [--keys] [--census]

`--census` aggregates elements by dtype. A uint8 tensor is counted twice by default
because bitsandbytes packs two 4-bit weights per byte; pass `--packed-bits 8` to
count it once if the file turns out to be int8 instead.
"""
import json
import struct
import sys

path = sys.argv[1]
show_keys = "--keys" in sys.argv
census = "--census" in sys.argv
packed_bits = 8 if "8" in sys.argv else 4

with open(path, "rb") as handle:
    (length,) = struct.unpack("<Q", handle.read(8))
    header = json.loads(handle.read(length).decode("utf-8"))

tensors = {name: info for name, info in header.items() if name != "__metadata__"}
out = {
    "file": path,
    "header_bytes": length,
    "metadata": header.get("__metadata__"),
    "tensor_count": len(tensors),
}

if not census:
    print(json.dumps(out, ensure_ascii=False, indent=2))
    if show_keys:
        print(json.dumps({"first_keys": list(tensors)[:12]}, ensure_ascii=False))
    raise SystemExit(0)

by_dtype = {}
groups = {}
for name, info in tensors.items():
    dtype = info.get("dtype")
    count = 1
    for side in info.get("shape", []):
        count *= side
    by_dtype[dtype] = by_dtype.get(dtype, 0) + count
    # The first two dotted components name the submodule: enough to see whether a file
    # is all language model or carries a vision tower as well.
    parts = name.split(".")
    group = ".".join(parts[:2]) if len(parts) > 1 else parts[0]
    entry = groups.setdefault(group, {"elements": 0, "dtypes": {}})
    entry["elements"] += count
    entry["dtypes"][dtype] = entry["dtypes"].get(dtype, 0) + count

# "Logical" parameters: a packed uint8 weight holds two 4-bit values, not one.
logical = sum(
    count * 2 if (dtype == "U8" and packed_bits == 4) else count
    for dtype, count in by_dtype.items()
)

out.update({
    "elements_by_dtype": dict(sorted(by_dtype.items(), key=lambda kv: -kv[1])),
    "packed_bits": packed_bits,
    "logical_parameters": logical,
    "size_if_bf16_GiB": round(logical * 2 / 2**30, 3),
    "size_if_fp32_GiB": round(logical * 4 / 2**30, 3),
    "top_groups": [
        {"group": key, "elements": value["elements"], "dtypes": value["dtypes"]}
        for key, value in sorted(groups.items(), key=lambda kv: -kv[1]["elements"])[:10]
    ],
})
print(json.dumps(out, ensure_ascii=False, indent=2))
