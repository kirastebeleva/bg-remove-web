let removeBackgroundFn = null;
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

async function getRemoveBackground() {
  if (!removeBackgroundFn) {
    const module = await import(
      "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.6.0/+esm"
    );
    if (!module?.removeBackground) {
      throw new Error("Background remover failed to load.");
    }
    removeBackgroundFn = module.removeBackground;
  }
  return removeBackgroundFn;
}

async function processImage(file) {
  const token = ++processingToken;
  resetResult();
  setStatus("Идет обработка изображения");
  await new Promise((resolve) => requestAnimationFrame(resolve));

  try {
    const removeBackground = await getRemoveBackground();
    const preferGpu = typeof navigator !== "undefined" && "gpu" in navigator;
    const progressText = (key, current, total) => {
      if (token !== processingToken) return;
      if (!total) return;
      const percent = Math.max(0, Math.min(100, Math.round((current / total) * 100)));
      if (key?.startsWith("fetch:")) {
        setStatus(`Идет обработка изображения (загрузка модели ${percent}%)`);
      }
    };
    const baseConfig = {
      publicPath: "https://staticimgly.com/@imgly/background-removal-data/1.6.0/dist/",
      model: "isnet_quint8",
      progress: progressText,
      output: {
        format: "image/png"
      }
    };
    let result;
    try {
      result = await removeBackground(file, {
        ...baseConfig,
        device: preferGpu ? "gpu" : "cpu"
      });
    } catch (gpuError) {
      if (token !== processingToken) return;
      if (preferGpu) {
        setStatus("Идет обработка изображения (CPU)");
        result = await removeBackground(file, {
          ...baseConfig,
          device: "cpu"
        });
      } else {
        throw gpuError;
      }
    }

    if (token !== processingToken) return;
    resultBlob = result;
    resultObjectUrl = URL.createObjectURL(resultBlob);
    afterImg.src = resultObjectUrl;
    downloadBtn.disabled = false;
    downloadBtn.hidden = false;
    setStatus("");
  } catch (e) {
    if (token !== processingToken) return;
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
  a.download = "no-background.png";
  document.body.appendChild(a);
  a.click();
  a.remove();
});
