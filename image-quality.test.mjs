// Hermetic Stage 2 image-quality contract tests. Pure evaluator: no DB, network, image
// decoder, perceptual dependency, dispatch, or completion integration.
const { evaluateImageQuality, IMAGE_QUALITY_DEFAULTS } = await import("./src/data/image-quality.ts");
const valid = { byteSize: 200_000, mimeType: "image/jpeg", detectedMimeType: "image/jpeg", width: 1920, height: 1080, signals: { sharpness: .8, brightness: .5, legibility: .9 }, appliesTo: {} };
const check = (name, value) => { if (!value) throw new Error(`FAIL: ${name}`); console.log(`ok - ${name}`); };
const codes = (r) => r.reasons.map((x) => x.code);
check("conservative defaults are named and configurable", IMAGE_QUALITY_DEFAULTS.minWidth === 1280 && IMAGE_QUALITY_DEFAULTS.maxBytes === 12 * 1024 * 1024 && IMAGE_QUALITY_DEFAULTS.minSharpness === .35);
check("valid objective file and available advanced signals pass", evaluateImageQuality(valid).decision === "pass");
{
  const r = evaluateImageQuality({ ...valid, width: 100 });
  check("dimension failure", r.decision === "fail" && codes(r).includes("dimensions_too_small") && !r.objectivePassed);
}
{
  const r = evaluateImageQuality({ ...valid, byteSize: 100 });
  check("minimum byte-size failure", r.decision === "fail" && codes(r).includes("byte_size_too_small"));
}
{
  const r = evaluateImageQuality({ ...valid, byteSize: IMAGE_QUALITY_DEFAULTS.maxBytes + 1 });
  check("maximum byte-size failure", r.decision === "fail" && codes(r).includes("byte_size_too_large"));
}
{
  const r = evaluateImageQuality({ ...valid, mimeType: "application/pdf" });
  check("MIME/type failure", r.decision === "fail" && codes(r).includes("mime_type_not_allowed"));
}
{
  const r = evaluateImageQuality({ ...valid, mimeType: "image/png", detectedMimeType: "image/jpeg" });
  check("detected MIME mismatch failure", r.decision === "fail" && codes(r).includes("mime_type_mismatch"));
}
{
  const r = evaluateImageQuality({ ...valid, signals: undefined });
  check("unavailable advanced signals require review, not rejection", r.decision === "needs_review" && r.signals.filter((s) => s.status === "unavailable").length === 3 && r.objectivePassed);
}
{
  const r = evaluateImageQuality({ ...valid, appliesTo: { face: true, id: true }, signals: { sharpness: .8, brightness: .5, legibility: .9 } });
  check("applicable unavailable face and ID require review", r.decision === "needs_review" && r.signals.find((s) => s.name === "face")?.status === "unavailable" && r.signals.find((s) => s.name === "id")?.status === "unavailable");
}
{
  const r = evaluateImageQuality({ ...valid, signals: { sharpness: .1, brightness: .5, legibility: .9 } });
  check("perceptual failure is distinct from objective rejection", r.decision === "needs_review" && r.objectivePassed && r.signals.find((s) => s.name === "sharpness")?.status === "fail");
}
{
  const r = evaluateImageQuality(valid);
  check("structured reasons include check outcome and actual/expected", r.reasons.every((x) => typeof x.code === "string" && typeof x.check === "string" && (x.outcome === "pass" || x.outcome === "fail" || x.outcome === "needs_review")) && r.objectiveReasons.some((x) => x.actual !== undefined && x.expected !== undefined));
}
{
  const completion = await Bun.file("./src/data/completion-core.ts").text();
  const photos = await Bun.file("./src/data/driver-photos-core.ts").text();
  check("no job-completion integration was added", !completion.includes("image-quality") && !photos.includes("image-quality"));
}
