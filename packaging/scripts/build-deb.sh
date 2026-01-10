#!/bin/bash
# Build and sign a .deb package
# Required environment variables:
#   VERSION - Package version (e.g., "0.2.1")
#   ARCH - Architecture: "amd64" or "arm64"
#   BINARY_PATH - Path to the binary to package
#   GPG_PASSPHRASE - Passphrase for GPG signing
#
# Optional environment variables:
#   PACKAGE_NAME - Package name (default: "proton-drive-sync")
#
# Outputs:
#   ${PACKAGE_NAME}_${VERSION}_${ARCH}.deb in current directory

set -euo pipefail

# Validate required environment variables
for var in VERSION ARCH BINARY_PATH GPG_PASSPHRASE; do
	if [[ -z "${!var:-}" ]]; then
		echo "Error: ${var} environment variable is required"
		exit 1
	fi
done

PACKAGE_NAME="${PACKAGE_NAME:-proton-drive-sync}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGING_DIR="$(dirname "${SCRIPT_DIR}")"
PKG_DIR="deb-${ARCH}"
DEB_FILE="${PACKAGE_NAME}_${VERSION}_${ARCH}.deb"

echo "Building .deb package: ${DEB_FILE}"

# Create package directory structure
mkdir -p "${PKG_DIR}/DEBIAN" "${PKG_DIR}/usr/bin"

# Copy binary
cp "${BINARY_PATH}" "${PKG_DIR}/usr/bin/proton-drive-sync"
chmod 755 "${PKG_DIR}/usr/bin/proton-drive-sync"

# Generate control file from template
sed -e "s/{{VERSION}}/${VERSION}/" \
	-e "s/{{ARCH}}/${ARCH}/" \
	-e "s/{{PACKAGE_NAME}}/${PACKAGE_NAME}/" \
	"${PACKAGING_DIR}/deb/control" >"${PKG_DIR}/DEBIAN/control"

# Copy maintainer scripts
cp "${PACKAGING_DIR}/deb/postrm" "${PKG_DIR}/DEBIAN/"
chmod 755 "${PKG_DIR}/DEBIAN/postrm"

# Build the package
dpkg-deb --build "${PKG_DIR}" "${DEB_FILE}"

# Sign the package
echo "Signing ${DEB_FILE}..."
echo "${GPG_PASSPHRASE}" | dpkg-sig --sign builder \
	-g "--batch --pinentry-mode loopback --passphrase-fd 0" \
	"${DEB_FILE}"

# Verify signature
dpkg-sig --verify "${DEB_FILE}"

echo "Successfully built and signed: ${DEB_FILE}"
