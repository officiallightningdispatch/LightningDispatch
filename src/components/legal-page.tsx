import { Link } from "@tanstack/react-router";
import { Zap } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Lightning-branded legal/static page shell + a lightweight markdown renderer
 * for the owner-approved legal text. The markdown strings live in
 * src/lib/legal-content.ts and are the APPROVED VERBATIM wording — nothing here
 * rewrites or summarizes them. The renderer covers only the subset actually
 * used by the three documents: H1/H2 headings, paragraphs, bullet + ordered
 * lists, horizontal rules, bold/italic inline, and inline links.
 */

/* ------------------------- inline markdown -------------------------------- */

const INLINE_RE =
  /(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)/g;

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? last;
    if (idx > last) out.push(text.slice(last, idx));
    if (m[1] != null) {
      const href = m[3];
      if (href.startsWith("/")) {
        out.push(
          <Link key={idx} to={href as any} className="font-semibold text-brand-600 underline decoration-brand-300 underline-offset-2 hover:text-brand-700">
            {m[2]}
          </Link>,
        );
      } else {
        out.push(
          <a key={idx} href={href} target="_blank" rel="noreferrer" className="font-semibold text-brand-600 underline decoration-brand-300 underline-offset-2 hover:text-brand-700">
            {m[2]}
          </a>,
        );
      }
    } else if (m[4] != null) {
      out.push(
        <strong key={idx} className="font-semibold text-ink-900">
          {m[5]}
        </strong>,
      );
    } else if (m[6] != null) {
      out.push(<em key={idx}>{m[7]}</em>);
    }
    last = idx + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* --------------------------- block renderer -------------------------------- */

function renderBlock(block: string, key: number): ReactNode {
  const lines = block.split("\n");
  const first = lines[0];

  const heading = /^(#{1,6})\s+(.*)$/.exec(first);
  if (heading) {
    const level = heading[1].length;
    const children = renderInline(heading[2].trim());
    if (level === 1) {
      return (
        <h1 key={key} className="mb-6 text-3xl font-extrabold tracking-tight text-ink-900 sm:text-4xl">
          {children}
        </h1>
      );
    }
    return (
      <h2 key={key} className="mb-3 mt-8 text-xl font-bold tracking-tight text-ink-900 sm:text-2xl">
        {children}
      </h2>
    );
  }

  if (/^-{3,}$/.test(first.trim())) {
    return <hr key={key} className="my-8 border-ink-100" />;
  }

  if (/^[-*]\s+/.test(first)) {
    return (
      <ul key={key} className="mb-4 list-disc space-y-2 pl-6 text-[15px] leading-7 text-ink-700">
        {lines.map((line, i) => (
          <li key={i} className="pl-1">
            {renderInline(line.replace(/^[-*]\s+/, ""))}
          </li>
        ))}
      </ul>
    );
  }

  if (/^\d+\.\s+/.test(first)) {
    return (
      <ol key={key} className="mb-4 list-decimal space-y-2 pl-6 text-[15px] leading-7 text-ink-700">
        {lines.map((line, i) => (
          <li key={i} className="pl-1">
            {renderInline(line.replace(/^\d+\.\s+/, ""))}
          </li>
        ))}
      </ol>
    );
  }

  // Paragraph. The three documents use a single line per paragraph, except the
  // support "common questions" block, where a bold label line is followed by the
  // answer (separated by a hard break). Preserve those as a line break.
  return (
    <p key={key} className="mb-4 text-[15px] leading-7 text-ink-700">
      {lines.map((line, i) => (
        <span key={i}>
          {i > 0 ? <br /> : null}
          {renderInline(line.replace(/\s+$/, ""))}
        </span>
      ))}
    </p>
  );
}

/* ------------------------------ page shell -------------------------------- */

export function LegalPage({ markdown }: { markdown: string }) {
  const blocks = markdown.split(/\n{2,}/);
  return (
    <main className="grid min-h-dvh bg-canvas text-ink-900">
      <div className="mx-auto w-full max-w-3xl px-6 py-10 sm:py-16">
        <header className="mb-8">
          <Link to="/" className="inline-flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-2xl bg-brand-500">
              <Zap className="size-5 text-white" fill="currentColor" strokeWidth={0} aria-hidden="true" />
            </span>
            <strong className="text-lg tracking-tight text-ink-900">Lightning Dispatch OS</strong>
          </Link>
        </header>

        <article>{blocks.map((block, i) => renderBlock(block, i))}</article>

        <LegalLinks className="mt-10 border-t border-ink-100 pt-6" />
      </div>
    </main>
  );
}

/* --------------------------- discoverable links ---------------------------- */

export function LegalLinks({ className }: { className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-ink-400 ${className ?? ""}`}>
      <Link to="/privacy" className="transition-colors hover:text-ink-700">
        Privacy Policy
      </Link>
      <Link to="/terms" className="transition-colors hover:text-ink-700">
        Terms of Service
      </Link>
      <Link to="/support" className="transition-colors hover:text-ink-700">
        Support
      </Link>
    </div>
  );
}
