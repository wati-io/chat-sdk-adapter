# Changelog

All notable changes to `@wati-io/chat-sdk-adapter` are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

- The README describes the webhook secret's real risk (query parameters can appear in logs) instead of comparing it to the Telegram adapter, which uses a header.
- The README says you can try the adapter on Wati's 7-day free trial, which includes the API and webhooks.

## 0.1.1 (2026-11-19)

- The README and the warning logged when typing indicators are off now say how to turn them on in Wati.

## 0.1.0 (2026-11-18)

First release.

- Receive WhatsApp text, media, locations, reactions, reply-button taps and list picks from Wati webhooks.
- Reply from Chat SDK handlers. Markdown is converted to WhatsApp formatting, and text over 4,096 characters is split at paragraph or line breaks.
- Cards become WhatsApp reply buttons (1 to 3 buttons) or list menus (4 to 10 buttons, or a `Select`).
- Send files by upload or by URL, with captions.
- Send approved templates with `sendTemplate` to start a conversation or reply outside the 24-hour window.
- Typing indicator. When Wati has it disabled for the account, the adapter logs one warning and skips it.
- Conversation history with `fetchMessages`, and thread info with the contact's name.
- Webhooks are checked against a shared secret (`?token=` in the webhook URL, or an `x-wati-webhook-secret` header).
- `accessToken` and `webhookSecret` accept functions, resolved on every call, for rotating credentials.
