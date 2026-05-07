import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { WikiMarkdown } from "./WikiMarkdown";
import { CitationPanel } from "./CitationPanel";
import type { WikiPage, WikiCitation } from "@/lib/types";
import { wikiT } from "@/lib/wikiI18n";

interface QAPair {
  question: string;
  answer: string;
}

interface FaqSection {
  title: string;
  pairs: QAPair[];
}

interface ParsedFaq {
  preamble: string;
  sections: FaqSection[];
  trailer: string; // "Related pages" section and anything after the last ---
}

/**
 * Parse FAQ markdown into structured sections and Q&A pairs.
 * Expects the format produced by FAQ_PROMPT:
 *   ## Section Title
 *   **Q: question text**
 *   A: answer text [N]
 *   ---
 *
 * Tolerates ``null``/``undefined`` content so a page from the modular
 * pipeline (where the body lives in ``modules[]`` instead of a
 * top-level ``content`` string) does not crash the renderer.
 */
/** Walks the FAQ markdown line-by-line and extracts Q&A pairs grouped
 *  by the most recent heading. Tolerant of nested heading depths and
 *  mixed shapes (``**Q: ...** + A:`` form, ``### Question?`` form,
 *  ``**Question?**`` bold form). The caller renders each section as
 *  a chevron-collapsible card list — duplicate sections (same title)
 *  are merged so a wrapper-h2 followed by inner topic headings
 *  doesn't render the same Q&A cards twice.
 */
