# bridex-plugin-brightdata

Bright Data for Bridex agents — sites that block bots, search, an interactive
remote browser and proxies, on your own Bright Data account.

- **Automatic**: `web_fetch` and `browser_navigate` recognise a bot wall
  (captcha, «checking your browser», a risk redirect) and go through Bright
  Data on their own — Web Unlocker for pages, Browser API for the browser.
  What worked is remembered per domain.
- **Tools**: `brightdata_balance` (balance, spend, daily budget left),
  `brightdata_zones` (list / create products), `brightdata_scrape` (one page:
  markdown, html, screenshot), `brightdata_search` (Google parsed, Bing,
  Yandex). `web_proxy` hands scripts a local proxy in front of a residential
  zone — the password stays on the instance.
- **Zones** are created on first use (an existing one of the kind is reused).
- **Daily budget** (`daily_budget_usd`, $5 by default): paid calls stop for the
  day once the account has spent it.

Key: `BRIGHTDATA_API_KEY` (Bright Data → Account settings → API keys).
