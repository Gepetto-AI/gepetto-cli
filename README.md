# @gepetto/cli

Gepetto API v2 from the terminal: real estate photo editing (enhance, declutter, furnish, sky, creative restyle, walls
and floors, upscale). Made so that a person, or a coding agent such as Claude Code, can go from an empty project to a
first render without leaving the terminal. Needs Node 18 or later. Formerly `gepetto-cli`.

```bash
npx @gepetto/cli login          # opens a page: check the code, click "Authorize"
npx @gepetto/cli init           # writes GEPETTO_API_KEY (test key, 200 free renders) to .env
npx @gepetto/cli run declutter --image ./room.jpg --out empty.png
npx @gepetto/cli run furnish --image ./room.jpg --roomId bedroom --styleId modern
npx @gepetto/cli run enhance --image ./room.jpg --straighten
npx @gepetto/cli list rooms     # valid ids (also: styles, furnitures, skies, surfaces)
npx @gepetto/cli job <id>       # one job; jobs --failed lists the latest failures with their reason
npx @gepetto/cli usage          # renders and consumption of the period
npx @gepetto/cli webhook test http://localhost:3000/api/gepetto   # sends a signed success and failure to your endpoint
npx @gepetto/cli secret         # your webhook signing secret
npx @gepetto/cli keys           # your test and live keys, masked (--show to print them in full)
npx @gepetto/cli subscribe      # payment link; the live key is written to .env.production.local once paid
npx @gepetto/cli whoami         # or logout
```

`run` passes any API parameter as is: `--keepFireplace`, `--straighten`, `--skyId sunny`, `--resolution 4k`... A local `--image` or
`--mask` file is uploaded first.

Every command accepts `--json`. The API key is read from `--key`, then `GEPETTO_API_KEY`, then `.env.local` /
`.env`, then the test key of the signed-in account.

API: `https://europe-west1-gepettoai.cloudfunctions.net/v2`, header `Authorization: Bearer <key>`.
Documentation: https://docs.gepettoapp.com
