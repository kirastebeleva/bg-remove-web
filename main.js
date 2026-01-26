let ortReadyPromise = null;
let modelBufferPromise = null;
let sessionInfoPromise = null;
window.__bgAppLoaded = true;
const fileInput = document.getElementById("fileInput");
const downloadBtn = document.getElementById("downloadBtn");
const statusEl = document.getElementById("status");
const beforeImg = document.getElementById("beforeImg");
const afterImg = document.getElementById("afterImg");

let originalFile = null;
let originalObjectUrl = null;
let resultBlob = null;
let resultObjectUrl = null;
let processingToken = 0;

const MAX_MB = 8;                // easy anti-abuse
const MAX_SIDE_PX = 2500;        // easy anti-abuse
const MODEL_URL =
  "https://raw.githubusercontent.com/onnx/models/main/vision/body_analysis/u2net/model/u2netp.onnx";
const MODEL_INPUT_SIZE = 320;
const ORT_BASE_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@latest/dist/";
const ORT_SCRIPT_URL = `${ORT_BASE_URL}ort.min.js`;
const MODEL_LABEL = "U^2-Net (u2netp.onnx)";
const MEAN_RGB = [0.485, 0.456, 0.406];
const STD_RGB = [0.229, 0.224, 0.225];

function setStatus(text, isError = false) {
  statusEl.textContent = text || "";
  statusEl.classList.toggle("error", Boolean(isError));
  statusEl.hidden = !text;
}

function resetResult() {
  resultBlob = null;
  if (resultObjectUrl) URL.revokeObjectURL(resultObjectUrl);
  resultObjectUrl = null;
  afterImg.src = "";
  downloadBtn.disabled = true;
  downloadBtn.hidden = true;
}

function resetAll() {
  originalFile = null;
  if (originalObjectUrl) URL.revokeObjectURL(originalObjectUrl);
  originalObjectUrl = null;
  beforeImg.src = "";
  resetResult();
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

function loadOrt() {
  if (globalThis.ort) {
    if (globalThis.ort?.env?.wasm) {
      globalThis.ort.env.wasm.wasmPaths = ORT_BASE_URL;
    }
    return Promise.resolve(globalThis.ort);
  }

  if (!ortReadyPromise) {
    ortReadyPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = ORT_SCRIPT_URL;
      script.async = true;
      script.onload = () => resolve(globalThis.ort);
      script.onerror = () => reject(new Error("Failed to load onnxruntime-web."));
      document.head.appendChild(script);
    })
      .then((ort) => {
        if (!ort) {
          throw new Error("onnxruntime-web failed to initialize.");
        }
        if (ort.env?.wasm) {
          ort.env.wasm.wasmPaths = ORT_BASE_URL;
        }
        return ort;
      })
      .catch((err) => {
        ortReadyPromise = null;
        throw err;
      });
  }

  return ortReadyPromise;
}

async function fetchModelBuffer(onProgress) {
  const response = await fetch(MODEL_URL);
  if (!response.ok) {
    throw new Error("Failed to download U^2-Net model.");
  }
  const total = Number(response.headers.get("Content-Length") || 0);
  if (!response.body || !total) {
    const buffer = await response.arrayBuffer();
    if (onProgress) onProgress(buffer.byteLength, buffer.byteLength);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (onProgress) onProgress(received, total);
  }

  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer.buffer;
}

function getModelBuffer(onProgress) {
  if (!modelBufferPromise) {
    modelBufferPromise = fetchModelBuffer(onProgress).catch((err) => {
      modelBufferPromise = null;
      throw err;
    });
  }
  return modelBufferPromise;
}

async function getSessionInfo(onProgress) {
  if (!sessionInfoPromise) {
    sessionInfoPromise = (async () => {
      const ort = await loadOrt();
      const modelBuffer = await getModelBuffer(onProgress);
      const supportsWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;

      if (supportsWebGpu) {
        try {
          const session = await ort.InferenceSession.create(modelBuffer, {
            executionProviders: ["webgpu", "wasm"]
          });
          return { session, provider: "webgpu" };
        } catch (error) {
          console.warn("WebGPU init failed, falling back to WASM.", error);
        }
      }

      const session = await ort.InferenceSession.create(modelBuffer, {
        executionProviders: ["wasm"]
      });
      return { session, provider: "wasm" };
    })().catch((err) => {
      sessionInfoPromise = null;
      throw err;
    });
  }

  return sessionInfoPromise;
}

async function decodeImage(file) {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file);
    } catch (error) {
      console.warn("createImageBitmap failed, falling back to Image.", error);
    }
  }

  const url = URL.createObjectURL(file);
  const img = new Image();
  return await new Promise((resolve, reject) => {
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Cannot decode this image."));
    };
    img.src = url;
  });
}

function getImageDimensions(image) {
  const width = image.naturalWidth || image.videoWidth || image.width;
  const height = image.naturalHeight || image.videoHeight || image.height;
  return { width, height };
}

function createInputTensor(ort, image) {
  const canvas = document.createElement("canvas");
  canvas.width = MODEL_INPUT_SIZE;
  canvas.height = MODEL_INPUT_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const size = canvas.width * canvas.height;
  const floatData = new Float32Array(3 * size);

  for (let i = 0; i < size; i++) {
    const base = i * 4;
    const r = data[base] / 255;
    const g = data[base + 1] / 255;
    const b = data[base + 2] / 255;

    floatData[i] = (r - MEAN_RGB[0]) / STD_RGB[0];
    floatData[i + size] = (g - MEAN_RGB[1]) / STD_RGB[1];
    floatData[i + size * 2] = (b - MEAN_RGB[2]) / STD_RGB[2];
  }

  return new ort.Tensor("float32", floatData, [1, 3, canvas.height, canvas.width]);
}

