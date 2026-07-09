# TradBot v2 — Paper Trading

Bot de trading **100 % fictif** (paper trading) sur crypto spot, avec données réelles
Binance, backtest honnête et dashboard de suivi.

**Aucun argent réel ne transite ici.** Pas de dépôt, pas de clé API requise, pas de
connexion broker. C'est un banc d'essai pour valider une stratégie sur la durée.

## Démarrage

```bash
npm install
npm start          # démarre le bot + dashboard sur http://localhost:3001
npm run backtest   # rejoue la stratégie active sur ~5,5 mois de données réelles
npm run research   # compare les 4 stratégies (in-sample/out-of-sample, ~16 mois)
npm test           # 30 tests : indicateurs, anti-look-ahead (×4 stratégies), sizing, backtest
```

## Ce que fait le bot

- Surveille 5 paires (BTC, ETH, SOL, XRP, LINK) en bougies **1h** via l'API publique Binance.
- Décide **à la clôture de chaque bougie** (pas 60 fois par heure sur la même donnée).
- **4 stratégies classiques** implémentées (`src/strategies/`), toutes pures et testées :
  croisement EMA20/50, EMA + filtre EMA200, cassure Donchian 20/10 (Turtle),
  rebond RSI30 filtré. Long only (spot). Paramètres standards, **non optimisés**.
- Stratégie active : **Donchian 20/10** — sélectionnée par `npm run research`
  (meilleur Sharpe in-sample sur 70 % des données, validée out-of-sample sur les 30 % restants).
- Risque : **1 % du capital par trade** (calé sur la distance au stop), max 3 positions,
  max 20 % du capital par position, kill-switch à **-5 % sur la journée**.
- Frais (0,10 %) et slippage (0,05 %) appliqués **au PnL** sur chaque exécution.
- État **persisté sur disque** (`data/state.json`, écriture atomique) : un redémarrage
  ne perd rien et ne rejoue pas deux fois la même bougie.
- Si les données Binance sont indisponibles ou périmées : **le bot ne trade pas**.
  Jamais de données simulées.

## Architecture

| Fichier | Rôle |
|---|---|
| `src/config.js` | tous les paramètres (univers, stratégie active, risque, frais) |
| `src/strategies/` | 4 stratégies — fonctions **pures**, identiques en backtest et en live |
| `src/research.js` | comparaison des stratégies : sélection IS 70 %, validation OOS 30 % |
| `src/indicators.js` | EMA / RSI / ATR / Donchian faits main, alignés, sans look-ahead |
| `src/risk.js` | sizing basé sur la distance au stop |
| `src/broker.js` | exécution papier (frais + slippage) — partagé backtest/live |
| `src/engine.js` | boucle live : décision par bougie clôturée, stop par tick |
| `src/backtest.js` | rejeu historique honnête + rapport |
| `src/portfolio.js` | état + persistance atomique |
| `src/server.js` | API + dashboard |

## Le backtest est honnête, donc lis-le honnêtement

- Décision à la clôture de la bougie i → exécution à l'**open de i+1** (aucun look-ahead).
- Stop intra-bougie conservateur : si le low touche le stop, le stop est réputé touché ;
  gap sous le stop → rempli à l'open (pire cas).
- Comparaison systématique au **buy-and-hold net de frais**.
- Le rapport affiche aussi la stabilité (période 1 vs période 2).

Résultat typique : la stratégie peut **perdre moins** que le marché en tendance baissière
tout en restant négative. C'est une information, pas un échec du code.

## Combien ça rapporte ? (la vérité)

Mesuré sur ~16 mois de données réelles (frais et slippage inclus), en fenêtres
glissantes de 30 jours, pour la meilleure des 4 stratégies :

- **Aucune** fenêtre de 30 jours n'atteint +20 %. Zéro, sur toutes les stratégies testées.
- Meilleur mois observé : ~+20 %. Mois médian : légèrement négatif (période baissière).
- Ce que le bot sait faire : **perdre nettement moins que le marché** (-13 % vs -38 %
  en buy-and-hold sur 5,5 mois de baisse) avec un drawdown contenu.
- Quiconque promet « +20-50 % par mois garanti » vend du surapprentissage ou une arnaque.
  +20 %/mois composé = ×9 par an ; ça n'existe pas sans risque de ruine.

## Déploiement 24/7 (Render)

Le repo est prêt pour [Render](https://render.com) (voir `render.yaml`) :

1. Push sur GitHub → Render redéploie automatiquement (`autoDeploy: true`).
2. Les données de marché passent par `data-api.binance.vision`, accessible
   depuis toutes les régions Render (y compris US, où `api.binance.com` est géo-bloqué).
3. Plan gratuit : le service s'endort après ~15 min sans trafic — un auto-ping
   interne (via `RENDER_EXTERNAL_URL`) le maintient éveillé. Pour plus de
   fiabilité, ajoute un ping externe gratuit (ex. UptimeRobot sur `/api/status`).

⚠ **Limite du plan gratuit** : le disque est éphémère. À chaque redéploiement ou
redémarrage du service, `data/state.json` (positions papier, historique) repart
de zéro. Acceptable en paper trading ; pour persister, il faudrait un disque
Render payant ou une base externe.

## LIMITES ET RISQUES

- **Un backtest ne prédit rien.** Même honnête, il décrit le passé.
- Les stratégies de suivi de tendance souffrent en marché sans tendance (faux signaux).
- Le paper trading ignore certains frottements du réel (carnet d'ordres, latence, arrondis de lot).
- Avant toute idée d'argent réel : **plusieurs mois** de paper trading en avant (pas en backtest),
  une connexion broker réelle avec réconciliation d'état, et des ordres idempotents.
  Rien de tout cela n'est branché ici, volontairement.
- La plupart des bots de trading particuliers perdent de l'argent. Celui-ci sert à
  apprendre et à tester proprement, pas à devenir riche.
