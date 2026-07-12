import * as faceapi from "@vladmandic/face-api";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

/**
 * Server-side face verification using @vladmandic/face-api.
 * Verifies that:
 *   1. The selfie image contains exactly one face
 *   2. (Optional) The selfie face matches an enrollment photo
 *
 * Models are loaded from frontend/public/models/face-api/ or MODEL_DIR env var.
 */

const MODEL_DIR = process.env.FACE_API_MODEL_DIR || join(process.cwd(), "..", "frontend", "public", "models", "face-api");
const MATCH_THRESHOLD = 0.5;
const MIN_FACE_SCORE = 0.3;

let modelsLoaded = false;

export const loadModels = async () => {
  if (modelsLoaded) return;
  if (!existsSync(MODEL_DIR)) {
    throw new Error(`Face API models not found at ${MODEL_DIR}`);
  }
  await faceapi.nets.tinyFaceDetector.loadFromDisk(MODEL_DIR);
  await faceapi.nets.faceLandmark68TinyNet.loadFromDisk(MODEL_DIR);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_DIR);
  modelsLoaded = true;
  console.log("[face-api] Models loaded from", MODEL_DIR);
};

const fetchImage = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Failed to fetch image: HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const { default: sharp } = await import("sharp");
    const { data, info } = await sharp(buffer)
      .resize({ width: 640, height: 640, fit: "inside" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
  } finally {
    clearTimeout(timer);
  }
};

export const detectSingleFace = async (imageUrl) => {
  await loadModels();
  const image = await fetchImage(imageUrl);
  const detections = await faceapi
    .detectAllFaces(image, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: MIN_FACE_SCORE }))
    .withFaceLandmarks(true)
    .withFaceDescriptors();

  if (detections.length === 0) {
    return { valid: false, error: "No face detected in the image" };
  }
  if (detections.length > 1) {
    return { valid: false, error: "Multiple faces detected — only one face allowed" };
  }
  return { valid: true, descriptor: Array.from(detections[0].descriptor), score: detections[0].detection.score };
};

export const compareFaces = async ({ enrollmentImageUrl, liveImageUrl }) => {
  await loadModels();

  const [enrollment, live] = await Promise.all([
    detectSingleFace(enrollmentImageUrl),
    detectSingleFace(liveImageUrl)
  ]);

  if (!enrollment.valid) return { match: false, error: `Enrollment photo: ${enrollment.error}` };
  if (!live.valid) return { match: false, error: `Live selfie: ${live.error}` };

  const distance = faceapi.euclideanDistance(
    new Float32Array(enrollment.descriptor),
    new Float32Array(live.descriptor)
  );

  return {
    match: distance <= MATCH_THRESHOLD,
    distance,
    threshold: MATCH_THRESHOLD,
    enrollmentScore: enrollment.score,
    liveScore: live.score
  };
};

export const verifySelfie = async ({ selfieUrl, enrollmentPhotoUrl }) => {
  if (!selfieUrl) return { valid: false, error: "Selfie URL is required" };

  const selfieResult = await detectSingleFace(selfieUrl);
  if (!selfieResult.valid) return { valid: false, error: selfieResult.error };

  if (enrollmentPhotoUrl) {
    const comparison = await compareFaces({ enrollmentImageUrl: enrollmentPhotoUrl, liveImageUrl: selfieUrl });
    if (!comparison.match) {
      return { valid: false, error: `Face does not match enrollment photo (distance: ${comparison.distance?.toFixed(3)})` };
    }
    return { valid: true, distance: comparison.distance };
  }

  return { valid: true };
};
