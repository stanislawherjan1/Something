# Grok query templates — twitter research

## Step 2: similar accounts

```
mcp__grok__ask_grok({
  prompt: "Identify the 10 X (Twitter) accounts that @<handle> most frequently engages with — replies, retweets, quote-tweets, threads. For each: handle, real name (if public), main focus area, why they interact (shared topic, debate, alliance, etc.). Order by interaction frequency, most active first. Skip mutuals that are clearly low-signal (random replies, spam).",
  x_search: true,
  x_handles: ["<handle>"],
  max_tokens: 2048
})
```

If the response has fewer than 8 accounts, ask Grok to **broaden**: *"include accounts that focus on the same topics even if interaction is rare"*. Below 5 even after broadening → tell the user the network is too sparse, offer to research a different handle or pull a topic-based list instead.

## Step 5: bio query (per account)

```
mcp__grok__ask_grok({
  prompt: "Profile @<account>. Who they are, professional/personal background as far as it's public, what they've built or are known for, current focus (last 3 months), notable achievements or controversies. 300+ words, in clear paragraphs. Cite the X profile + any major external sources (LinkedIn, personal site, project page). If recent activity is sparse, say so.",
  x_search: true,
  web_search: true,
  x_handles: ["<account>"],
  max_tokens: 1500
})
```

Save to `<handle>/@<account>/bio.md`.

## Step 5: post-style query (per account)

```
mcp__grok__ask_grok({
  prompt: "Analyze the posting style of @<account>. Tone (formal/casual/sarcastic/etc.), typical post length, recurring formats (threads, image-posts, polls, quote-tweets), topics they keep returning to, signature phrases or memes, how they engage in replies. Provide 3-5 example post archetypes with format only (NOT actual quotes — describe the pattern). 300+ words.",
  x_search: true,
  x_handles: ["<account>"],
  max_tokens: 1500
})
```

Save to `<handle>/@<account>/post-style.md`.

Run the bio + post-style queries **in parallel** for each account where possible to save wall-time.
