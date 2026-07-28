# seedcoherent README demo — renders a deterministic terminal GIF.
#
# Requires: vhs (brew install vhs), sqlite3, and a built dist/ (npm run build).
# Render from the repo root:
#
#   npm run build && vhs demo/demo.tape
#
# Output: demo/demo.gif  (the setup block is hidden; only the story shows)

Output demo/demo.gif

Set Shell "bash"
Set FontSize 20
Set Width 1200
Set Height 760
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

# --- Hidden setup: build a fresh SQLite DB and alias the CLI ------------------
Hide
Type "npm run build >/dev/null 2>&1 && alias seedcoherent='node $PWD/dist/cli.js'"
Enter
Type "rm -f /tmp/shop.db && sqlite3 /tmp/shop.db < examples/demo-sqlite.sql && clear"
Enter
Show

# --- The story ---------------------------------------------------------------
Sleep 800ms
Type "# An empty SQLite schema: users, orders, products, a category tree."
Sleep 1s
Enter
Type "# Point seedcoherent at it — no config, no annotations."
Sleep 1200ms
Enter
Enter

Type "seedcoherent /tmp/shop.db --rows users=8 products=12 orders=15 order_items=40 --seed 42"
Sleep 500ms
Enter
Sleep 2500ms

Enter
Type "# Orders reference REAL users. Emails, countries, enums all look right."
Sleep 1200ms
Enter
Type@30ms "sqlite3 -header -column /tmp/shop.db \"SELECT o.id, u.email, u.country, o.status FROM orders o JOIN users u ON u.id = o.user_id LIMIT 5;\""
Sleep 500ms
Enter
Sleep 3s

Enter
Type "# Zero orphan rows — every foreign key points at a row that exists."
Sleep 1200ms
Enter
Type@30ms "sqlite3 /tmp/shop.db \"SELECT count(*) AS orphans FROM orders WHERE user_id NOT IN (SELECT id FROM users);\""
Sleep 500ms
Enter
Sleep 3s