function parseFaqMarkdown(raw: string | null | undefined): ParsedFaq {
  if (!raw) {
    return { preamble: "", sections: [], trailer: "" };
  }
  // Strip leading h1 (title rendered separately)
  const content = raw.replace(/^#\s+[^\n]+\n*/, "");

  const lines = content.split("\n");

  // Phrases that indicate "this heading is a wrapper, not a topic" —
  // skip it as a section title so the rendered cards don't duplicate
  // every topic under both the wrapper AND its nested headings.
  const WRAPPER_RE = /^(frequently\s+asked\s+questions?|faqs?|q\s*&?\s*a)$/i;

  const sections: FaqSection[] = [];
  let preambleLines: string[] = [];
  let trailerLines: string[] = [];
  let trailerStarted = false;

  // Current state during the walk.
  let currentTitle: string | null = null;
  let currentPairs: QAPair[] = [];
  let currentBuffer: string[] = []; // body lines for the current heading
  let pendingQuestion: string | null = null;
  let pendingAnswerLines: string[] = [];

  const flushPendingQA = () => {
    if (pendingQuestion && pendingAnswerLines.length > 0) {
      const answer = pendingAnswerLines
        .join("\n")
        .replace(/^---\s*$/gm, "")
        .trim();
      if (answer) {
        currentPairs.push({ question: pendingQuestion, answer });
      }
    }
    pendingQuestion = null;
    pendingAnswerLines = [];
  };

  const flushSection = () => {
    flushPendingQA();
    // If the current heading wasn't recognised as having pending
    // bold-form Q&As, try the canonical ``**Q: text** / A:`` form
    // on the buffered body as a fallback.
    if (currentPairs.length === 0 && currentBuffer.length > 0) {
      const fromBuffer = parseQAPairs(currentBuffer.join("\n"));
      if (fromBuffer.length > 0) currentPairs = fromBuffer;
    }
    if (currentTitle !== null && currentPairs.length > 0) {
      // Merge with an existing same-title section (handles the
      // wrapper-h2 → topic-h2 duplication case).
      const existing = sections.find((s) => s.title === currentTitle);
      if (existing) {
        existing.pairs.push(...currentPairs);
      } else {
        sections.push({ title: currentTitle, pairs: currentPairs });
      }
    }
    currentTitle = null;
    currentPairs = [];
    currentBuffer = [];
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];

    // Heading detection — h2 or h3 starts a new section UNLESS it's
    // the FAQ wrapper phrase (then we just skip it without resetting
    // the section, so its body inherits the next real heading).
    const headingMatch = line.match(/^(#{2,4})\s+(.+?)\s*$/);
    if (headingMatch) {
      const title = headingMatch[2].trim();

      // Trailer: ``## Related pages`` / ``See also`` flips us into
      // trailer mode. Everything after goes into the raw trailer
      // string (renderers handle that as plain markdown).
      if (/related\s*pages?|see\s*also/i.test(title)) {
        flushSection();
        trailerStarted = true;
        trailerLines.push(line);
        continue;
      }
      if (trailerStarted) {
        trailerLines.push(line);
        continue;
      }

      // Wrapper phrase — drop the heading itself, keep collecting
      // children under the next real heading.
      if (WRAPPER_RE.test(title)) {
        flushSection();
        continue;
      }

      // Real topic heading — start a new section.
      flushSection();
      currentTitle = title;
      continue;
    }

    if (trailerStarted) {
      trailerLines.push(line);
      continue;
    }

    // Bold-form question (``**...?**``) — opens a new pending QA.
    const boldQMatch = line.match(/^\*\*([^*]+\?)\*\*\s*$/);
    if (boldQMatch && currentTitle !== null) {
      flushPendingQA();
      pendingQuestion = boldQMatch[1].trim();
      continue;
    }

    // Body line — either part of the answer to a pending bold-Q or
    // (when there's no pending Q) buffered for the
    // ``**Q: text** / A:`` fallback path.
    if (pendingQuestion !== null) {
      pendingAnswerLines.push(line);
    } else if (currentTitle !== null) {
      currentBuffer.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  flushSection();

  const preamble = preambleLines.join("\n").replace(/^---\s*$/gm, "").trim();
  const trailer = trailerLines.join("\n").trim();

  return { preamble, sections, trailer };
}

function parseQAPairs(body: string): QAPair[] {
  const pairs: QAPair[] = [];

  // Path A — canonical ``**Q: text** / A: answer`` form (FAQ_PROMPT
  // contract). Detected first so the legacy persistence keeps working.
  if (/\*\*Q:\s/.test(body)) {
    const blocks = body.split(/(?=\*\*Q:\s)/);
    for (const block of blocks) {
      const qMatch = block.match(/^\*\*Q:\s*([\s\S]*?)\*\*/);
      if (!qMatch) continue;
      const question = qMatch[1].replace(/\n/g, " ").trim();
      const rest = block.slice(qMatch[0].length).trim();
      const answer = rest
        .replace(/^\*\*A:\*\*\s*/m, "")
        .replace(/^A:\s*/m, "")
        .replace(/^---\s*$/gm, "")
        .trim();
      if (question && answer) {
        pairs.push({ question, answer });
      }
    }
    return pairs;
  }

  // Path B — ``### Question?\n\nAnswer paragraph`` form. Modern
  // prompts have drifted to emitting questions as h3 headings with
  // free-form prose underneath; without this path the FaqPage falls
  // through to plain markdown rendering and loses the card layout.
  // Each ``###`` h3 starts a new Q&A; everything until the next
  // ``###`` (or end of body) is the answer.
  if (/^###\s/m.test(body)) {
    const blocks = body.split(/(?=^###\s)/m);
    for (const block of blocks) {
      const qMatch = block.match(/^###\s+([^\n]+)\n([\s\S]*)/);
      if (!qMatch) continue;
      const question = qMatch[1].trim();
      const answer = qMatch[2]
        .replace(/^---\s*$/gm, "")
        .trim();
      if (question && answer) {
        pairs.push({ question, answer });
      }
    }
    return pairs;
  }

  // Path C — ``**Question?**\nAnswer paragraph`` form. Bold-prefixed
  // questions without the ``Q:`` marker. Each bold line that ends
  // with ``?`` starts a new pair; the prose until the next bold line
  // is the answer.
  if (/^\*\*[^*]+\?\*\*/m.test(body)) {
    const blocks = body.split(/(?=^\*\*[^*]+\?\*\*)/m);
    for (const block of blocks) {
      const qMatch = block.match(/^\*\*([^*]+\?)\*\*\s*\n?([\s\S]*)/);
      if (!qMatch) continue;
      const question = qMatch[1].trim();
      const answer = qMatch[2]
        .replace(/^---\s*$/gm, "")
        .trim();
      if (question && answer) {
        pairs.push({ question, answer });
      }
    }
    return pairs;
  }

  return pairs;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function QACard({ qa, citations }: { qa: QAPair; citations: WikiCitation[] }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden transition-all">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors group"
      >
        <span className="shrink-0 mt-0.5 text-primary transition-transform">
          {open
            ? <ChevronDown className="h-4 w-4" />
            : <ChevronRight className="h-4 w-4" />}
        </span>
        <span className="font-semibold text-foreground text-sm leading-snug">{qa.question}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 pt-2 border-t border-border/40 bg-muted/10">
          <WikiMarkdown content={qa.answer} citations={citations} />
        </div>
      )}
    </div>
  );
}

function FaqSection({ section, citations }: { section: FaqSection; citations: WikiCitation[] }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-foreground mt-6 mb-3 scroll-mt-6">
        {section.title}
      </h2>
      <div className="flex flex-col gap-2">
        {section.pairs.map((qa, i) => (
          <QACard key={i} qa={qa} citations={citations} />
        ))}
      </div>
    </section>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

interface FaqPageProps {
  page: WikiPage;
  onNavigate: (pageId: string) => void;
  lang?: string;
}

export function FaqPage({ page, onNavigate, lang }: FaqPageProps) {
  const { preamble, sections, trailer } = parseFaqMarkdown(page.content);

  return (
    <div>
      <h1 className="text-2xl font-bold text-foreground">{page.title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {wikiT(lang, "memoriesSuffix", { n: page.memory_count })}
      </p>

      {/* Preamble: chart + intro sentence */}
      {preamble && (
        <div className="mt-6">
          <WikiMarkdown content={preamble} citations={page.citations} onNavigate={onNavigate} />
        </div>
      )}

      {/* Q&A sections */}
      {sections.length > 0 ? (
        <div className="mt-2 divide-y divide-border/0">
          {sections.map((section, i) => (
            <div key={i}>
              <FaqSection section={section} citations={page.citations} />
              {i < sections.length - 1 && <hr className="border-border mt-6" />}
            </div>
          ))}
        </div>
      ) : page.content ? (
        /* Fallback: render as plain markdown if parsing finds no structured Q&As */
        <div className="mt-6">
          <WikiMarkdown content={page.content.replace(/^#\s+[^\n]+\n*/, "")} citations={page.citations} onNavigate={onNavigate} />
        </div>
      ) : (
        /* No structured Q&A AND no plain markdown body — happens when the
         * FAQ page exists in the page_store but compilation produced no
         * content (e.g., channel was too small to populate questions).
         * Render an honest empty state instead of a black screen. */
        <div className="mt-6 rounded-lg border border-dashed border-border bg-muted/10 px-6 py-10 text-center text-sm text-muted-foreground">
          No FAQ available yet — synced messages haven't produced enough Q&amp;A signal.
        </div>
      )}

      {/* Trailer: "Related pages" etc. */}
      {trailer && (
        <div className="mt-6">
          <hr className="border-border mb-6" />
          <WikiMarkdown content={trailer} citations={page.citations} onNavigate={onNavigate} />
        </div>
      )}

      <CitationPanel citations={page.citations} />
    </div>
  );
}
