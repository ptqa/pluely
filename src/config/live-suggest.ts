import type { SuggestionFamily } from "@/types";

export const LIVE_SUGGEST_FAMILIES: SuggestionFamily[] = [
  "insight",
  "risk",
  "question",
  "response",
  "action",
  "explanation",
  "decision",
  "opportunity",
];

/**
 * Build the strict-JSON output contract. The model invents situational category
 * labels while choosing one stable family so the UI can style cards reliably.
 */
export const buildLiveSuggestFormatInstructions = (): string => {
  const families = LIVE_SUGGEST_FAMILIES.map((family) => `"${family}"`).join(
    " | "
  );

  return `OUTPUT FORMAT — respond with STRICT JSON ONLY. No prose, no explanations, no markdown code fences. Output a JSON array of suggestion objects that react to the NEW lines only.

Each object has exactly these keys:
{
  "family": one of ${families},
  "category_id": "short snake_case id, 2-4 words, specific to this card",
  "category_label": "short visible label, 1-3 words",
  "title": a short heading, max ~6 words,
  "body": 1-3 sentences. You may use markdown for emphasis; bold the key term or phrase.
}

Write the user-facing card content (title and body) in the same dominant language as the conversation, preferring the language of the NEW lines. If the conversation is mixed-language, follow the user's latest language. Keep JSON keys and family values exactly as specified.

Choose the stable visual family by intent:
- insight: a useful observation, pattern, or takeaway.
- risk: something that may go wrong, be overstated, or need caution.
- question: a sharp question the user could ask.
- response: something concrete the user could say next.
- action: a task, owner, deadline, or next step worth capturing.
- explanation: a term, acronym, concept, or reference worth explaining.
- decision: a decision being made, needed, or drifting.
- opportunity: an opening to create value, advance the deal, or improve the outcome.

Invent category labels dynamically based on what is happening now. Be specific, not generic:
- Good: "Budget risk", "HIPAA overpromise", "Migration blocker", "Procurement signal", "Latency tradeoff".
- Bad: "Suggestion", "Important", "Note", "General".

Return 1 the most useful card. If nothing in the NEW lines is noteworthy, return [].`;
};
