# ARKstamp

React/TypeScript/Vite/Firebase deck and chapter organizer app. Firebase project: `keepstamp-prod`. Hosting serves the `dist/` build output.

## Workflow
- The user is non-technical and relies on Claude for all code changes. Make the change, commit, push to `main`. The user never uses a terminal.
- Pushing to `main` runs `npm ci && npm run build` on GitHub and auto-deploys Hosting to keepstamp-prod (secret `FIREBASE_SERVICE_ACCOUNT`). `dist/` is NOT committed.
- The Google Maps key lives in the GitHub secret `VITE_GOOGLE_MAPS_KEY`; the workflow injects it at build time. `.env` is never committed. If the build output has no Maps key, the Itinerary map breaks, so the workflow fails when the secret is empty.
- Firestore rules, Storage rules and Cloud Functions (`functions/`) are NOT part of the push auto-deploy. They deploy from GitHub: Actions tab > "Deploy rules and functions (manual)" > Run workflow > pick what to deploy. When a change touches them, push it, then tell the user exactly which option to pick.
- Function secrets (`ANTHROPIC_API_KEY`, `EMAIL_USER`, `EMAIL_PASS`) live in Firebase Secret Manager, not in this repo.
- Build numbers: KS### prefix, increment by exactly one per change, named in the commit message. Baseline when this repo was created: KS130.
- Read the relevant files fully before editing.

## Conventions
- No em dashes in any writing.
- No "Claude" or "AI" in user-facing copy.
- Static Tailwind class strings only; no dynamic interpolation for color-critical styles.
