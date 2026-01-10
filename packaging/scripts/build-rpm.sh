#!/bin/bash
# Build and sign an .rpm package
# Required environment variables:
#   VERSION - Package version (e.g., "0.2.1" or "0.2.1-beta.1")
#   ARCH - Architecture: "x86_64" or "aarch64"
#   BINARY_PATH - Path to the binary to package
#   GPG_PASSPHRASE - Passphrase for GPG signing
#
# Optional environment variables:
#   PACKAGE_NAME - Package name (default: "proton-drive-sync")
#
# Outputs:
#   ${PACKAGE_NAME}-*.${ARCH}.rpm in current directory

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

# Parse version for RPM (handles pre-release versions like "0.2.1-beta.1")
if [[ "${VERSION}" == *-* ]]; then
	RPM_VERSION="${VERSION%%-*}"
	RPM_RELEASE="0.${VERSION#*-}"
	RPM_RELEASE="${RPM_RELEASE//-/.}"
else
	RPM_VERSION="${VERSION}"
	RPM_RELEASE="1"
fi

echo "Building .rpm package: ${PACKAGE_NAME}-${RPM_VERSION}-${RPM_RELEASE}.${ARCH}.rpm"

# Create rpmbuild directory structure
mkdir -p rpmbuild/{BUILD,RPMS,SOURCES,SPECS,SRPMS}

# Copy binary and spec file
cp "${BINARY_PATH}" rpmbuild/SOURCES/proton-drive-sync
cp "${PACKAGING_DIR}/rpm/proton-drive-sync.spec" rpmbuild/SPECS/

# Build the package
rpmbuild --define "_topdir $(pwd)/rpmbuild" \
	--define "_name ${PACKAGE_NAME}" \
	--define "_version ${RPM_VERSION}" \
	--define "_release ${RPM_RELEASE}" \
	--target "${ARCH}" \
	-bb rpmbuild/SPECS/proton-drive-sync.spec

# Disable TTY for GPG in CI environment
export GPG_TTY=""

# Sign the package
RPM_FILE=$(find rpmbuild/RPMS/${ARCH}/ -name "*.rpm" | head -1)
echo "Signing ${RPM_FILE}..."
rpmsign --define "_gpg_name 832B348E3FF2D4F3" \
	--define "__gpg_sign_cmd %{__gpg} gpg --batch --yes --no-tty --pinentry-mode loopback --passphrase-fd 3 -u '%{_gpg_name}' -sbo %{__signature_filename} %{__plaintext_filename}" \
	--addsign "${RPM_FILE}" 3<<<"${GPG_PASSPHRASE}"

# Import public key to RPM keyring for verification
gpg --armor --export 832B348E3FF2D4F3 | rpm --import /dev/stdin

# Verify signature
rpm -K "${RPM_FILE}"

# Copy to current directory
cp "${RPM_FILE}" ./

echo "Successfully built and signed: $(basename "${RPM_FILE}")"
