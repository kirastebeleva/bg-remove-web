import { removeBackground } from "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.6.0/+esm";
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

  try {
    setStatus("Removing background...");

    const result = await removeBackground(originalFile, {
      output: {
        format: "image/png"
      }
    });

    resultBlob = result;
    resultObjectUrl = URL.createObjectURL(resultBlob);
    afterImg.src = resultObjectUrl;

    downloadBtn.disabled = false;
    setStatus("Done.");
  } catch (e) {
    console.error(e);
    setStatus("Failed to remove background.", true);
  } finally {
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
