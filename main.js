import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/";
const fileInput = document.getElementById("fileInput");
const removeBtn = document.getElementById("removeBtn");
const downloadBtn = document.getElementById("downloadBtn");
const statusEl = document.getElementById("status");
const beforeImg = document.getElementById("beforeImg");
const afterImg = document.getElementById("afterImg");

let originalFile = null;
let originalObjectUrl = null;
let resultBlob = null;
let resultObjectUrl = null;

const MAX_MB = 8;                // easy anti-abuse
const MAX_SIDE_PX = 2500;        // easy anti-abuse
let segmenterPromise = null;

function getSegmenter() {
  if (!segmenterPromise) {
    segmenterPromise = pipeline(
      "background-removal",
      "Xenova/modnet",
      { quantized: true }
    );
  }
  return segmenterPromise;
}

function getSampleMax(values) {
  if (!values?.length) return 0;
  const step = Math.max(1, Math.floor(values.length / 2048));
  let maxValue = 0;
  for (let i = 0; i < values.length; i += step) {
    const value = values[i];
    if (value > maxValue) maxValue = value;
    if (maxValue > 1) break;
  }
  return maxValue;
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rawMaskToImageData(raw, width, height, channels) {
  const totalPixels = width * height;
  const inferred = channels ?? (raw.length % totalPixels === 0 ? raw.length / totalPixels : 1);
  const channelCount = Number.isInteger(inferred) ? inferred : 1;
  const data = new Uint8ClampedArray(totalPixels * 4);
  const scale = getSampleMax(raw) <= 1 ? 255 : 1;

  if (channelCount === 1) {
    for (let i = 0; i < totalPixels; i += 1) {
      const value = clampByte(raw[i] * scale);
      const idx = i * 4;
      data[idx] = value;
      data[idx + 1] = value;
      data[idx + 2] = value;
      data[idx + 3] = value;
    }
    return new ImageData(data, width, height);
  }

  if (channelCount === 2) {
    for (let i = 0; i < totalPixels; i += 1) {
      const idx = i * 4;
      const rawIdx = i * 2;
      const value = clampByte(raw[rawIdx] * scale);
      data[idx] = value;
      data[idx + 1] = value;
      data[idx + 2] = value;
      data[idx + 3] = clampByte(raw[rawIdx + 1] * scale);
    }
    return new ImageData(data, width, height);
  }

  if (channelCount === 3) {
    for (let i = 0; i < totalPixels; i += 1) {
      const idx = i * 4;
      const rawIdx = i * 3;
      data[idx] = clampByte(raw[rawIdx] * scale);
      data[idx + 1] = clampByte(raw[rawIdx + 1] * scale);
      data[idx + 2] = clampByte(raw[rawIdx + 2] * scale);
      data[idx + 3] = 255;
    }
    return new ImageData(data, width, height);
  }

  for (let i = 0; i < totalPixels; i += 1) {
    const idx = i * 4;
    const rawIdx = i * channelCount;
    data[idx] = clampByte(raw[rawIdx] * scale);
    data[idx + 1] = clampByte(raw[rawIdx + 1] * scale);
    data[idx + 2] = clampByte(raw[rawIdx + 2] * scale);
    data[idx + 3] = clampByte(raw[rawIdx + 3] * scale);
  }
  return new ImageData(data, width, height);
}

async function maskToImageData(mask) {
  if (!mask) throw new Error("No mask returned.");
  if (typeof ImageData !== "undefined" && mask instanceof ImageData) return mask;

  if (typeof mask?.toCanvas === "function") {
    const canvas = await Promise.resolve(mask.toCanvas());
    const ctx = canvas.getContext("2d");
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  if (mask?.data && mask?.width && mask?.height) {
    return rawMaskToImageData(mask.data, mask.width, mask.height, mask.channels);
  }

  if (typeof HTMLCanvasElement !== "undefined" && mask instanceof HTMLCanvasElement) {
    const ctx = mask.getContext("2d");
    return ctx.getImageData(0, 0, mask.width, mask.height);
  }

  if (typeof ImageBitmap !== "undefined" && mask instanceof ImageBitmap) {
    const canvas = document.createElement("canvas");
    canvas.width = mask.width;
    canvas.height = mask.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(mask, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  if (typeof HTMLImageElement !== "undefined" && mask instanceof HTMLImageElement) {
    const canvas = document.createElement("canvas");
    canvas.width = mask.naturalWidth || mask.width;
    canvas.height = mask.naturalHeight || mask.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(mask, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  throw new Error("Unsupported mask format.");
}

function scaleImageData(imageData, width, height) {
  if (imageData.width === width && imageData.height === height) {
    return imageData;
  }
  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = imageData.width;
  sourceCanvas.height = imageData.height;
  const sourceCtx = sourceCanvas.getContext("2d");
  sourceCtx.putImageData(imageData, 0, 0);

  const targetCanvas = document.createElement("canvas");
  targetCanvas.width = width;
  targetCanvas.height = height;
  const targetCtx = targetCanvas.getContext("2d");
  targetCtx.drawImage(sourceCanvas, 0, 0, width, height);
  return targetCtx.getImageData(0, 0, width, height);
}

function maskUsesAlpha(maskData) {
  let minAlpha = 255;
  let maxAlpha = 0;
  for (let i = 3; i < maskData.length; i += 16) {
    const alpha = maskData[i];
    if (alpha < minAlpha) minAlpha = alpha;
    if (alpha > maxAlpha) maxAlpha = alpha;
    if (minAlpha === 0 && maxAlpha === 255) return true;
  }
  return maxAlpha !== minAlpha && !(minAlpha === 255 && maxAlpha === 255);
}

function canvasToBlob(canvas, type) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to create PNG output."));
        return;
      }
      resolve(blob);
    }, type);
  });
}

