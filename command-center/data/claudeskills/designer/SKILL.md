---
name: designer
description: Create social media carousels, YouTube thumbnails, banners, and infographics. Use when the user asks to create, design, or generate visual content like carousel posts, thumbnails, banners, or infographic images for social media platforms (Instagram, LinkedIn, YouTube, Twitter/X).
---

# Content Creator / Designer Skill

## Overview

This skill creates professional visual content using the Command Center designer system (`/api/designer`).

Available engines (user selects via dropdown):
- **Nano Banana (Gemini)** — Google Gemini Flash Image Preview via inference.sh
- **Playwright** — Instant HTML-to-image rendering
- **Claude AI** — Claude Code with Canva MCP tools
- **Canva** — Direct Canva API

Supported content types:
1. **Banners** — Hero images, announcements, promo headers
2. **Carousels** — Multi-slide posts for Instagram/LinkedIn
3. **Thumbnails** — Eye-catching images for YouTube/social media
4. **Infographics** — Data-driven visuals with stats and callouts

## When to Use

Activate this skill when the user:
- Asks to create a carousel, thumbnail, banner, or infographic
- Wants social media visuals for their brand
- Says "maak een carousel", "create a thumbnail", "design a banner"
- Needs visual content for marketing, education, or social posts

## Brand Guidelines

Always apply the active brand identity from `brand.json` (loaded via the Command Center). If specific brand colors and fonts are not available, ask the user or default to:

| Element | Default |
|---------|-------|
| **Background** | Dark / Black |
| **Body font** | Inter or system sans-serif |
| **Display font** | A bold display face for titles only |
| **Tone** | Professional, modern, on-brand |
| **Mode** | Match the brand (light or dark) |

Never hardcode colors — read them from the active brand configuration.

## Content Type Specifications

### 1. Banners / Hero Images
**Format:** 1280x720px (16:9)
- Bold headline, supporting text, strong visual
- Brand accent colors for emphasis

### 2. Carousels (Instagram/LinkedIn)
**Format:** 1080x1080px or 1080x1350px
**Slides:** 5-10 typical
- Slide 1: Bold hook/title
- Slides 2-8: One key point per slide, max 30 words
- Final slide: CTA with website URL

### 3. Thumbnails (YouTube/Social)
**Format:** 1280x720px (16:9)
- Bold title text (max 5-6 words), readable at small sizes
- High contrast, emotional hooks

### 4. Infographics
**Format:** 1080x1920px (story) or 1080x1350px (post)
- Data hierarchy: biggest stat = biggest text
- 3-5 sections with icons and stats

## Instructions

### Step 1: Determine Content Type
Ask (if not clear): type, platform, topic, specific text/data to include

### Step 2: Plan the Content
Draft text content and present to user for approval before generating

### Step 3: Generate via Command Center
The design is submitted through the Command Center designer UI at `/designer.html`. The selected engine handles generation.

### Step 4: Deliver
Share the result link, offer variations or additional sizes
