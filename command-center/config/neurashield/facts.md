# NeuraShield facts

The only source of product claims for the neurashield-x task. Every claim about what NeuraShield does must trace to a line in this file.
Edit by hand, or let the weekly facts job append dated lines under "Updates" (sources: README changelog and threat list version only).

## What it is
- A native macOS menu bar app (macOS 13+, Apple silicon and Intel) for people who hold crypto on a Mac.
- Signed with an Apple Developer ID and notarized by Apple under NeuraLabs Capital SL.
- Free to install, no account.
- Everything runs on the Mac; the free version makes no network connections at all.
- Download: https://neuralabscapital.com/neurashield

## Guards (what it watches)
- Fake installers: look-alikes of Zoom, Teams, Ledger Live and other apps, unsigned downloads, disguised scripts, caught before you open them.
- Clipboard protection: blocks "paste this in Terminal" malware commands.
- Clipboard protection: warns when a recovery phrase or private key is on the clipboard and clears it after 60 seconds.
- Clipboard protection: checks meeting links for look-alike domains.
- Address guard: compares copied wallet addresses with your trusted list.
- Address guard: catches address poisoning (same first and last characters, different middle).
- Address guard: catches clipper malware (address changes within seconds of copying).
- Address guard: blocks wallets on the threat list.
- Address guard: optional notice when an unknown address is copied.
- Copy hijack check (0.5, Nov 2026): compares the text you selected in the browser with what actually landed on the clipboard; catches page scripts and extensions that rewrite the address as you copy.
- Copy hijack check: optional, needs the Accessibility permission, off by default.
- Startup hijacks: warns when something makes itself start at every login (launch agents, daemons, shell startup files, git hooks) and removes it in one click.
- Tampered wallet apps: warns if Ledger Live, Trezor Suite, Exodus, TradingView or MetaTrader has been replaced by a copy without a valid developer signature.
- Fake password prompts: calls out fake macOS password dialogs, the trick most Mac stealers use.
- Weekly threat list: signed (Ed25519) list of scam domains, fake app names, malware paths, malicious extensions, attacker wallets.
- Weekly threat list: the app accepts it only when the signature checks out.

## Tools
- Check a link.
- Check a file.
- Exposure scan: what a thief would find first on this Mac.
- Trusted addresses.
- An "I think this Mac is infected" button that saves evidence and walks you through the steps.
- The incident button is free for everyone.

## Pricing
- Core protection free forever.
- NeuraShield Premium (threat list, tampered wallet app detection, full exposure scan, unlimited trusted addresses) is included in NeuraTrade Premium, 59 euro per year, via https://suite.neuralabscapital.com.
- Premium members link their Mac from the suite.

## What it is not
- Not an antivirus, not a VPN, not a wallet, not a signals service.
- It does not read screens, does not log keystrokes, does not upload anything.
- It does not stop every attack; it watches the specific moments where crypto users lose money.

## Recent context (keep updated, date everything)
- 16 Nov 2026: Optimizely supply-chain attack ("Optimjack"), one hijacked script on 178 sites (Zoom, BBC, CNN, HSBC, Ledger) swapped wallet addresses in pages and on the clipboard and skimmed cards. Source: Report URI.
- 16 Nov 2026: NeuraShield 0.5 adds the copy hijack check and attacker wallets in the threat list in response.

## Updates (appended weekly, dated)
- 15 Nov 2026: threat list version 2 published (2026-11-15T23:09:25Z).
