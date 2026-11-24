PYTHON := .venv/bin/python

.PHONY: run screenshots icons

# Daily use is the tmux-mobile command. These targets are for working on the app itself.

run:            # Run the server in the foreground of this terminal, e.g. to read a traceback
	$(PYTHON) -u -m backend

screenshots:    # Re-record the guide clips in docs/demos
	$(PYTHON) -u scripts/capture_guide.py

icons:          # Regenerate the app icons
	node scripts/pwa_assets.cjs