function selectOutputTensor(results, outputNames) {
  const preferred =
    outputNames.find((name) => name.toLowerCase() === "d1") ?? outputNames[0];
  return results[preferred];
}

function createMaskImageData(outputTensor) {
  const dims = outputTensor.dims || [];
  if (dims.length < 2) {
    throw new Error("Unexpected model output.");
  }
  const width = dims[dims.length - 1];
  const height = dims[dims.length - 2];
  const size = width * height;
  const data = outputTensor.data;

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < size; i++) {
    const value = data[i];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const range = max - min || 1;

  const mask = new Uint8ClampedArray(size * 4);
  for (let i = 0; i < size; i++) {
    const normalized = Math.min(1, Math.max(0, (data[i] - min) / range));
    const alpha = Math.round(normalized * 255);
    const offset = i * 4;
    mask[offset] = 0;
    mask[offset + 1] = 0;
    mask[offset + 2] = 0;
    mask[offset + 3] = alpha;
  }

  return new ImageData(mask, width, height);
}

async function renderResult(image, maskImageData) {
  const { width, height } = getImageDimensions(image);

  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = maskImageData.width;
  maskCanvas.height = maskImageData.height;
  const maskCtx = maskCanvas.getContext("2d");
  maskCtx.putImageData(maskImageData, 0, 0);

  const scaledMaskCanvas = document.createElement("canvas");
  scaledMaskCanvas.width = width;
  scaledMaskCanvas.height = height;
  const scaledMaskCtx = scaledMaskCanvas.getContext("2d");
  scaledMaskCtx.imageSmoothingEnabled = true;
  scaledMaskCtx.drawImage(maskCanvas, 0, 0, width, height);

  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = width;
  outputCanvas.height = height;
  const outputCtx = outputCanvas.getContext("2d");
  outputCtx.drawImage(image, 0, 0, width, height);
  outputCtx.globalCompositeOperation = "destination-in";
  outputCtx.drawImage(scaledMaskCanvas, 0, 0);
  outputCtx.globalCompositeOperation = "source-over";

  return await new Promise((resolve, reject) => {
    outputCanvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to generate PNG."));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

function releaseImage(image) {
  if (image && typeof image.close === "function") {
    image.close();
  }
}

async function processImage(file) {
  const token = ++processingToken;
  resetResult();
  setStatus(`Загрузка модели ${MODEL_LABEL}`);
  await new Promise((resolve) => requestAnimationFrame(resolve));

  let decodedImage = null;
  try {
    const progress = (loaded, total) => {
      if (token !== processingToken) return;
      if (!total) {
        setStatus(`Загрузка модели ${MODEL_LABEL}`);
        return;
      }
      const percent = Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
      setStatus(`Загрузка модели ${MODEL_LABEL} (${percent}%)`);
    };

    const sessionPromise = getSessionInfo(progress);
    const imagePromise = decodeImage(file);
    const [{ session, provider }, image, ort] = await Promise.all([
      sessionPromise,
      imagePromise,
      loadOrt()
    ]);
    decodedImage = image;

    if (token !== processingToken) {
      releaseImage(decodedImage);
      return;
    }

    const providerLabel = provider === "webgpu" ? "WebGPU" : "WASM";
    setStatus(`Идет обработка изображения (${providerLabel})`);

    const inputTensor = createInputTensor(ort, decodedImage);
    const feeds = { [session.inputNames[0]]: inputTensor };
    const results = await session.run(feeds);

    if (token !== processingToken) {
      releaseImage(decodedImage);
      return;
    }

    const outputTensor = selectOutputTensor(results, session.outputNames);
    const maskImageData = createMaskImageData(outputTensor);
    setStatus("Формирование PNG");
    resultBlob = await renderResult(decodedImage, maskImageData);
    releaseImage(decodedImage);
    resultObjectUrl = URL.createObjectURL(resultBlob);
    afterImg.src = resultObjectUrl;
    downloadBtn.disabled = false;
    downloadBtn.hidden = false;
    setStatus("");
  } catch (e) {
    if (token !== processingToken) return;
    releaseImage(decodedImage);
    console.error(e);
    resetResult();
    setStatus(e?.message || "Failed to remove background.", true);
  }
}

const handleFileSelection = async () => {
  resetAll();
  const file = fileInput.files?.[0];
  if (!file) return;

  try {
    setStatus("Validating...");
    await validateImage(file);

    originalFile = file;
    originalObjectUrl = URL.createObjectURL(file);
    beforeImg.src = originalObjectUrl;

    await processImage(originalFile);
  } catch (e) {
    console.error(e);
    resetResult();
    setStatus(e?.message || "Validation error.", true);
  }
};

fileInput.addEventListener("change", handleFileSelection);
fileInput.addEventListener("input", handleFileSelection);

fileInput.addEventListener("click", () => {
  fileInput.value = "";
});

downloadBtn.addEventListener("click", () => {
  if (!resultBlob) return;
  const a = document.createElement("a");
  a.href = resultObjectUrl;
  const sourceName = originalFile?.name || fileInput.files?.[0]?.name || "image";
  const baseName = sourceName.replace(/\.[^/.]+$/, "");
  a.download = `${baseName}_no_bg.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
});
