/**
 * Stage 2 image-quality contract. Client-safe: pure types and deterministic checks only.
 *
 * The defaults are conservative proposals, not a job-completion policy. They are
 * intentionally configurable so an owner-approved acceptance policy can be added
 * later without changing the evaluator.
 */

export const IMAGE_QUALITY_DEFAULTS = {
  minWidth: 1280,
  minHeight: 720,
  minBytes: 1_024,
  maxBytes: 12 * 1024 * 1024,
  allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"] as readonly string[],
  minSharpness: 0.35,
  minBrightness: 0.15,
  maxBrightness: 0.90,
  minLegibility: 0.60,
  minFaceQuality: 0.60,
  minIdQuality: 0.60,
} as const;

export type ImageQualityThresholds = {
  minWidth: number; minHeight: number; minBytes: number; maxBytes: number;
  allowedMimeTypes: readonly string[];
  minSharpness: number; minBrightness: number; maxBrightness: number;
  minLegibility: number; minFaceQuality: number; minIdQuality: number;
};

export type QualitySignalName = "sharpness" | "brightness" | "legibility" | "face" | "id";
export type QualitySignalStatus = "pass" | "fail" | "unavailable" | "not_applicable";
export type QualityReason = {
  code: string;
  check: string;
  outcome: "pass" | "fail" | "needs_review";
  message: string;
  actual?: number | string;
  expected?: number | string;
};
export type QualitySignalResult = {
  name: QualitySignalName;
  status: QualitySignalStatus;
  value?: number;
  reason: string;
};

export type ImageQualityInput = {
  byteSize: number;
  mimeType: string;
  detectedMimeType?: string;
  width: number;
  height: number;
  /** Optional provider output. Values are normalized to 0..1. */
  signals?: Partial<Record<QualitySignalName, number | null>>;
  /** Mark face/ID as applicable; otherwise those checks are not applicable. */
  appliesTo?: { face?: boolean; id?: boolean };
};

export type ImageQualityResult = {
  decision: "pass" | "fail" | "needs_review";
  objectivePassed: boolean;
  objectiveReasons: QualityReason[];
  signals: QualitySignalResult[];
  reasons: QualityReason[];
};

const finite = (n: number) => Number.isFinite(n);
const reason = (check: string, code: string, outcome: QualityReason["outcome"], message: string, actual?: number | string, expected?: number | string): QualityReason => ({ code, check, outcome, message, ...(actual === undefined ? {} : { actual }), ...(expected === undefined ? {} : { expected }) });

/** Evaluate objective file checks separately from optional perceptual signals. */
export function evaluateImageQuality(input: ImageQualityInput, config: Partial<ImageQualityThresholds> = {}): ImageQualityResult {
  const t: ImageQualityThresholds = { ...IMAGE_QUALITY_DEFAULTS, ...config };
  const objectiveReasons: QualityReason[] = [];
  const mime = input.mimeType.toLowerCase();
  const allowed = t.allowedMimeTypes.map((v) => v.toLowerCase());
  const objective = (ok: boolean, pass: QualityReason, fail: QualityReason) => objectiveReasons.push(ok ? pass : fail);

  objective(finite(input.width) && input.width >= t.minWidth,
    reason("dimensions", "dimensions_pass", "pass", "Image dimensions meet the minimum.", input.width, t.minWidth),
    reason("dimensions", "dimensions_too_small", "fail", "Image width is below the minimum.", input.width, t.minWidth));
  objective(finite(input.height) && input.height >= t.minHeight,
    reason("dimensions", "dimensions_pass", "pass", "Image dimensions meet the minimum.", input.height, t.minHeight),
    reason("dimensions", "dimensions_too_small", "fail", "Image height is below the minimum.", input.height, t.minHeight));
  objective(finite(input.byteSize) && input.byteSize >= t.minBytes,
    reason("byte_size", "byte_size_pass", "pass", "Image byte size meets the minimum.", input.byteSize, t.minBytes),
    reason("byte_size", "byte_size_too_small", "fail", "Image file is smaller than the minimum.", input.byteSize, t.minBytes));
  objective(finite(input.byteSize) && input.byteSize <= t.maxBytes,
    reason("byte_size", "byte_size_pass", "pass", "Image byte size is within the limit.", input.byteSize, t.maxBytes),
    reason("byte_size", "byte_size_too_large", "fail", "Image file exceeds the maximum.", input.byteSize, t.maxBytes));
  objective(allowed.includes(mime),
    reason("mime_type", "mime_type_pass", "pass", "Image MIME type is allowed.", mime, allowed.join(", ")),
    reason("mime_type", "mime_type_not_allowed", "fail", "Image MIME type is not allowed.", mime, allowed.join(", ")));
  if (input.detectedMimeType !== undefined) {
    const detected = input.detectedMimeType.toLowerCase();
    objective(detected === mime,
      reason("mime_type", "mime_type_matches_detection", "pass", "Declared and detected MIME types match.", detected),
      reason("mime_type", "mime_type_mismatch", "fail", "Declared and detected MIME types do not match.", `${mime} / ${detected}`));
  }

  const signals: QualitySignalResult[] = [];
  const addSignal = (name: QualitySignalName, threshold: number, applicable: boolean, test: (value: number) => boolean, passMessage: string, failMessage: string) => {
    if (!applicable) { signals.push({ name, status: "not_applicable", reason: "Signal is not applicable to this image." }); return; }
    const value = input.signals?.[name];
    if (value == null || !finite(value)) { signals.push({ name, status: "unavailable", reason: "No perceptual analyzer result is available." }); return; }
    const ok = test(value);
    signals.push({ name, status: ok ? "pass" : "fail", value, reason: ok ? passMessage : failMessage });
    void threshold;
  };
  addSignal("sharpness", t.minSharpness, true, (v) => v >= t.minSharpness, "Sharpness meets the proposed minimum.", "Image may be blurry.");
  addSignal("brightness", t.minBrightness, true, (v) => v >= t.minBrightness && v <= t.maxBrightness, "Brightness is within the proposed range.", "Image may be under- or over-exposed.");
  addSignal("legibility", t.minLegibility, true, (v) => v >= t.minLegibility, "Legibility meets the proposed minimum.", "Text/details may not be legible.");
  addSignal("face", t.minFaceQuality, input.appliesTo?.face === true, (v) => v >= t.minFaceQuality, "Face quality meets the proposed minimum.", "Face quality is insufficient.");
  addSignal("id", t.minIdQuality, input.appliesTo?.id === true, (v) => v >= t.minIdQuality, "ID quality meets the proposed minimum.", "ID quality is insufficient.");

  const objectivePassed = objectiveReasons.every((r) => r.outcome === "pass");
  const advancedNeedsReview = signals.some((s) => s.status === "unavailable");
  const advancedFailed = signals.some((s) => s.status === "fail");
  const advancedReasons = signals.map((s) => reason(`signal_${s.name}`, `signal_${s.name}_${s.status}`, s.status === "fail" ? "needs_review" : s.status === "unavailable" ? "needs_review" : "pass", s.reason, s.value));
  const allReasons = [...objectiveReasons, ...advancedReasons];
  return { decision: !objectivePassed ? "fail" : (advancedFailed || advancedNeedsReview) ? "needs_review" : "pass", objectivePassed, objectiveReasons, signals, reasons: allReasons };
}