async function getForegroundMask(imageUrl) {
  const segmenter = await getSegmenter();
  const output = await segmenter(imageUrl);
  if (Array.isArray(output)) {
    if (!output.length) throw new Error("No foreground detected.");
    return output[0]?.mask ?? output[0];
  }
  return output?.mask ?? output;
}

async function applyMaskToBitmap(bitmap, mask) {
  const width = bitmap.width;
  const height = bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);

  const imageData = ctx.getImageData(0, 0, width, height);
  const maskImageData = await maskToImageData(mask);
  const scaledMask = scaleImageData(maskImageData, width, height);
  const useAlpha = maskUsesAlpha(scaledMask.data);

  for (let i = 0; i < imageData.data.length; i += 4) {
    const alpha = useAlpha
      ? scaledMask.data[i + 3]
      : Math.round((scaledMask.data[i] + scaledMask.data[i + 1] + scaledMask.data[i + 2]) / 3);
    imageData.data[i + 3] = alpha;
  }

  ctx.putImageData(imageData, 0, 0);
  return canvasToBlob(canvas, "image/png");
}

function setStatus(text, isError = false) {
  statusEl.textContent = text || "";
  statusEl.classList.toggle("error", Boolean(isError));
}

function resetResult() {
  resultBlob = null;
  if (resultObjectUrl) URL.revokeObjectURL(resultObjectUrl);
  resultObjectUrl = null;
  afterImg.src = "";
  downloadBtn.disabled = true;
}

function resetAll() {
  originalFile = null;
  if (originalObjectUrl) URL.revokeObjectURL(originalObjectUrl);
  originalObjectUrl = null;
  beforeImg.src = "";
  resetResult();
  removeBtn.disabled = true;
  setStatus("");
}

async function validateImage(file) {
  if (!file.type.startsWith("image/")) throw new Error("Please upload an image file.");
  if (file.size > MAX_MB * 1024 * 1024) throw new Error(`File is too large. Max ${MAX_MB} MB.`);

  // Check dimensions
  const img = new Image();
  const url = URL.createObjectURL(file);
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("Cannot read this image."));
      img.src = url;
    });

    const maxSide = Math.max(img.naturalWidth, img.naturalHeight);
    if (maxSide > MAX_SIDE_PX) {
      throw new Error(`Image is too large. Max side ${MAX_SIDE_PX}px.`);
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

fileInput.addEventListener("change", async () => {
  resetAll();
  const file = fileInput.files?.[0];
  if (!file) return;

  try {
    setStatus("Validating...");
    await validateImage(file);

    originalFile = file;
    originalObjectUrl = URL.createObjectURL(file);
    beforeImg.src = originalObjectUrl;

    removeBtn.disabled = false;
    setStatus("Ready.");
  } catch (e) {
    setStatus(e.message || "Validation error.", true);
    resetAll();
  }
});

removeBtn.addEventListener("click", async () => {
  if (!originalFile) return;

  resetResult();
  removeBtn.disabled = true;
  let bitmap = null;

  try {
    setStatus("Loading MODNet model...");
    const mask = await getForegroundMask(originalObjectUrl);
    setStatus("Removing background...");

    bitmap = await createImageBitmap(originalFile);
    resultBlob = await applyMaskToBitmap(bitmap, mask);
    resultObjectUrl = URL.createObjectURL(resultBlob);
    afterImg.src = resultObjectUrl;

    downloadBtn.disabled = false;
    setStatus("Done.");
  } catch (e) {
    console.error(e);
    setStatus(e?.message || "Failed to remove background.", true);
  } finally {
    bitmap?.close?.();
    removeBtn.disabled = false;
  }
});

downloadBtn.addEventListener("click", () => {
  if (!resultBlob) return;
  const a = document.createElement("a");
  a.href = resultObjectUrl;
  a.download = "no-background.png";
  document.body.appendChild(a);
  a.click();
  a.remove();
});
