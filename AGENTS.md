# Project instructions

Before editing:
- Read README.md, package.json, and relevant source files.
- State the exact files you plan to modify.
- Do not rewrite unrelated files.
- Do not change auth, database schema, or routing unless the issue explicitly asks.
- Prefer small commits / small merge requests.

Coding rules:
- Preserve existing style.
- Add tests when changing parsing, database, or business logic.
- Do not introduce new dependencies without explaining why.

After editing:
- Summarize files changed.
- Explain how to test locally.

Preferred workflow:
GitHub personal repo (`origin`) → GitLab school repo (`gitlab`) → Duo/Fable edits → merge request → optionally push back to GitHub.

Important:
- Do not delete or overwrite the GitHub `origin` remote.
- Do not expose secrets (`.env`, API keys, tokens).
- Do not make huge unrelated edits.
