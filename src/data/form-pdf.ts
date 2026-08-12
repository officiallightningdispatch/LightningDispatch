/**
 * Official-form PDF generator — SERVER-ONLY (never imported from a
 * client-reachable module; the client bundle must not follow this file).
 *
 * The completed W-9 / I-9 records are stored as PDFs in the private B2 bucket
 * (ld-docs). Rather than trying to fill the official AcroForms (USCIS/IRS
 * ship XFA/smart forms that pdf-lib-class filling handles poorly), this module
 * renders a FAITHFUL, deterministic replica of the official form — the same
 * field layout, OMB numbers and edition line — with the contractor's values
 * stamped in. The output is a real single/multi-page PDF (letter, standard
 * fonts, no external deps) that the owner can open, print, or file.
 *
 * The BLANK official PDFs are committed at public/forms/{i9,w9}.pdf
 * (downloaded 2026-08-12 — I-9 edition 08/01/23, OMB 1615-0047; W-9
 * Rev. March 2024, OMB 1545-0224) and linked from the driver UI as
 * "download the blank form" references. The generated completed PDFs carry
 * the same OMB/edition identifiers so the record maps to the official form.
 *
 * Testability: pure functions, hermetic — call buildW9Pdf/buildI9Pdf with
 * values, assert the bytes start with %PDF and contain the stamped values.
 */

export type W9PdfValues = {
  name: string;
  businessName: string;
  taxClassification: "individual" | "c_corp" | "s_corp" | "partnership" | "trust_estate" | "llc" | "other";
  llcTaxClass: "c" | "s" | "p" | "other";
  otherDescription: string;
  payeeCode: string;
  exemptionCode: string;
  fatcaCode: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  accountNumbers: string;
  requesterName: string;
  requesterAddress: string;
  taxIdType: "ssn" | "ein";
  taxId: string;
  signature: string;
  date: string;
};

export type I9IdentityDocPdf = {
  list: "A" | "B" | "C";
  title: string;
  issuingAuthority: string;
  number: string;
  expiration: string;
};

export type I9PdfValues = {
  lastName: string;
  firstName: string;
  middleInitial: string;
  otherNames: string;
  address: string;
  apt: string;
  city: string;
  state: string;
  zip: string;
  dob: string;
  ssn: string;
  email: string;
  phone: string;
  citizenship: "citizen" | "noncitizen_national" | "lpr" | "noncitizen_authorized";
  alienNumber: string;
  uscisNumber: string;
  i94Number: string;
  i94Expiration: string;
  signature: string;
  date: string;
  identityDocs: I9IdentityDocPdf[];
};

export type I9Section2Pdf = {
  docs: I9IdentityDocPdf[];
  repName: string;
  repTitle: string;
  orgName: string;
  date: string;
};

const W = 612;
const H = 792;
const ML = 54;
const RIGHT = W - 54;

/** Map a Unicode code point to its WinAnsi (CP1252) byte; null = unmappable. */
const WINANSI = new Map<number, number>([
  [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95],
  [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a],
  [0x203a, 0x9b], [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f], [0x20ac, 0x80],
  [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e],
]);

/** PDF string-literal safe, WinAnsi-encoded text (never throws; unmappable
 *  chars degrade to '?' — a filled form field is never allowed to corrupt the
 *  file). */
function pdfText(s: string): string {
  let out = "";
  for (const ch of String(s ?? "")) {
    const c = ch.codePointAt(0) ?? 0x3f;
    if (c === 0x28 || c === 0x29 || c === 0x5c) { out += "\\" + ch; continue; }
    if (c >= 0x20 && c <= 0x7e) { out += ch; continue; }
    if (c >= 0xa0 && c <= 0xff) { out += ch; continue; }
    const b = WINANSI.get(c);
    out += b != null ? String.fromCharCode(b) : "?";
  }
  return out;
}

class PdfBuilder {
  private pages: string[][] = [[]];
  private y = TOP;
  private cur = 0;

  private ops(...ops: string[]) { this.pages[this.cur].push(...ops); }

