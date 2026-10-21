# Every command the owner or an agent runs. `make` alone lists them.
.PHONY: help check validate test docs render install setup

help: ## list the targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t/'

check: validate test docs ## everything that must pass before a commit

validate: ## the manifest and hooks module, read as the engine reads them
	claude plugin validate .

test: ## tests/, every tab drawn on terminal and desktop
	claude plugin test .

docs: ## AGENTS.md size, paths the docs name, SCHEMA.md version
	node scripts/check-docs.mjs

render: ## the band and every tab as PNGs in assets/, with a gallery page (scratch files in .render/)
	.shots/run.sh assets .render

install: ## update the installed copy (the version must have changed)
	claude plugin update cockpit@tfernandes-mods

setup: ## use the repo's git hooks (.githooks/)
	git config core.hooksPath .githooks
