---
name: youtube-optimizer
description: Use when the user provides a video transcript or script and wants YouTube optimization. Generates 10 clickbait titles, full description, chapter timestamps, comma-separated tags, and clickbait thumbnail text in one structured output. Triggered by phrases like "optimaliseer voor YouTube", "maak YouTube titels", "YouTube SEO", "thumbnail tekst", "YouTube tags".
---

# YouTube Optimizer — Transcript to Full YouTube Package

Je ontvangt een videotranscript (of script) en genereert een compleet YouTube publicatie-pakket.

## Verplichte input

Vraag erom als ontbrekend:
1. **Transcript** — ruwe tekst, met of zonder timestamps
2. **Videolengte** — in mm:ss (mag afgeleid worden uit timestamps)
3. **Taal** — NL of EN (default: match de taal van het transcript)
4. **Niche / kanaalonderwerp** — voor tag-relevantie (optioneel)

Als het transcript GEEN timestamps heeft EN geen totale videolengte bekend is: vraag eerst de videolengte voor je timestamps genereert.

## Output — ALTIJD deze 5 secties in exact deze volgorde

```
## 1. Titels (10 clickbait)
1. ...
2. ...
...
10. ...

## 2. Omschrijving
[Hook-regel — eerste 120 tekens zichtbaar in zoekresultaat]

[2–4 paragrafen: wat de video behandelt, waarom het telt, voor wie]

🔗 Links:
- ...

⏱️ Timestamps:
[spiegel sectie 3 hier]

#hashtag1 #hashtag2 #hashtag3

## 3. Timestamps
00:00 Intro / Hook
MM:SS Hoofdstuktitel
...

## 4. Tags
tag1, tag2, tag3, ...  (20–35 tags, ~450 tekens max)

## 5. Thumbnail tekst
Primair: [2–4 WOORDEN, HOOFDLETTERS]
Alt optie: [alternatief 2–4 woorden]
```

## Regels per sectie

### Titels (10x)
- 40–70 tekens (sweet spot 55–65)
- Mix deze invalshoeken: curiosity gap, nummer/lijst, contrair standpunt, waarschuwing/fout, resultaat/uitkomst, vraag, "Ik probeerde X"
- Minimaal 3 met een getal, minimaal 2 als vraag
- Geen volledige HOOFDLETTERS in de titel. Alleen kernwoorden kapitaliseren.
- Hoofd-keyword in 7 van de 10 titels
- Geen clickbait die niet door het transcript ondersteund wordt (beloof niets wat de video niet levert)

### Omschrijving
- Eerste 120 tekens = hook (zichtbaar in zoekresultaten vóór "...meer")
- 150–300 woorden totaal
- 1 primaire CTA (subscribe / bekijk volgende / link)
- 3–5 hashtags onderaan, relevant voor niche
- Spiegel de timestamps binnen de omschrijving (YouTube gebruikt ze voor chapters)

### Timestamps
- Eerste tijdstempel MOET `00:00` zijn
- 5–10 hoofdstukken voor video's < 15 min, 8–15 voor langer
- Elk hoofdstuk ≥ 10 seconden uit elkaar (YouTube minimum)
- Hoofdstuktitels: 2–6 woorden, actie- of voordeel-gericht
- Schaal naar werkelijke videolengte. Verzin NOOIT timestamps voorbij de videoduur
- Format `MM:SS` onder 1 uur, `HH:MM:SS` voor 1u+
- Schatting spreektempo: ~150 woorden per minuut

### Tags
- 20–35 tags, komma + spatie gescheiden
- Totaal ≤ 450 tekens (YouTube-limiet is 500, marge houden)
- Mix: breed (niche), specifiek (onderwerp), long-tail (zinnen), brand
- Lowercase tenzij eigennaam
- Geen `#` symbolen in tags veld (hashtags horen in omschrijving)
- Eerste 3 tags zijn de belangrijkste

### Thumbnail tekst
- 2–4 WOORDEN MAX — leesbaar op mobiel
- HOOFDLETTERS
- Hoge emotie / nieuwsgierigheid / getal
- Vermijd woorden die al in de titel zichtbaar zijn (thumbnail + titel = gezamenlijke boodschap)
- Lever 1 primair + 1 alternatief

## Style rules — HARD

- **Geen em-dashes (`—`) of en-dashes (`–`)** in enige output. Gebruik punten, dubbele punten, of regelafbreking.
- Match de taal van het transcript (NL transcript → NL output, EN → EN)
- Verzin nooit feiten, quotes of cijfers die niet in het transcript staan
- Verzin nooit timestamps voorbij de werkelijke videolengte

## Workflow

1. Lees transcript → identificeer: onderwerp, doelgroep, hook-momenten, kernboodschap, CTA
2. Bepaal videolengte (uit timestamps of vraag)
3. Genereer alle 5 secties in exact het format hierboven
4. Verifieer: aantal timestamps past bij lengte, tags ≤ 450 tekens, titels 40–70 tekens, nergens em-dashes
5. Lever als één markdown-response

## Veelgemaakte fouten

| Fout | Fix |
|---|---|
| Timestamps voorbij videolengte | Cap op werkelijke duur; bevestig lengte eerst |
| Em-dashes in titels/omschrijving | Zoek output op `—` en `–` voor oplevering |
| Tags overschrijden 500 tekens | Tel tekens; verwijder tags met laagste relevantie |
| Thumbnail tekst dupliceert titel | Thumbnail voegt NIEUWE info toe — complementeer, herhaal niet |
| `00:00` ontbreekt | Start hoofdstukken altijd op 00:00 |
| Generieke titels ("Hoe X") | Voeg specificiteit toe: getal, resultaat, timeframe, contraire hoek |
