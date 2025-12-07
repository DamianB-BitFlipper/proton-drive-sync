.PHONY: install build dev pre-commit publish clean

# Install dependencies
install:
	pnpm install

# Build the project
build:
	pnpm build

# Run directly with tsx (no build required)
dev:
	pnpm tsx src/index.ts $(ARGS)

# Run pre-commit checks on all files
pre-commit:
	pnpm eslint --fix 'src/**/*.ts'
	pnpm prettier --write 'src/**/*.ts' '*.json' '*.md'

# Publish to npm
publish:
	pnpm build
	pnpm publish

# Clean build artifacts
clean:
	rm -rf dist
