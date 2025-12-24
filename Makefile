.PHONY: install build build-check run dev pre-commit publish clean db-inspect

# Install dependencies
install:
	bun install

# Build standalone binary with bun
build:
	bun build --compile --minify ./src/index.ts --outfile ./dist/proton-drive-sync

# Type-check without emitting files
build-check:
	bun run build:check

# Run directly with bun (one-off commands)
run:
	PATH="$(PWD)/dist:$(PATH)" bun src/index.ts $(ARGS)

# Run directly with bun in watch mode (auto-reload on file changes)
# Uses watchman to watch all src/ files including HTML, rebuilds and restarts
dev:
	@echo "Starting dev mode with watchman file watching..."
	@watchman watch-project . > /dev/null
	@make build
	@bash -c 'while true; do \
		PATH="$(PWD)/dist:$$PATH" proton-drive-sync start --no-daemon & \
		PID=$$!; \
		watchman-wait . -m 1 -p "src/**/*"; \
		kill $$PID 2>/dev/null; \
		sleep 1; \
		kill -9 $$PID 2>/dev/null; \
		wait $$PID 2>/dev/null; \
		make build; \
	done'

# Run pre-commit checks on all files
pre-commit:
	bun eslint --fix 'src/**/*.ts'
	bun prettier --write 'src/**/*.ts' '*.json' '*.md'

# Publish to npm
publish:
	bun run build
	bun publish

# Clean build artifacts
clean:
	rm -rf dist

# Open Drizzle Studio to inspect the database
db-inspect:
	bun drizzle-kit studio
