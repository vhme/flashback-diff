# Publishing Flashback Diff

This guide covers publishing to the **VS Code Marketplace** (VS Code) and **Open VSX**
(VSCodium, Cursor, Windsurf, Gitpod and others).

## 1. Push the code to GitHub

Create the repository `vhme/flashback-diff` on GitHub. If you use a different
user or name, update `repository`, `homepage` and `bugs` in `package.json` and the
clone URL in `README.md`.

```bash
git init
git add .
git commit -m "Flashback Diff 1.0.0"
git branch -M main
git remote add origin https://github.com/vhme/flashback-diff.git
git push -u origin main
```

The README images use relative paths. `vsce` rewrites them to GitHub URLs when it
packages the extension, so the repository must be public and pushed **before** you publish.

## 2. VS Code Marketplace

1. Sign in at <https://marketplace.visualstudio.com/manage> with a Microsoft account.
2. Create a publisher:
   - **ID:** `vhme`. It must match `publisher` in `package.json`.
   - **Name:** `vhme`. This is the display name shown on the Marketplace.
3. Create a Personal Access Token in Azure DevOps (<https://dev.azure.com> → User settings → Personal access tokens):
   - Organization: **All accessible organizations**
   - Scopes: **Marketplace → Manage**
4. Publish:

```bash
npm install
npx vsce login vhme      # paste the token
npx vsce publish
```

## 3. Open VSX (optional, recommended)

1. Sign in at <https://open-vsx.org> with GitHub and sign the publisher agreement.
2. Create an access token in your Open VSX profile.
3. Create the namespace once, then publish:

```bash
npx ovsx create-namespace vhme -p <token>
npx ovsx publish -p <token>
```

## Releasing a new version

1. Update `CHANGELOG.md`.
2. Bump the version and publish:

```bash
npx vsce publish patch    # 1.0.0 → 1.0.1  (or: minor / major)
npx ovsx publish -p <token>
git push --follow-tags
```

## Checklist before publishing

- [ ] `npm run lint` and `npm test` pass
- [ ] `npx vsce package` builds without warnings
- [ ] You installed the `.vsix` locally and tested it on a real repository
- [ ] The repository is public and the README images load on GitHub
