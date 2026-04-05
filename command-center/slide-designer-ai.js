const Anthropic = require("@anthropic-ai/sdk");
const anthropic = new Anthropic();

/**
 * Analyze slide content with Claude and return design instructions per slide.
 * One API call for the entire carousel.
 */
async function designSlides(slides, globalStyle, brand, designType, brandContext) {
  const slideList = slides.map((s, i) =>
    `Slide ${s.num || i + 1}: ${s.title ? `[${s.title}] ` : ""}${s.body || s.text || ""}`
  ).join("\n");

  // Parse font size hints from user style
  const lower = (globalStyle || "").toLowerCase();
  let fontHint = "";
  if (lower.includes("groot") || lower.includes("large") || lower.includes("big")) {
    fontHint = "\n**USER WANTS LARGE TEXT** — increase all font sizes by +12px from your default choice. Hero slides should be 64-72px.";
  } else if (lower.includes("klein") || lower.includes("small") || lower.includes("compact")) {
    fontHint = "\n**USER WANTS COMPACT TEXT** — use the lower end of font size ranges to fit more content.";
  } else if (lower.includes("medium")) {
    fontHint = "\n**USER WANTS MEDIUM TEXT** — use the middle of font size ranges.";
  }

  const bc = brandContext || {};
  const brandLines = [];
  if ((bc.colors || []).length) brandLines.push(`Colors: ${bc.colors.map(c => `${c.hex}${c.label ? ' (' + c.label + ')' : ''}`).join(', ')}`);
  if ((bc.fonts || []).length) brandLines.push(`Fonts: ${bc.fonts.map(f => `${f.family} (${f.role})`).join(', ')}`);

  const prompt = `You are an expert social media designer. Analyze the following carousel content and return design instructions as JSON.

## Brand: ${brand || "Generic"}
${brandLines.length ? '## Brand assets:\n' + brandLines.join('\n') : ''}
## Design type: ${designType || "instagram_post"}
## User style request: ${globalStyle || "default dark purple style"}${fontHint}

## Slide content:
${slideList}

## Your task
For each slide, determine the optimal visual layout and styling. Return a JSON array where each element has:

{
  "slideNumber": 1,
  "layout": "hero" | "bullets" | "quote" | "split" | "stats" | "cta",
  "title": "short title text or empty string",
  "titleSize": 18-28 (px, for the label/category above the main text),
  "bodyParts": [
    { "text": "line of text", "style": "normal" | "bold" | "highlight" | "dim" | "large" }
  ],
  "textAlign": "left" | "center",
  "verticalAlign": "center" | "top" | "bottom",
  "bodyFontSize": 32-72 (base font size in px — this is for a 1080px wide canvas, so text needs to be BIG to be readable on mobile. Short text = 56-72px, medium = 40-52px, long/bullets = 32-40px),
  "theme": "blockchain" | "cyberpunk" | "neon" | "finance" | "minimal" | "clean" | "default",
  "intensity": "subtle" | "normal" | "bold" | "intense",
  "accentGlow": "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center" | "spread",
  "colorOverride": null or a hex color string (only if the content suggests a specific color, e.g. red for danger/warning, green for growth),
  "dividerAfterTitle": true | false (visual line between title and body)
}

## Layout guide:
- "hero": One big statement. Large bold text, centered or left. For opening/closing slides or single powerful sentences.
- "bullets": Multiple points. Title + bullet list. For evidence, timelines, lists.
- "quote": Quoted text with attribution. Italic, border-left accent. For direct quotes.
- "split": Title on one side, body on the other or stacked with clear separation. For before/after, cause/effect.
- "stats": Big numbers or data points prominently displayed. For financial figures, percentages.
- "cta": Call-to-action. Centered, punchy, possibly with icon suggestion. For final slides.

## CRITICAL: Font size guide (canvas is 1080px wide, viewed on phones!)
- Short punchy text (< 80 chars) → bodyFontSize 56-72, layout "hero"
- Medium text (80-200 chars) → bodyFontSize 40-52
- Bullet lists (3-5 items) → bodyFontSize 32-40, layout "bullets"
- Long bullet lists (6+ items) → bodyFontSize 28-34
- Direct quotes → bodyFontSize 36-48, layout "quote"
- Stats/numbers → bodyFontSize 48-64 for the number, layout "stats"
- CTA slides → bodyFontSize 44-56, layout "cta"
- NEVER go below 28px — it becomes unreadable on Instagram
- titleSize should be 20-28px

## Rules:
- Slides with numbers/money → layout "stats", highlight the numbers
- Final "save/share" slides → layout "cta"
- Keep the theme consistent across slides unless the mood shifts dramatically
- Use "highlight" style sparingly — only for key words/phrases that should pop in the accent color
- The bodyParts array should contain the EXACT text from the input, split into logical visual lines. Do NOT rewrite the text.
- If the user specified style keywords (cyberpunk, neon, etc.), respect those as the base theme

Return ONLY the JSON array, no markdown, no explanation.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0]?.text || "[]";

  // Parse JSON from response (handle potential markdown wrapping)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error("[AI-DESIGNER] Failed to parse JSON:", text.substring(0, 200));
    return null;
  }

  try {
    const designs = JSON.parse(jsonMatch[0]);
    console.log(`[AI-DESIGNER] Generated ${designs.length} slide designs`);
    return designs;
  } catch (e) {
    console.error("[AI-DESIGNER] JSON parse error:", e.message);
    return null;
  }
}

module.exports = { designSlides };
