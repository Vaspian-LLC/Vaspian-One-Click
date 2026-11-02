# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

There are two equal audiences, both Vaspian business-phone customers:
- **Office staff:** receptionists and office workers at small and mid-size businesses. They take, place and transfer calls all day alongside other web apps, and most are non-technical.
- **Call-center agents:** they work in queues, live in a CRM, and care about speed, wrap-up, dispositions and the keyboard.

The office experience is the default. Call-center tools (queues, groups, wrap-up and dispositions) appear only when they are turned on or available.

## Product Purpose

Vaspian One Click is a Chrome extension that makes the browser the agent's phone control panel for the phone they already have. It covers:
- click to call any number on a web page
- a live call card: answer, send to voicemail, hold, transfer, talk first, park and hang up
- screen pop of the caller's record in their CRM
- after-call wrap-up
- call history
- a Team view with live presence, favorites, groups and park
- DND, forwarding, and queue sign-in

Success means calls are handled faster and with less fumbling, setup is something the agent can finish alone, and the product makes users smile.

## Positioning

- **It controls the desk phone or softphone you already have.** No softphone is required; it drives the Vaspian line over the Silhouette Public API.
- **Screen pop into your CRM:** Zoho Desk, Zoho CRM, Simplicity, SecureCRM, Google Contacts, Google search and custom URLs.
- **Team at a glance:** see who is free, on a call or on DND, then transfer or park with one click.

## Operating Context

- It lives only in Chrome's side panel (about 360–480px wide, full window height), beside whatever web app the agent is using. The toolbar popup is being removed.
- It is used all day, with long idle stretches broken by urgent incoming calls.
- One Click sees the call before the caller's record exists on screen.
- Agents set up screen pop themselves through a guided flow. IT can push and lock settings through Chrome managed policy, and locked fields show "Managed by your organization".
- There is a full-tab Team view (operator.html) for receptionists and admins.

## Capabilities and Constraints

- MV3 extension written in plain JS and CSS: no build step, no frameworks, no npm runtime dependencies.
- Signing in takes a company name or main number, an extension and a PIN. Three failed sign-ins lock the extension for an hour, so the app must never retry bad credentials.
- What the phone can do varies by device. Some phones can't answer or hold remotely; the UI must say so honestly and point the user to the phone itself.
- Degraded states are real and frequent: signed out, PIN rejected, locked out, live updates rejected, no phone connected, and features unsupported.
- **Zoho Desk:** customers only ever see the Access key, never the service URL. Chris set this rule.
- Copy is plain, with no jargon (for example, never "3PCC").
- The UI tests (`fleet/rig`) depend on DOM ids, so ids change only together with the tests.

## Brand Commitments

- The only fixed element is the Vaspian logo mark (`vaspian-just-logo.png`, `icons/`). Colors, type and everything else are open to redesign. Chris chose a bolder new look, explored first as clickable HTML mockups.
- The UI quality bar is "perfect and clean", "a UI masterpiece", "modern, functional, fun to use, resilient, reliable".
- Support contacts: support@vaspian.com, (716) 961-2120.

## Evidence on Hand

- Screenshots of all 104 current states: `fleet/rig/artifacts/uxlead/`.
- Audit: `.impeccable/critique/`.
- A mock server with realistic team data: 49 synthetic people, groups and park slots.
- There are no customer testimonials or metrics; don't invent any.

## Product Principles

1. **The call comes first.** When a call is live, everything else steps back.
2. **Be honest about state.** Never show success that didn't happen. Say what the phone can't do, and how to do it on the phone instead.
3. **Simple by default, powerful when switched on.** Office users never see call-center complexity they didn't ask for.
4. **Setup an agent can finish alone.** Complicated configuration becomes guided steps with a live test.
5. **One app, one shape.** The same tabs, the same places, in every state.

## Accessibility & Inclusion

- Target WCAG 2.2 AA: 4.5:1 text contrast, 24px minimum targets (44px for primary call controls), and full keyboard operation.
- Visible focus, reduced-motion support, and live-region announcements for call state.
