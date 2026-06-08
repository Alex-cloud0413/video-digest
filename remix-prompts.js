/**
 * REMIX PROMPTS
 *
 * These prompts transform YouTube transcripts into different written formats.
 * Edit the prompts below to customize how each remix style works.
 *
 * Each prompt receives:
 * - The video title
 * - The channel name
 * - The video description
 * - The full transcript
 *
 * The prompt should instruct Claude how to transform the content.
 */

const REMIX_PROMPTS = {

  // ============================================================
  // MAGAZINE ARTICLE
  // A polished, narrative-driven piece suitable for publication
  // ============================================================
  "magazine": {
    name: "Magazine Article",
    description: "Polished narrative piece with vivid storytelling",
    prompt: `Transform this YouTube video transcript into a compelling magazine article.

STYLE GUIDELINES:
- Write in a narrative, engaging style suitable for a quality publication like The Atlantic or Wired
- Open with a compelling hook that draws readers in
- Weave quotes naturally into the narrative (don't just list them)
- Add context and background where helpful
- Use vivid, descriptive language
- Break into sections with subheadings
- Include a strong conclusion that ties everything together
- Aim for 800-1200 words

STRUCTURE:
1. Engaging opening hook
2. Introduction of the main subject/thesis
3. Body sections exploring key themes
4. Memorable quotes woven throughout
5. Conclusion with takeaway

Do NOT:
- Write in a listicle format
- Include timestamps
- Sound like a summary or recap
- Use generic filler phrases

Write the article directly, no preamble.`
  },

  // ============================================================
  // BUSINESS BIOGRAPHY
  // Professional profile focusing on the person/company
  // ============================================================
  "biography": {
    name: "Business Biography",
    description: "Professional profile of the person or company featured",
    prompt: `Transform this YouTube video transcript into a business biography/profile piece.

STYLE GUIDELINES:
- Write in the style of a Harvard Business Review profile or Forbes feature
- Focus on the journey, decisions, and philosophy of the subject
- Highlight key turning points and lessons learned
- Include concrete examples and anecdotes
- Balance personal story with professional insights
- Show, don't just tell — use specific examples
- Aim for 800-1200 words

STRUCTURE:
1. Opening that captures who this person/company is
2. Origin story or background
3. Key challenges and how they were overcome
4. Philosophy and approach
5. Impact and what others can learn

Do NOT:
- Write a dry, Wikipedia-style biography
- Just summarize what was said
- Include timestamps
- Use bullet points (prose only)

Write the biography directly, no preamble.`
  },

  // ============================================================
  // NO-NONSENSE BRIEFING
  // Dense, actionable summary for busy executives
  // ============================================================
  "briefing": {
    name: "No-Nonsense Briefing",
    description: "Dense, actionable executive summary",
    prompt: `Transform this YouTube video transcript into an executive briefing document.

STYLE GUIDELINES:
- Write for a busy executive who needs information fast
- Be direct and concise — every sentence should earn its place
- Lead with the most important takeaways
- Use bullet points strategically for scanability
- Include specific data, names, and facts
- Highlight actionable insights
- No fluff, no filler, no unnecessary context
- Aim for 400-600 words

STRUCTURE:
## Bottom Line Up Front
[1-2 sentences: the single most important thing to know]

## Key Takeaways
[3-5 bullet points with the main insights]

## Notable Quotes
[2-3 direct quotes that capture key ideas]

## Context
[Brief background if needed]

## Action Items / Implications
[What to do with this information]

Do NOT:
- Include pleasantries or warm-up text
- Pad with obvious statements
- Include timestamps
- Bury the lead

Write the briefing directly, no preamble.`
  }

};

// Export for use in background.js
// (In a Chrome extension, we use a different pattern than Node.js modules)
