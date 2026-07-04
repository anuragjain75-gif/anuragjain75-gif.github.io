
Now that we've established a proper Git workflow (`develop` → `main`), here's the workflow I recommend using every time you work on Lilamaya.

---

# 1. Open a terminal

Go to your project folder:

```bash
cd ~/Documents/GitHub/TheLilamaya
```

---

# 2. Switch to the development branch

```bash
git checkout develop
```

Always develop on `develop`, never on `main`.

---

# 3. Pull the latest changes

```bash
git pull origin develop
```

This keeps your local branch in sync.

---

# 4. Start the Hugo development server

```bash
hugo server
```

or, if you want drafts visible,

```bash
hugo server -D
```

You should see something like:

```text
Web Server is available at http://localhost:1313/
```

---

# 5. Open the website

Visit

```text
http://localhost:1313/
```

Leave the terminal running.

Hugo will rebuild the site automatically every time you save a file.

---

# 6. Work normally

Edit files such as:

- `content/`
    
- `layouts/`
    
- `assets/css/style.css`
    
- `static/`
    

Save the file.

Refresh the browser.

The changes appear immediately.

---

# 7. Stop the server

When you're finished:

Press

```text
Ctrl + C
```

in the terminal.

---

# 8. Save your work

```bash
git add .
git commit -m "Describe the work"
git push origin develop
```

---

# 9. When a feature is finished

Merge it into `main`:

```bash
git checkout main
git pull origin main
git merge develop
git push origin main
```

GitHub Pages will then update the live website.

---

# The workflow we should always follow

```text
main
    │
    │
    ▼
Live Website
    ▲
    │
merge
    │
develop
    ▲
    │
localhost:1313
```

I recommend treating `main` as **read-only**. All design work, experiments, and new features should happen on `develop`. Only when a feature is complete and you're happy with it should it be merged into `main` and published. This gives you a clean history, a stable live site, and the freedom to experiment without worrying about breaking what's already public.