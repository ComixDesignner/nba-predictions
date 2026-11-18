# NBA Predictions

A static, mobile-first dashboard for NBA forecasts, opponent-adjusted team rankings, and historical or prospective model performance. V1 is the baseline. PA3 uses player availability and remains experimental.

The dashboard reads `data/predictions.json`. The matching CSV contains the public V1 and PA3 forecast rows. The private engine provides the verified schedule, forecasts, rating state, and aggregate metrics through an explicit allowlist. Team logos load from the NBA CDN and fall back to team abbreviations.

Game dates and times use America/New_York. The dashboard displays the private engine's last successful update and flags it after 150 minutes or a change of Eastern date. Prospective performance statistics are withheld until 20 shared games have verified outcomes. The original research cohort remains 200 games.

## GitHub Pages

This repository uses regular static files at the root and works under the project subpath. For launch after review, select **Deploy from a branch**, **main**, and **/(root)** under **Settings → Pages**. Pages is disabled during review. No build service, personal computer, or VPS is required.
