# Repository workflow

- Make all changes on a topic branch based on the latest `origin/main`.
- Publish changes through a pull request targeting `main`; never push directly to `main`.
- Before merging, ensure the branch is up to date, review conversations are resolved, and all required GitHub Actions checks pass: `Test and build (ubuntu-latest)`, `Test and build (windows-latest)`, and `Browser (Linux Chromium)`.
- Do not disable branch protection, bypass required checks, force-push `main`, or delete `main`.
- Follow `CONTRIBUTING.md` for verification and contribution requirements. Never commit credentials, production saves, or private model requests.
