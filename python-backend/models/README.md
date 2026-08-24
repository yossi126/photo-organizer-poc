# Bundled ONNX models

## mobilenetv2-7.onnx

- Purpose: image embeddings for similarity stacking + AI-profile features.
- Source: ONNX Model Zoo (validated) —
  https://github.com/onnx/models/raw/main/validated/vision/classification/mobilenet/model/mobilenetv2-7.onnx
- SHA256: `C1C513582D56AFCEFF8516C73804E484C81C6A830712AB6D682253F4A3CD042F`
- Input: `data` float32 NCHW 1×3×224×224, ImageNet-normalized
  (mean [0.485, 0.456, 0.406], std [0.229, 0.224, 0.225]).
- Output: 1×1000 logits — L2-normalized and used directly as the embedding.

If the model file is missing, `embeddings.py` falls back to a classical
feature vector (downscaled pixels + color histograms). Stacking still works
for near-identical bursts, but semantic similarity is weaker — restore the
model for production.

Face models (`face_landmarker.task`, `face_detection_yunet.onnx`) live in the
parent directory (legacy location) and are documented in CLAUDE.md.
