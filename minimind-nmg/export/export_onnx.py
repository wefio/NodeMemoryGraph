"""Export MiniMind-NMG Encoder to ONNX for Node.js deployment."""

import argparse
import torch
import torch.onnx
from pathlib import Path


def export_onnx(model_dir: str, output_path: str, opset: int = 17, dynamic_batch: bool = True):
    """
    Export a saved MiniMindEncoder to ONNX.

    Args:
        model_dir: Path to a saved_pretrained directory (config.json + model.safetensors)
        output_path: Output .onnx path
        opset: ONNX opset version (17+ recommended for scaled_dot_product_attention)
        dynamic_batch: If True, export with dynamic batch dimension
    """
    from model.minimind_encoder import MiniMindEncoder

    device = torch.device("cpu")
    model = MiniMindEncoder.from_pretrained(model_dir)
    model = model.to(device)
    model.eval()

    # Dummy inputs
    batch = 1 if not dynamic_batch else "batch"
    seq_len = 64  # will be overridden by dynamic axes
    dummy_input_ids = torch.randint(0, model.config.vocab_size, (1, seq_len), device=device)
    dummy_attention_mask = torch.ones(1, seq_len, dtype=torch.long, device=device)

    dynamic_axes = None
    if dynamic_batch:
        dynamic_axes = {
            "input_ids": {0: "batch", 1: "sequence"},
            "attention_mask": {0: "batch", 1: "sequence"},
            "embedding": {0: "batch"},
            "activation": {0: "batch"},
        }

    # Ensure output directory exists
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    torch.onnx.export(
        model,
        (dummy_input_ids, dummy_attention_mask),
        output_path,
        input_names=["input_ids", "attention_mask"],
        output_names=["embedding", "activation"],
        dynamic_axes=dynamic_axes,
        opset_version=opset,
        do_constant_folding=True,
    )

    print(f"ONNX model exported to {output_path}")

    # Verify
    import onnx
    onnx_model = onnx.load(output_path)
    onnx.checker.check_model(onnx_model)
    print("ONNX model verification: OK")

    # Run a quick inference test
    import onnxruntime as ort
    session = ort.InferenceSession(output_path)
    test_ids = torch.randint(0, model.config.vocab_size, (2, 128), device="cpu").numpy()
    test_mask = torch.ones(2, 128, dtype=torch.int64).numpy()
    outputs = session.run(None, {
        "input_ids": test_ids,
        "attention_mask": test_mask,
    })
    embedding, activation = outputs
    print(f"Test inference: embedding shape {embedding.shape}, activation shape {activation.shape}")

    # Check L2 norm
    norms = (embedding ** 2).sum(axis=1) ** 0.5
    print(f"L2 norms: min={norms.min():.4f}, max={norms.max():.4f}, mean={norms.mean():.4f}")

    return output_path


def export_fp16(input_path: str, output_path: str):
    """Convert FP32 ONNX model to FP16."""
    from onnxconverter_common import float16
    import onnx

    model = onnx.load(input_path)
    model_fp16 = float16.convert_float_to_float16(model, keep_io_types=True)
    onnx.save(model_fp16, output_path)
    print(f"FP16 model exported to {output_path}")
    return output_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model_dir", type=str, required=True,
                        help="Path to saved_pretrained MiniMindEncoder directory")
    parser.add_argument("--output", type=str, default="./out/encoder/encoder.onnx")
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--fp16", action="store_true",
                        help="Also export FP16 version")
    args = parser.parse_args()

    export_onnx(args.model_dir, args.output, opset=args.opset)

    if args.fp16:
        fp16_path = args.output.replace(".onnx", "_fp16.onnx")
        export_fp16(args.output, fp16_path)
