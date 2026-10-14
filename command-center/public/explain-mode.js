// Explain mode: a switch under every page title. When on, the page shows a short guide
// (what the tool is for, how to use it, tips) and small hints under the form fields.
// Loaded by sidebar.js on every page. Guides are per page, and per tab where a page has tabs.
(function () {
  if (window.__ccExplain) return;
  window.__ccExplain = true;

  const KEY = 'cc_explain';
  const page = location.pathname.split('/').pop() || 'index.html';

  // ── Guides ──────────────────────────────────────────────────────────────────
  // steps: how to use it. tips: good to know. hints: [selector, text] shown under a field.
  // An entry starting with '!' is owner-only (hidden for team users).
  const GUIDES = {
    'index.html': {
      title: 'Overview',
      intro: 'Your home screen: one card per agent with what it did today, what is queued and whether anything failed.',
      steps: [
        'Scan the agent cards: the status dot and counters show if an agent is busy, idle or has errors.',
        'Click a card to jump to that tool (Designer, Content Creator, Scheduler, Social Media Manager, Marketing).',
        'Use the bell in the sidebar for notifications: finished jobs, failures and alerts.',
      ],
      tips: [
        'Numbers refresh on their own; a hard refresh (Ctrl+Shift+R) reloads everything.',
        'Want something to run automatically? Plan it in the Scheduler.',
      ],
    },

    'agents.html': {
      title: 'Scheduler',
      intro: 'Everything that runs on its own: planned agent tasks, always-on jobs (autopilots, rules, the post publisher) and the history of what they delivered.',
      steps: [
        'Click "+ New Schedule", pick an agent and fill in what it should do (focus, topics, language, sizes…).',
        'Choose the days and time. Times without a timezone run in UTC.',
        'Save. The card shows the next run; "▶ Run" starts it right away, "Dry run" (where offered) tests without spending credits.',
        'Use Pause/Enable to stop a schedule without deleting it.',
        'Task History at the bottom shows every run with its result; filter on Completed or Failed.',
      ],
      tips: [
        'Always-on jobs (X autopilot, weekly review, ads rules, post publisher) are listed separately; pause an autopilot from its card.',
        'Most agents can notify you on Telegram when they finish. Turn on "Notify via Telegram" for that.',
      ],
    },

    'designer.html': {
      title: 'Designer',
      intro: 'Creates images for social posts, ads, thumbnails, banners and more. Describe what you want and an AI image engine designs it.',
      steps: [
        'Pick a Design Type (it sets the size) and a Mode: generate a new design, or edit an existing image.',
        'Choose an Engine. Nano Banana is the best all-rounder and handles text well; Higgsfield is strong for photo-real people and faces; Playwright is instant for simple text layouts.',
        'Optionally set Style, Color Scheme and whether text should be rendered on the image.',
        'Write the Description: subject, setting, mood and the exact text if any (put text in quotes).',
        'Add Reference Images (a face, a product, a logo) or pick them from the Reference library, then press Submit.',
        'The result appears in Design Tasks below. Click it to view full size, download it, or use it as the source for an edit.',
      ],
      tips: [
        'Edit mode: the first reference image is the picture that gets reworked. Describe only the change ("make the background dark purple").',
        'Save faces, outfits, products and logos you use often in the Reference library, so you only have to click them next time.',
        'Use "Avoid" for things that keep showing up but should not (e.g. extra text, people, clutter).',
        'Designs you make here can be used as a reference in Content Creator → AI Generate ("From Designer").',
        '!"Educational post now" researches a popular educational topic and designs a ready-to-post carousel (takes 2 to 4 minutes).',
      ],
      hints: [
        ['#design-type', 'Sets the output size. "Custom size" lets you type any width × height.'],
        ['#design-mode', 'Edit = rework the first reference image instead of starting from scratch.'],
        ['#design-engine', 'Nano Banana: best all-rounder + text. Higgsfield: photo-real people, can make 4 variants. Playwright: instant, layout-only.'],
        ['#design-text-mode', '"No text at all" is best when you add text yourself later.'],
        ['#design-aspect', 'Leave on Auto to use the size of the chosen design type.'],
        ['#design-reference-mode', 'Subject: keep the same face/product. Style: copy the look and composition only.'],
        ['#design-desc', 'Be specific: who/what, where, light, mood, camera angle. Put exact text in "quotes".'],
        ['#design-negative', 'Comma-separated list of things that must not appear.'],
      ],
    },

    'content-creator.html': {
      title: 'Content Creator',
      intro: 'Makes videos and audio: talking avatars, AI video from a prompt, voice-overs, dubbing, AI influencer swaps and short clips from long videos.',
      steps: [
        'Pick a tab at the top. Each tab is its own tool; the guide below changes with it.',
        'Results appear under the form of that tab and keep running when you leave the page.',
      ],
      tips: [
        'The yellow price next to a button is an estimate before you start; finished items show what they actually cost.',
      ],
      tab: () => (document.querySelector('.mode-tab.active') || {}).dataset?.mode,
      watch: '.mode-tabs',
      tabs: {
        ugc: {
          title: 'UGC Video',
          intro: 'Short "user generated content" style videos: animate a photo, or let an avatar speak a script.',
          steps: [
            'Choose Clip (a still image becomes a moving video) or Talking Avatar (a face speaks your script).',
            'Clip: give an image (URL or upload), describe the motion in the prompt, and pick engine, model, duration and resolution.',
            'Talking Avatar: pick a saved avatar (or describe a face), write the script, choose a voice and emotion.',
            'Press Submit. The video appears in the queue below; Talking Avatar videos get burned-in captions.',
          ],
          tips: [
            'Talking Avatar via Higgsfield Speak is limited to about 15 seconds of speech, so keep the script short (about 40 words).',
            'Make reusable faces in the Avatar Creator tab; they then appear in the avatar list here.',
          ],
          hints: [
            ['#ugc-image', 'The start frame. A clear, well-lit photo gives the best motion.'],
            ['#ugc-engine', 'DoP has ready-made camera motions; Kling, MiniMax and Seedance follow your prompt.'],
            ['#ugc-script', 'Write it like you speak it. Short sentences sound most natural.'],
            ['#ugc-scene-prompt', 'Optional: body language and setting, e.g. "relaxed, talking to camera, living room".'],
          ],
        },
        avatars: {
          title: 'Avatar Creator',
          intro: 'Your library of reusable faces for Talking Avatar, AI Influencer and the UGC autopilot.',
          steps: [
            'Give the avatar a name and describe the face, then press Create Avatar. Or upload an existing photo of an avatar.',
            'Set the gender when uploading; it decides which voices fit.',
            'New avatars appear in the Avatar Library and are then selectable in the other tabs.',
          ],
          tips: [
            'A neutral background, soft light and a face looking at the camera work best.',
            '!The "autopilot on/off" button on an avatar decides whether the UGC autopilot may use it.',
          ],
        },
        voiceover: {
          title: 'Voiceover',
          intro: 'Turns text into spoken audio with a realistic AI voice.',
          steps: [
            'Write the script, choose the engine, the voice, an emotion and the speed.',
            'Press Generate Voiceover. The audio file appears in the list below to play or download.',
          ],
          tips: [
            'Voiceovers you make here can be used as the audio track in Video Tools → Lipsync.',
            'Punctuation matters: commas and full stops create natural pauses.',
          ],
        },
        aigen: {
          title: 'AI Generate',
          intro: 'Generates a video from a text prompt, optionally guided by reference images or a source video.',
          steps: [
            'Pick a model. The label tells you what it is good at (quality, speed, native audio, editing an existing clip).',
            'Choose aspect ratio (9:16 for Reels/TikTok, 16:9 for YouTube), duration, resolution and whether you want audio.',
            'Describe the video: subject, action, camera movement, style, light and mood.',
            'Optionally add reference images (upload or "From Designer") or a source video for models that extend or edit a clip.',
            'Press Generate Video. The result shows up in the list below, usually within a few minutes.',
          ],
          tips: [
            'Higher resolution and longer duration cost more; check the estimate before you start.',
            'Some models refuse reference images with people in them; the "Studio" Seedance variants are made for that.',
            'Results from Video Tools (dubbing, translating) also land in this list.',
          ],
          hints: [
            ['#ai-model', 'Not every model supports every option; unsupported choices are disabled.'],
            ['#ai-prompt', 'One clear scene per video works best. Describe the camera ("slow push-in", "handheld").'],
          ],
        },
        influencer: {
          title: 'AI Influencer',
          intro: 'Takes an existing video and puts your AI influencer in it: copy the motion of the video, or swap a person/object.',
          steps: [
            'Choose Motion (your influencer performs the movement of the reference video) or Swap (replace someone or something in the video).',
            'Upload the reference video or paste a link (TikTok, Instagram, X, YouTube). At least 4 seconds; only the first 30 seconds are used.',
            'Add 1 to 8 images of your influencer, or pick saved avatars.',
            'Optionally write a prompt (e.g. "keep the background, she wears a black hoodie"), choose a resolution and press Generate.',
          ],
          tips: [
            'Cost depends on the length of the input video and the resolution; the estimate is shown next to the button.',
            'Failed runs are free. Their input is kept so you can try again.',
          ],
        },
        tools: {
          title: 'Video Tools',
          intro: 'Rework an existing video: dub it in another language, translate a talking head with lip-sync, lip-sync to new audio, or upscale.',
          steps: [
            'Choose the tool.',
            'Upload a video (max 1999 MB) or paste a link.',
            'Fill in the options of that tool (target language, speakers, audio track or scale) and press Run.',
            'The result appears in the AI Generate tab.',
          ],
          tips: [
            'Dub voice-over keeps the original picture and clones the speaker\'s voice in the new language (no lip-sync).',
            'YouTube links need a cookies.txt from a logged-in browser, because YouTube blocks server downloads. Direct .mp4 links always work.',
          ],
          hints: [
            ['#vt-tool', 'Dub = new language, same picture. Translate = new language with lip-sync. Lipsync = mouth follows an audio file. Upscale = sharper/larger.'],
          ],
        },
        clipper: {
          title: 'Clipper',
          intro: 'Cuts a long video (podcast, livestream, YouTube video) into short vertical clips with captions, ready for Shorts, Reels and TikTok.',
          steps: [
            'Paste the video URL and set the minimum and maximum clip length.',
            'Choose the source language, the AI model and the aspect ratio (9:16 for Shorts/Reels/TikTok).',
            'ClipAnything: describe which moments you want ("every moment about pricing"). ClipBasic picks the most engaging parts itself.',
            'Press Submit. Clips appear in the Video Queue with a virality score, and are saved on the server.',
          ],
          tips: [
            'A brand template adds your captions style, logo and colors to every clip.',
            '!From a finished clip you can post or schedule it to a connected social account, or send it to the Social Media Manager.',
          ],
        },
      },
    },

    'marketing.html': {
      title: 'Marketing',
      intro: 'The weekly report of the Growth Marketeer: research on your market and competitors, plus concrete growth ideas.',
      steps: [
        'Read "Start this week" first: the top 3 ideas with the most impact for the least effort.',
        'Go through all growth ideas. Each has a channel, steps, a KPI and a cost estimate.',
        'Set the status of an idea (planned, doing, done, dismissed). The marketeer takes that into account next week.',
        'Competitors, gaps in the market and buzz opportunities give the background; every claim links to its sources.',
        '!"Run research now" makes a fresh report (takes a few minutes).',
      ],
      tips: [
        'The report runs automatically every week when the Growth Marketeer is planned in the Scheduler.',
        'Older reports stay available, so you can compare weeks.',
      ],
    },

    'community-manager.html': {
      title: 'Social Media Manager',
      intro: 'Writes, schedules and publishes posts to your Telegram and X channels, by hand or fully automatic with the autopilot.',
      steps: [
        'Connect a channel first: Channels tab → "+ Add Channel", choose the platform and fill in the IDs or keys.',
        'Write a post: Queue tab → "+ New post", choose the channel, write the text, optionally add images or a video.',
        'Publish now, or set a date and time to schedule it. Drafts wait for your approval.',
        'Want posts without work? Turn on the Autopilot on a channel card: it finds topics, writes the post and adds an image.',
      ],
      tips: [
        'Autopilot mode "review" creates drafts you approve first; "auto" posts directly.',
        '"Run once → draft" on a channel card shows what the autopilot would make, without posting.',
        'Telegram posts can use simple formatting (bold, italic, links).',
      ],
      tab: () => (document.querySelector('.tab.active[data-tab]') || {}).dataset?.tab,
      watch: '.tabs',
      tabs: {
        queue: {
          title: 'Queue',
          intro: 'All posts: drafts, scheduled, published and failed.',
          steps: [
            'Press "+ New post" to write one; leave the time empty to publish right away.',
            'Drafts (also from the autopilot) need an Approve; "Approve all" does them in one go.',
            'Use Edit to change text or media, "Move to draft" to stop a scheduled post.',
          ],
          tips: ['A failed post shows the reason; fix it and schedule it again.'],
        },
        channels: {
          title: 'Channels',
          intro: 'Your connected Telegram and X accounts, each with its own autopilot settings.',
          steps: [
            'Add a channel with "+ Add Channel". For Telegram you need the chat ID (and a topic ID for a forum group).',
            'Open Autopilot on a channel: posts per day, time window, language, topics or curated accounts, and the mode (review or auto).',
            'Save, then test with "Run once → draft".',
          ],
          tips: [
            'An X channel can have its own API keys; without them it posts with the default account from the server settings.',
            '"Min. likes" and "Min. followers" keep the autopilot away from low-quality sources.',
          ],
        },
      },
    },

    'settings.html': {
      title: 'Settings',
      intro: 'Connections, API keys, branding, users and costs for the whole Command Center.',
      steps: [
        'API Integrations: paste the API keys of the services you use. The status shows if a key works.',
        'Brand Assets: logo, colors and "Knowledge for agents", a text about your brand that every agent reads.',
        'Social Connections: connect accounts (Meta, YouTube, X…) via login.',
        'Users & Access: create logins for team members and choose which tools they may use.',
        'API Usage & Costs: what every tool and agent cost per day, per provider and per feature.',
      ],
      tips: [
        'Changing a key takes effect right away; you do not need to restart anything.',
        'Team members only see their own work and pay with your API keys, so watch the costs section.',
      ],
    },
  };

  const guide = GUIDES[page];
  if (!guide) return;

  // ── Styles ──────────────────────────────────────────────────────────────────
  const st = document.createElement('style');
  st.id = 'cc-explain-style';
  st.textContent = `
    .xp-toggle { display: inline-flex; align-items: center; gap: 8px; margin-top: 10px; padding: 5px 12px 5px 6px;
      border: 1px solid var(--border, hsl(217 32% 20%)); border-radius: 999px; background: transparent; cursor: pointer;
      color: var(--text-dim, hsl(215 20% 65%)); font: 500 11px/1 var(--font-data, Inter, sans-serif); letter-spacing: .04em; }
    .xp-toggle:hover { color: var(--text, hsl(210 40% 98%)); border-color: hsl(264 65% 49% / .6); }
    .xp-track { position: relative; width: 28px; height: 16px; border-radius: 999px; background: hsl(217 32% 20%); transition: background .2s; }
    .xp-track::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: hsl(210 40% 98%); transition: transform .2s; }
    .xp-toggle[aria-checked="true"] { color: hsl(264 65% 75%); border-color: hsl(264 65% 49% / .6); }
    .xp-toggle[aria-checked="true"] .xp-track { background: hsl(264 65% 49%); }
    .xp-toggle[aria-checked="true"] .xp-track::after { transform: translateX(12px); }
    .xp-card { display: none; margin: 16px 0 20px; padding: 18px 20px; border-radius: 12px;
      border: 1px solid hsl(264 65% 49% / .35); background: linear-gradient(180deg, hsl(264 65% 49% / .08), hsl(264 65% 49% / .02));
      font-family: var(--font-data, Inter, sans-serif); color: var(--text, hsl(210 40% 98%)); font-size: 13px; line-height: 1.55; }
    html.cc-explain .xp-card { display: block; }
    .xp-card h3 { margin: 0 0 4px; font-size: 13px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: hsl(264 65% 75%); }
    .xp-card .xp-intro { color: var(--text-dim, hsl(215 20% 65%)); margin-bottom: 12px; }
    .xp-card .xp-cols { display: grid; grid-template-columns: 3fr 2fr; gap: 20px; }
    .xp-card h4 { margin: 0 0 6px; font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--text-dim, hsl(215 20% 65%)); }
    .xp-card ol, .xp-card ul { margin: 0; padding-left: 18px; }
    .xp-card li { margin-bottom: 5px; }
    .xp-card .xp-sub { margin-top: 14px; padding-top: 14px; border-top: 1px solid hsl(264 65% 49% / .2); }
    .xp-hint { display: none; margin-top: 5px; font: 11px/1.45 var(--font-data, Inter, sans-serif); color: hsl(264 65% 75%); }
    .xp-hint::before { content: 'ⓘ '; }
    html.cc-explain .xp-hint { display: block; }
    html.cc-team-user .xp-card [data-owner-only] { display: none; }
    @media (max-width: 760px) { .xp-card { padding: 14px; } .xp-card .xp-cols { grid-template-columns: 1fr; gap: 12px; } }
  `;
  document.head.appendChild(st);

  // ── Rendering ───────────────────────────────────────────────────────────────
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const li = s => s.startsWith('!') ? `<li data-owner-only>${esc(s.slice(1))}</li>` : `<li>${esc(s)}</li>`;

  function section(g, sub) {
    const steps = (g.steps || []).length ? `<div><h4>How to use it</h4><ol>${g.steps.map(li).join('')}</ol></div>` : '';
    const tips = (g.tips || []).length ? `<div><h4>Good to know</h4><ul>${g.tips.map(li).join('')}</ul></div>` : '';
    return `<div class="${sub ? 'xp-sub' : ''}"><h3>${esc(g.title)}</h3><div class="xp-intro">${esc(g.intro)}</div>
      <div class="xp-cols">${steps}${tips}</div></div>`;
  }

  function currentTab() {
    if (!guide.tabs || !guide.tab) return null;
    try { const t = guide.tab(); return t && guide.tabs[t] ? guide.tabs[t] : null; } catch { return null; }
  }

  function addHints(list) {
    (list || []).forEach(([sel, text]) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const box = el.closest('.form-field') || el.parentElement;
      if (!box || box.querySelector(`.xp-hint[data-for="${sel}"]`)) return;
      const h = document.createElement('div');
      h.className = 'xp-hint';
      h.dataset.for = sel;
      h.textContent = text;
      box.appendChild(h);
    });
  }

  function render() {
    const card = document.getElementById('xp-card');
    if (!card) return;
    const tab = currentTab();
    card.innerHTML = section(guide, false) + (tab ? section(tab, true) : '');
    addHints(guide.hints);
    if (guide.tabs) Object.values(guide.tabs).forEach(t => addHints(t.hints));
  }

  function setOn(on) {
    document.documentElement.classList.toggle('cc-explain', on);
    const btn = document.getElementById('xp-toggle');
    if (btn) btn.setAttribute('aria-checked', String(on));
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch {}
    if (on) render();
  }

  function mount() {
    const main = document.querySelector('.main');
    const title = main && main.querySelector('.header-title');
    if (!title || document.getElementById('xp-toggle')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'xp-toggle';
    btn.className = 'xp-toggle';
    btn.setAttribute('role', 'switch');
    btn.setAttribute('aria-checked', 'false');
    btn.title = 'Show how this tool works';
    btn.innerHTML = '<span class="xp-track"></span>Explain mode';
    btn.addEventListener('click', () => setOn(!document.documentElement.classList.contains('cc-explain')));
    const sub = title.parentElement.querySelector('.header-sub');
    (sub || title).insertAdjacentElement('afterend', btn);

    // The guide card goes right below the page header block.
    let block = title;
    while (block.parentElement && block.parentElement !== main) block = block.parentElement;
    const card = document.createElement('div');
    card.id = 'xp-card';
    card.className = 'xp-card';
    block.insertAdjacentElement('afterend', card);

    if (guide.watch) {
      const w = document.querySelector(guide.watch);
      if (w) new MutationObserver(() => { if (document.documentElement.classList.contains('cc-explain')) render(); })
        .observe(w, { subtree: true, attributes: true, attributeFilter: ['class'] });
    }

    let on = false;
    try { on = localStorage.getItem(KEY) === '1'; } catch {}
    setOn(on);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
