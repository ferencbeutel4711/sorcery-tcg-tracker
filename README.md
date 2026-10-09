# Sorcery Tracker

Local collection tracker for Sorcery: Contested Realm.

```sh
npm start        # http://localhost:3000 (Node 24, no dependencies)
```

- Card metadata comes from `api.sorcerytcg.com` once per server start (cached in `data/cards.json` for offline starts).
- Prices come from Cardmarket's public daily price guide, refreshed at start and every 24h.
- Card art is proxied and cached in `data/images/`.
- Your collection lives in `data/collection.db` (SQLite). Import/export uses the Curiosa CSV format.

## Disclaimer

Unofficial fan project, not affiliated with or endorsed by Erik's Curiosa Limited, Curiosa/sorcerytcg.com or Cardmarket.
Sorcery: Contested Realm, card names, data and artwork are the property of their respective owners. This repository
contains no card data or images — they are fetched at runtime from the public sources above and cached locally in `data/`.

Syncing to Curiosa uses the site's undocumented internal API with your own browser session; it may break at any time.
