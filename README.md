# Lato B

Digest musicale personale: recensioni, brani, notizie e approfondimenti da Pitchfork, The Quietus, Rumore, Mowno, OndaRock, SentireAscoltare, The Wire e altre riviste, più i post [FRESH] di r/indieheads.

- `config.json`: fonti, finestre temporali, generi e artisti esclusi
- `concerts-cache.json` (generato): concerti KEXP e NPR Tiny Desk visti nei giri precedenti, per la sezione "YouTube concert"
- `digest.mjs`: scarica i feed e genera `lato-b.html` (`node digest.mjs`)

GitHub Actions rigenera e pubblica la pagina su GitHub Pages ogni ora: `orologio.yml` avvia `digest.yml` con workflow_dispatch, perché i cron di GitHub vengono spesso ritardati o saltati (il cron orario di digest.yml resta come riserva).
