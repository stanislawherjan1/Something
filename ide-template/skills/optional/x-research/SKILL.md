---
name: x-research
description: How to use the X (Twitter) MCP for read-only research — search tweets, look up users, pull threads, follower lists, mentions. Triggers on phrases like "x.com", "twitter", "tweet", "what is @user posting", "co pisze @user", "search X for", "co mówią o", a tweet URL pasted in chat. Read-only by design — no posting, no DMs.
requires: x
allowed-tools: mcp__x__search_tweets, mcp__x__get_user, mcp__x__user_last_tweets, mcp__x__user_followers, mcp__x__user_following, mcp__x__user_mentions, mcp__x__tweet_replies, mcp__x__tweet_quotations, mcp__x__tweets_by_ids
---

# X (Twitter) Protocol

X is a firehose of public commentary — competitor moves, customer reactions, breaking news, what people are saying about a brand or topic. The MCP gives the bot structured read access via twitterapi.io. **Read-only**, no writes possible.

## Pre-flight — is X available?

If the tools aren't there, the integration isn't active. Tell the user to open **Integrations → X (twitterapi.io)**, paste their API key, save. Don't simulate the answer.

If a call returns 401/403, the API key is invalid or out of credit. Surface the actual error message — the user can top up at twitterapi.io.

## Inputs the user typically gives

- **A tweet URL** like `https://x.com/elonmusk/status/1234567890` → strip the id (last path segment), use `tweet_replies` or `tweets_by_ids`.
- **A handle** with or without `@` → strip the `@`, pass to `get_user` / `user_last_tweets` / etc.
- **A topic / brand / hashtag** → use `search_tweets` with appropriate operators.

## search_tweets — the swiss army knife

The query field accepts the same operators as X's advanced search. Examples:

| User asks | Query to send |
|---|---|
| Co mówią ostatnio o naszej marce? | `acme OR @acme_official lang:pl since:2026-04-01` |
| Co publikuje ten konkurent? | `from:competitor` |
| Najgłośniejsze tweety o kategorii X | `"category x" min_faves:100 lang:en` |
| Tweety z linkami do YouTube | `youtube.com has:links -is:retweet` |
| Pod tym tweetem | use `tweet_replies` z `tweet_id`, nie search |

`queryType: "Top"` ranks by engagement, `"Latest"` by time. Default Latest; switch to Top for "what's been popular about X".

## Cost-awareness

The user pays per read (~$0.15 / 1k tweets). For lookups paginate sparingly — fetch the first page, summarise, only deepen if the user asks. Don't `user_followers` 100 pages by default to "be thorough" — that's $20 of someone else's money.

When in doubt: **ask first** before walking pagination beyond the first page.

## Standard read flow

User: *"co pisze @username ostatnio?"*

1. `user_last_tweets({username})` — first page (20 tweets).
2. Summarise: themes, recent posts, anything notable.
3. **Don't dump all 20 tweet bodies** — pick 3-5 representative, give counts/headlines for the rest.
4. Offer to deepen: *"Mam 20 ostatnich. Pokazać więcej, czy zooma na konkretny tweet?"*

User: *"pokaż reply pod tym tweetem [URL]"*

1. Strip tweet id from URL.
2. `tweet_replies({tweet_id})` — first page.
3. Summarise sentiment, list a few notable replies (with handle + reply count).
4. Offer pagination if user wants more.

## What NOT to do

- Don't simulate tweets when the API errors. If `search_tweets` fails, surface the error verbatim and stop. Hallucinated tweets that look real are worse than admitting an outage.
- Don't aggregate more than ~3 pages of any endpoint without explicit user OK — burns their credit.
- Don't fall back to `grok` to "double-check" twitterapi.io results. Either trust the structured data or surface uncertainty; mixing two sources creates inconsistencies.
- Don't try to write — the MCP has no write tools. If the user asks to "post", explain that this integration is read-only by design and they'd need a separate write integration (which we don't ship intentionally — credential exposure trade-off).

## Tweet URLs in your replies

When referencing tweets, always include the `url` field from the response so the user can click through. Tweets in chat without a URL are useless for follow-up.
