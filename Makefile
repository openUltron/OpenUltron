.PHONY: help install dev preview build test test-watch run electron electron-dev electron-build dist release clean clean-cache

NPM ?= npm

help: ## Show available targets
	@echo "OpenUltron Make targets:"
	@awk 'BEGIN {FS = ":.*## ";} /^[a-zA-Z0-9_.-]+:.*## / {printf "  %-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install dependencies
	$(NPM) install

dev: ## Start Vite dev server
	$(NPM) run dev

preview: ## Start Vite preview server
	$(NPM) run preview

build: ## Build web app (Vite)
	$(NPM) run build

test: ## Run unit tests once
	$(NPM) run test

test-watch: ## Run tests in watch mode
	$(NPM) run test:watch

run: ## Run Electron + Vite dev mode
	$(NPM) run electron:dev

electron: ## Start Electron app
	$(NPM) run electron

electron-dev: ## Start Electron + Vite dev mode
	$(NPM) run electron:dev

electron-build: ## Build desktop package
	$(NPM) run electron:build

dist: ## Build distributables without publish
	$(NPM) run dist

release: ## Run release build script
	$(NPM) run release

clean-cache: ## Clear Electron cache
	$(NPM) run electron:clean-cache

clean: ## Remove build artifacts
	rm -rf dist dist-electron
