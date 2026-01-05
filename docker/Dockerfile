# syntax=docker/dockerfile:1

# =============================================================================
# Stage 1: Build the application
# =============================================================================
FROM oven/bun:1-debian AS builder

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source and build
COPY . .
RUN bun run build:css && bun run build:bin

# =============================================================================
# Stage 2: Runtime
# =============================================================================
FROM debian:bookworm-slim AS runtime

ARG TARGETARCH

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    jq \
    unzip \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

# Install Watchman (architecture-specific)
# x64: Download latest from GitHub releases
# arm64: Use pre-built .deb from project assets
RUN set -eux; \
    if [ "$TARGETARCH" = "amd64" ]; then \
        version=$(curl -s https://api.github.com/repos/facebook/watchman/releases/latest | jq -r '.tag_name'); \
        echo "Installing Watchman ${version} for amd64..."; \
        curl -fSL "https://github.com/facebook/watchman/releases/download/${version}/watchman-${version}-linux.zip" -o /tmp/watchman.zip; \
        unzip /tmp/watchman.zip -d /opt; \
        mv /opt/watchman-* /opt/watchman; \
        printf '#!/bin/bash\nexport LD_LIBRARY_PATH=/opt/watchman/lib:$LD_LIBRARY_PATH\nexec /opt/watchman/bin/watchman "$@"\n' > /usr/local/bin/watchman; \
        chmod +x /usr/local/bin/watchman; \
        rm /tmp/watchman.zip; \
    elif [ "$TARGETARCH" = "arm64" ]; then \
        echo "Installing Watchman for arm64..."; \
        curl -fSL "https://damianbbitflipper.github.io/proton-drive-sync/watchman_2025.12.29.00_arm64.deb" -o /tmp/watchman.deb; \
        dpkg -i /tmp/watchman.deb; \
        rm /tmp/watchman.deb; \
    else \
        echo "Unsupported architecture: $TARGETARCH"; \
        exit 1; \
    fi

# Copy built binary from builder stage
COPY --from=builder /app/dist/proton-drive-sync /usr/local/bin/

# Copy entrypoint script
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Set up XDG directories for config and state
ENV XDG_CONFIG_HOME=/config
ENV XDG_STATE_HOME=/state

# Dashboard port
EXPOSE 4242

# Health check: verify both sync process and dashboard are responsive
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD proton-drive-sync status > /dev/null 2>&1 && \
        wget -q --spider http://localhost:4242/ || exit 1

ENTRYPOINT ["/entrypoint.sh"]