  /** Write text at the current cursor (or explicit x/y). Returns the new y. */
  text(s: string, opts: { x?: number; y?: number; size?: number; bold?: boolean } = {}): number {
    const size = opts.size ?? 9;
    const font = opts.bold ? "/F2" : "/F1";
    const x = opts.x ?? ML;
    const y = opts.y ?? this.y - size;
    this.ops(`BT ${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfText(s)}) Tj ET\n`);
    return y;
  }

  /** A labeled field row: small label above, value with an underline. */
  field(label: string, value: string, opts: { x?: number; y?: number; labelSize?: number; valueSize?: number; width?: number; labelAbove?: boolean } = {}): number {
    const x = opts.x ?? ML;
    const valueSize = opts.valueSize ?? 9.5;
    const y = opts.y ?? this.y - (opts.labelAbove === false ? valueSize + 2 : valueSize + 12);
    this.text(label, { x, y: y + valueSize + 2, size: opts.labelSize ?? 6.5, bold: true });
    const v = pdfText(value || " ");
    this.text(v, { x, y, size: valueSize });
    const w = opts.width ?? Math.min(240, Math.max(60, v.length * valueSize * 0.52 + 8));
    this.hline(y - 2, x, x + w);
    return y;
  }

  /** Horizontal rule (stroke). */
  hline(y: number, x1 = ML, x2 = RIGHT) {
    this.ops(`${x1} ${y} m ${x2} ${y} l S\n`);
  }

  /** Rectangle: outline (default) or filled. */
  box(x: number, y: number, w: number, h: number, fill = false) {
    this.ops(`${x} ${y} ${w} ${h} re ${fill ? "f" : "S"}\n`);
  }

  /** A checkbox square with an X when checked. */
  check(x: number, y: number, checked: boolean, size = 9) {
    this.box(x, y, size, size);
    if (checked) {
      this.ops(`${x + 1.5} ${y + 1.5} m ${x + size - 1.5} ${y + size - 1.5} l S\n`);
      this.ops(`${x + size - 1.5} ${y + 1.5} m ${x + 1.5} ${y + size - 1.5} l S\n`);
    }
  }

  /** Advance the cursor down by n points. */
  gap(n: number) { this.y -= n; }

  /** True if the cursor is below the bottom margin (caller then pageBreaks). */
  get needsBreak() { return this.y < 90; }

  pageBreak() {
    this.pages.push([]);
    this.cur += 1;
    this.y = TOP;
  }

  build(): Uint8Array {
    const objs: string[] = [];
    const add = (body: string) => { objs.push(body); return objs.length; };
    // 1) content streams
    const contents: number[] = [];
    for (const ops of this.pages) {
      const stream = ops.join("");
      contents.push(add(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`));
    }
    // 2) fonts
    const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    // 3) page objects
    const pageRefs = contents.map((c, i) =>
      add(`<< /Type /Page /Parent 3 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
    // 4) pages tree + catalog
    add(`<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(" ")}] /Count ${pageRefs.length} >>`);
    add("<< /Type /Catalog /Pages 3 0 R >>");
    // 5) serialize with xref
    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    const emit = (body: string) => {
      offsets.push(out.length);
      out += `${objs.length - objs.length + offsets.length} 0 obj\n${body}\nendobj\n`;
    };
    // objects must be emitted in the SAME order they were added
    for (const body of objs) emit(body);
    const xrefStart = out.length;
    out += `xref\n0 ${objs.length + 1}\n`;
    out += "0000000000 65535 f \n";
    for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${offsets.length} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    return new TextEncoder().encode(out);
  }
}

const TOP = 736;

/** Standard form header — department line, form title, OMB/edition line. */
function formHeader(b: PdfBuilder, opts: { title: string; subtitle: string; right: string; omb: string; edition: string }) {
  b.text(opts.subtitle, { x: ML, y: 736, size: 8.5 });
  b.text(opts.right, { x: 300, y: 736, size: 8.5 });
  b.text(opts.title, { x: ML, y: 712, size: 14, bold: true });
  b.text(`${opts.omb}  ${opts.edition}`, { x: ML, y: 697, size: 7 });
  b.hline(688, ML, RIGHT);
  b.y = 668;
}

/* ------------------------------------------------------------------ */
/*  W-9 (Rev. March 2024) — one page, all official fields             */
/* ------------------------------------------------------------------ */

export function buildW9Pdf(v: W9PdfValues): Uint8Array {
  const b = new PdfBuilder();
  formHeader(b, {
    subtitle: "Form W-9 (Rev. March 2024)",
    right: "Department of the Treasury\nInternal Revenue Service",
    title: "Request for Taxpayer Identification Number and Certification",
    omb: "OMB No. 1545-0224",
    edition: "Expires 01/31/2027",
  });
  b.text("Go to www.irs.gov/FormW9 for instructions and the latest information.", { size: 7.5 });

  // 1. Name
  b.field("1. Name (as shown on your income tax return). Name is required on this line; do not leave this line blank.", v.name, { width: 504 });
  b.gap(14);
  // 2. Business name
  b.field("2. Business name/disregarded entity name, if different from above", v.businessName, { width: 504 });
  b.gap(14);
  // 3. Federal tax classification
  b.text("3. Federal tax classification", { size: 6.5, bold: true, y: b.y });
  b.y -= 12;
  const taxOpts: Array<[W9PdfValues["taxClassification"], string]> = [
    ["individual", "Individual/sole proprietor or single-member LLC"],
    ["c_corp", "C Corporation"], ["s_corp", "S Corporation"], ["partnership", "Partnership"],
    ["trust_estate", "Trust/estate"],
  ];
  for (const [k, label] of taxOpts) {
    b.check(ML, b.y - 8, v.taxClassification === k);
    b.text(label, { x: ML + 13, y: b.y, size: 8.5 });
    b.y -= 14;
  }
  if (v.taxClassification === "llc") {
    b.text("Limited liability company. Enter the tax classification (C=C corporation, S=S corporation, P=Partnership)", { size: 7.5, y: b.y });
    b.y -= 11;
    const llcOpts: Array<[W9PdfValues["llcTaxClass"], string]> = [
      ["c", "C"], ["s", "S"], ["p", "P"], ["other", "Disregarded entity (specify below)"],
    ];
    for (const [k, label] of llcOpts) {
      b.check(ML, b.y - 8, v.llcTaxClass === k);
      b.text(label, { x: ML + 13, y: b.y, size: 8.5 });
      b.y -= 14;
    }
    b.y -= 2;
    b.field("Other (specify)", v.otherDescription, { width: 300 });
    b.gap(12);
  } else {
    b.gap(8);
  }
  // 4. Exemptions
  b.text("4. Exemptions (codes apply only to certain entities, not individuals; see instructions)", { size: 6.5, bold: true, y: b.y });
  b.y -= 11;
  b.field("Payee code", v.payeeCode, { x: ML, width: 120 });
  b.field("Exemption code (if any)", v.exemptionCode, { x: 230, width: 120 });
  b.field("FATCA filing requirement code (if any)", v.fatcaCode, { x: 406, width: 150 });
  b.gap(16);
  // 5-6. Address
  b.field("5. Address (number, street, and apt. or suite no.)", v.address, { width: 504 });
  b.gap(14);
  b.field("6. City, state, and ZIP code", `${[v.city, v.state].filter(Boolean).join(", ")} ${v.zip}`.trim(), { width: 504 });
  b.gap(14);
  // 7-8
  b.field("7. Account number(s) (see instructions)", v.accountNumbers, { width: 240 });
  b.field("8. Requester's name and address (optional)", v.requesterName ? `${v.requesterName} — ${v.requesterAddress}`.trim() : v.requesterAddress, { x: 330, width: 228 });
  b.gap(16);
  b.hline(b.y);
  b.y -= 4;
  // Part I
  b.text("Part I  Taxpayer Identification Number (TIN)", { size: 8, bold: true, y: b.y });
  b.y -= 10;
  b.text("Enter your TIN in the appropriate box. The TIN provided must match the name given on line 1 to avoid backup withholding.", { size: 7, y: b.y });
  b.y -= 12;
  b.check(ML, b.y - 8, v.taxIdType === "ssn");
  b.text("Social security number", { x: ML + 12, y: b.y, size: 8.5 });
  b.check(200, b.y - 8, v.taxIdType === "ein");
  b.text("Employer identification number", { x: 212, y: b.y, size: 8.5 });
  b.y -= 16;
  const tin = v.taxIdType === "ssn" && /^\d{9}$/.test(v.taxId)
    ? `${v.taxId.slice(0, 3)}-${v.taxId.slice(3, 5)}-${v.taxId.slice(5)}`
    : v.taxIdType === "ein" && /^\d{9}$/.test(v.taxId)
      ? `${v.taxId.slice(0, 2)}-${v.taxId.slice(2)}`
      : v.taxId;
  b.text(tin, { x: ML, y: b.y, size: 12 });
  b.box(ML, b.y - 2, 190, 16);
  b.y -= 26;
  b.hline(b.y);
  b.y -= 4;
  // Part II
  b.text("Part II  Certification", { size: 8, bold: true, y: b.y });
  b.y -= 10;
  b.text("Under penalties of perjury, I certify that: 1. The number shown on this form is my correct taxpayer identification number (or I am waiting for a number to be issued to me), and 2. I am not subject to backup withholding because: (a) I am exempt from backup withholding, or (b) I have not been notified by the Internal Revenue Service (IRS) that I am subject to backup withholding as a result of a failure to report all interest or dividends, or (c) the IRS has notified me that I am no longer subject to backup withholding, and 3. I am a U.S. citizen or other U.S. person (defined below).", { size: 7.5, y: b.y });
  b.y -= 40;
  b.field("Signature (of U.S. person)", v.signature, { width: 250 });
  b.field("Date", v.date, { x: 330, width: 100 });
  b.gap(4);
  b.text("The IRS does not require your consent to any provision of this document other than the certifications required to proceed.", { size: 6.5, y: b.y });
  b.y -= 12;
  b.text("Privacy Act Notice: For information on our privacy policy and the routine uses of your information, see the instructions for Form W-9.", { size: 6.5, y: b.y });
  return b.build();
}

/* ------------------------------------------------------------------ */
/*  Form I-9 (edition 08/01/23) — Section 1 + Section 2               */
/* ------------------------------------------------------------------ */

function i9Section1(b: PdfBuilder, v: I9PdfValues) {
  b.text("SECTION 1. Employee Information and Attestation (employees must complete and sign Section 1 on or before their first day of employment)", { size: 6.5, bold: true, y: b.y });
  b.y -= 10;
  b.field("Last Name (Family Name)", v.lastName, { x: ML, width: 160 });
  b.field("First Name (Given Name)", v.firstName, { x: 226, width: 160 });
  b.field("Middle Initial", v.middleInitial, { x: 398, width: 60 });
  b.gap(14);
  b.field("Other Last Names Used (if any)", v.otherNames, { width: 504 });
  b.gap(14);
  b.field("Address (Street Number and Name)", v.address, { x: ML, width: 250 });
  b.field("Apt. Number", v.apt, { x: 330, width: 90 });
  b.gap(14);
  b.field("City or Town", v.city, { x: ML, width: 140 });
  b.field("State", v.state, { x: 210, width: 60 });
  b.field("ZIP Code", v.zip, { x: 290, width: 80 });
  b.gap(14);
  b.field("Date of Birth (mm/dd/yyyy)", v.dob, { x: ML, width: 120 });
  b.field("U.S. Social Security Number (optional)", v.ssn, { x: 250, width: 140 });
  b.gap(14);
  b.field("Email Address", v.email, { x: ML, width: 240 });
  b.field("Telephone Number", v.phone, { x: 330, width: 140 });
  b.gap(16);
  b.hline(b.y);
  b.y -= 4;
  b.text("Attestation: Select ONE of the following four radio buttons. (You may select only one.)", { size: 7, y: b.y });
  b.y -= 12;
  const att = (y: number, checked: boolean, label: string) => {
    b.check(ML, y - 8, checked);
    b.text(label, { x: ML + 13, y, size: 8.5 });
  };
  att(b.y, v.citizenship === "citizen", "1. A citizen of the United States");
  b.y -= 14;
  att(b.y, v.citizenship === "noncitizen_national", "2. A noncitizen national of the United States");
  b.y -= 14;
  att(b.y, v.citizenship === "lpr", "3. A lawful permanent resident (Alien Registration Number/USCIS Number):");
  if (v.citizenship === "lpr") {
    b.field("Alien Registration Number/USCIS Number", v.alienNumber, { x: 350, width: 208, labelAbove: false });
    b.y -= 14;
  }
  b.y -= 4;
  att(b.y, v.citizenship === "noncitizen_authorized", "4. A noncitizen authorized to work until (expiration date, if applicable, mm/dd/yyyy):");
  if (v.citizenship === "noncitizen_authorized") {
    b.field("Form I-94 Admission Number", v.i94Number, { x: 230, width: 130, labelAbove: false });
    b.field("Expiration Date (if any)", v.i94Expiration, { x: 390, width: 100, labelAbove: false });
    b.y -= 14;
    b.field("USCIS Number", v.uscisNumber, { x: 230, width: 130, labelAbove: false });
    b.y -= 12;
  }
  b.gap(8);
  b.field("Employee's Signature", v.signature, { width: 250 });
  b.field("Date (mm/dd/yyyy)", v.date, { x: 330, width: 120 });
  b.gap(6);
  b.text("I attest, under penalty of perjury, that I am (check one of the above). I understand that the information I provide on this form must be true and correct, and that I may be held liable, including under criminal penalties, if I knowingly provide false information.", { size: 6.5, y: b.y });
}

function i9Section2(b: PdfBuilder, s2: I9Section2Pdf) {
  b.text("SECTION 2. Employer or Authorized Representative Review and Verification (employers or their authorized representatives must complete and sign Section 2 within 3 business days after the employee begins employment)", { size: 6.5, bold: true, y: b.y });
  b.y -= 10;
  b.text("Examine one document from List A OR examine a combination of one document from List B and one document from List C, as listed on the \"LISTS OF ACCEPTED DOCUMENTS\" page. Provide the Document Title, Issuing Authority, Document Number, and Expiration Date (if any) for each document.", { size: 7, y: b.y });
  b.y -= 16;
  for (const d of s2.docs) {
    b.field(`List ${d.list}: ${d.title}`, d.number, { x: ML, width: 200 });
    b.field("Issuing Authority", d.issuingAuthority, { x: 270, width: 140 });
    b.field("Expiration Date (if any)", d.expiration, { x: 430, width: 130 });
    b.gap(14);
  }
  b.gap(6);
  b.hline(b.y);
  b.y -= 4;
  b.text("Certification: I attest, under penalty of perjury, that (1) I have examined the document(s) presented by the above-named employee, (2) the above-listed document(s) appear to be genuine and to relate to the employee named, and (3) to the best of my knowledge the employee is authorized to work in the United States.", { size: 7, y: b.y });
  b.y -= 24;
  b.field("Employer's or Authorized Representative's Signature", s2.repName, { width: 250 });
  b.field("Date (mm/dd/yyyy)", s2.date, { x: 330, width: 120 });
  b.gap(14);
  b.field("Name of Employer or Organization", s2.orgName, { width: 250 });
  b.field("Title of Employer or Authorized Representative", s2.repTitle, { x: 330, width: 220 });
  b.gap(8);
  b.text("NOTE: If the employee's List B document has an expiration date, the employer must re-verify the employee's authorization to work before the document expires.", { size: 6.5, y: b.y });
}

export function buildI9Pdf(v: I9PdfValues, section2?: I9Section2Pdf): Uint8Array {
  const b = new PdfBuilder();
  formHeader(b, {
    subtitle: "Form I-9, Employment Eligibility Verification",
    right: "Department of Homeland Security\nU.S. Citizenship and Immigration Services",
    title: "Employment Eligibility Verification",
    omb: "OMB No. 1615-0047",
    edition: "Edition 08/01/23",
  });
  b.text("START HERE: Read instructions carefully before completing this form. The instructions must be available during completion of this form. Employers are liable for failing to properly complete, retain, and present Form I-9.", { size: 7, y: b.y });
  b.y -= 12;
  i9Section1(b, v);
  if (section2) {
    b.pageBreak();
    b.gap(46);
    i9Section2(b, section2);
  } else {
    if (b.needsBreak) b.pageBreak();
    b.y = Math.min(b.y, 700);
    b.gap(8);
    b.text("Section 2 (Employer or Authorized Representative Review and Verification) is completed by the owner after reviewing the employee's identity documents.", { size: 7, y: b.y });
  }
  return b.build();
}
